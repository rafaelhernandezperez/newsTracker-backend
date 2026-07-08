import axios, { AxiosError } from 'axios';

const HUGGING_FACE_CHAT_URL = 'https://router.huggingface.co/v1/chat/completions';

/**
 * Primary model: Llama 3.3 70B Instruct — strong instruction-following and
 * reliable JSON output, widely provisioned across HF inference providers.
 * Override with HF_MODEL. If the primary is unavailable (404/403 for the model,
 * provider outage), the fallback is tried before giving up.
 */
const DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';
const FALLBACK_MODEL = 'Qwen/Qwen2.5-72B-Instruct';

const SENTIMENT_VALUES = ['POSITIVO', 'NEGATIVO', 'NEUTRO'] as const;
const IMPORTANCE_VALUES = [
  'MUY_IMPORTANTE',
  'IMPORTANTE',
  'NEUTRO',
  'POCO_RELEVANTE',
] as const;

type Sentiment = typeof SENTIMENT_VALUES[number];
type Importance = typeof IMPORTANCE_VALUES[number];

type HuggingFaceChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

function getHuggingFaceToken(): string {
  const token = process.env.HF_TOKEN?.trim() || process.env.HUGGINGFACE_API_KEY?.trim();
  if (!token) {
    throw new Error('Missing HF_TOKEN or HUGGINGFACE_API_KEY environment variable');
  }

  return token;
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_NETWORK',
]);

function isRetryable(error: unknown): boolean {
  const axiosError = error as AxiosError;
  const status = axiosError?.response?.status;
  if (status !== undefined) {
    // Retry on rate limits and provider hiccups only.
    return status === 429 || status >= 500;
  }
  // No HTTP status: retry known transient network failures, but not local
  // errors (missing token, JSON bugs) — those fail identically every attempt.
  return RETRYABLE_NETWORK_CODES.has(axiosError?.code ?? '');
}

async function callModel(model: string, prompt: string, maxTokens: number): Promise<string> {
  const response = await axios.post<HuggingFaceChatResponse>(
    HUGGING_FACE_CHAT_URL,
    {
      model,
      messages: [
        {
          role: 'system',
          content:
            'Eres un analista financiero senior. Clasificas noticias para inversores ' +
            'particulares. Respondes SIEMPRE con JSON valido y nada mas.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
      stream: false,
    },
    {
      headers: {
        Authorization: `Bearer ${getHuggingFaceToken()}`,
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    }
  );

  const content = response.data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Hugging Face returned an empty AI response');
  }

  return content;
}

/**
 * Run a prompt against the configured model with one retry on transient errors,
 * then against the fallback model before giving up.
 */
async function runPrompt(prompt: string, maxTokens: number): Promise<string> {
  const primary = process.env.HF_MODEL?.trim() || DEFAULT_MODEL;
  const models = primary === FALLBACK_MODEL ? [primary] : [primary, FALLBACK_MODEL];

  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callModel(model, prompt, maxTokens);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) break; // model/auth problem: skip to fallback model
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

export type NewsEnrichment = {
  summary: string;
  sentiment: Sentiment;
  importance: Importance;
};

export type EnrichmentInput = {
  /** Headline + snippet handed to the model. */
  text: string;
  /** Used when the model produces no usable summary for this item. */
  fallbackSummary?: string;
};

/** Normalize a raw model string to one of the allowed enum values. */
function coerceEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  const cleaned = (raw ?? '').toUpperCase().replace(/[^A-Z_ÁÉÍÓÚÑ]/g, '');
  return (allowed as readonly string[]).includes(cleaned) ? (cleaned as T) : fallback;
}

/**
 * Explicit rubric so classifications are consistent run-to-run instead of
 * depending on the model's own notion of "important". IMPORTANCIA drives the
 * chart marker SIZE on the frontend; SENTIMIENTO drives its COLOR.
 */
const CLASSIFICATION_RUBRIC =
  'Para cada noticia devuelve:\n' +
  '- "summary": resumen de UNA frase en español (max 30 palabras).\n' +
  '- "importancia", segun el impacto potencial en la cotizacion de la empresa:\n' +
  '  * MUY_IMPORTANTE: resultados trimestrales/anuales, fusiones/adquisiciones/OPA, ' +
  'profit warning, cambio de guidance, sancion o fallo regulatorio/judicial relevante, ' +
  'cambio de CEO/CFO, ampliacion de capital, recorte o subida de dividendo, quiebra.\n' +
  '  * IMPORTANTE: mejora/rebaja de recomendacion o precio objetivo de analistas, ' +
  'contrato o producto significativo, movimiento brusco de la cotizacion, cambios ' +
  'estrategicos concretos.\n' +
  '  * NEUTRO: cobertura general, la empresa aparece junto a otras, analisis sin novedad.\n' +
  '  * POCO_RELEVANTE: patrocinios, RSC, marca, listas genericas, contenido promocional.\n' +
  '- "sentimiento": efecto esperado para el accionista: POSITIVO, NEGATIVO o NEUTRO.\n';

function neutralEnrichment(fallbackSummary = ''): NewsEnrichment {
  return { summary: fallbackSummary, sentiment: 'NEUTRO', importance: 'NEUTRO' };
}

function parseEnrichment(
  parsed: {
    summary?: string;
    importancia?: string;
    sentimiento?: string;
    // Tolerate English keys in case the model ignores the schema.
    importance?: string;
    sentiment?: string;
  },
  fallbackSummary: string
): NewsEnrichment {
  return {
    summary: parsed.summary?.trim() || fallbackSummary,
    importance: coerceEnum(parsed.importancia ?? parsed.importance, IMPORTANCE_VALUES, 'NEUTRO'),
    sentiment: coerceEnum(parsed.sentimiento ?? parsed.sentiment, SENTIMENT_VALUES, 'NEUTRO'),
  };
}

// How many news items to classify per LLM call. Keeps calls per request low
// (40 items = 5 calls) without the response growing past max_tokens.
const BATCH_SIZE = 8;

/**
 * Classify a batch of news items (summary + importance + sentiment) using ONE
 * LLM call per BATCH_SIZE items. Returns one entry per input, in order; items
 * in a failed chunk come back as null so callers can distinguish "the model
 * said NEUTRO" from "enrichment failed" — failed items must not be cached or
 * persisted as if classified, or they would never be retried.
 */
export async function enrichNewsBatch(
  items: EnrichmentInput[]
): Promise<Array<NewsEnrichment | null>> {
  const results: Array<NewsEnrichment | null> = [];

  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    const chunk = items.slice(offset, offset + BATCH_SIZE);
    results.push(...(await enrichChunk(chunk)));
  }

  return results;
}

async function enrichChunk(chunk: EnrichmentInput[]): Promise<Array<NewsEnrichment | null>> {
  const numbered = chunk
    .map((item, i) => `${i + 1}. ${item.text.replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n');

  try {
    const raw = await runPrompt(
      'Analiza estas noticias financieras.\n' +
        CLASSIFICATION_RUBRIC +
        'Devuelve SOLO un array JSON con un objeto por noticia, en el MISMO orden, ' +
        'con esta forma exacta:\n' +
        '[{"id": 1, "summary": "...", "importancia": "...", "sentimiento": "..."}, ...]\n\n' +
        'Noticias:\n' +
        numbered,
      160 * chunk.length
    );

    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Array<{
        id?: number;
        summary?: string;
        importancia?: string;
        sentimiento?: string;
        importance?: string;
        sentiment?: string;
      }>;

      if (Array.isArray(parsed)) {
        return chunk.map((item, i) => {
          // Prefer matching by the echoed id; fall back to position. A missing
          // entry means the model answered but skipped this item — treat its
          // classification as genuinely neutral rather than failed.
          const entry = parsed.find((p) => p.id === i + 1) ?? parsed[i];
          return entry
            ? parseEnrichment(entry, item.fallbackSummary ?? '')
            : neutralEnrichment(item.fallbackSummary);
        });
      }
    }
    console.warn('[aiService] enrichChunk: response contained no JSON array');
  } catch (error) {
    console.warn('[aiService] enrichChunk failed:', error);
  }

  // Signal failure so callers skip caching/persisting and retry later.
  return chunk.map(() => null);
}

/**
 * Summarize, classify market IMPORTANCE, and classify SENTIMENT for a single
 * news item (one LLM call). Returns null when enrichment failed.
 */
export async function enrichNews(
  text: string,
  fallbackSummary = ''
): Promise<NewsEnrichment | null> {
  const [result] = await enrichNewsBatch([{ text, fallbackSummary }]);
  return result ?? null;
}
