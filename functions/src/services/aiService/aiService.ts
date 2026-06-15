import axios from 'axios';

const HUGGING_FACE_CHAT_URL = 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_MODEL = 'mistralai/Mixtral-8x7B-Instruct-v0.1:fastest';
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

async function runPrompt(prompt: string, maxTokens: number): Promise<string> {
  const response = await axios.post<HuggingFaceChatResponse>(
    HUGGING_FACE_CHAT_URL,
    {
      model: process.env.HF_MODEL?.trim() || DEFAULT_MODEL,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    },
    {
      headers: {
        Authorization: `Bearer ${getHuggingFaceToken()}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const content = response.data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Hugging Face returned an empty AI response');
  }

  return content;
}

export async function summarize(text: string): Promise<string> {
  return runPrompt(
    `Resume en una frase en español esta noticia financiera. Solo la frase, sin explicaciones: ${text}`,
    80
  );
}

export type NewsEnrichment = {
  summary: string;
  sentiment: Sentiment;
  importance: Importance;
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
 * Summarize, classify market IMPORTANCE, and classify SENTIMENT in a SINGLE LLM
 * call. Used by the scheduler (many items per run) and the on-demand news API,
 * so folding three signals into one call matters for latency and rate limits.
 * Returns a safe fallback if parsing fails.
 *
 * IMPORTANCIA drives the size of the chart marker on the frontend; SENTIMIENTO
 * drives its color.
 */
export async function enrichNews(text: string, fallbackSummary = ''): Promise<NewsEnrichment> {
  try {
    const raw = await runPrompt(
      'Eres un analista financiero. Analiza la noticia y devuelve SOLO un objeto JSON valido ' +
        'con esta forma exacta, sin texto adicional:\n' +
        '{"summary": "<resumen en una frase en español>", ' +
        '"importancia": "MUY_IMPORTANTE|IMPORTANTE|NEUTRO|POCO_RELEVANTE", ' +
        '"sentimiento": "POSITIVO|NEGATIVO|NEUTRO"}\n' +
        'La "importancia" mide el impacto potencial de la noticia en el mercado o en la ' +
        'cotizacion de la empresa. El "sentimiento" mide el tono para el inversor. Noticia: ' +
        text,
      200
    );

    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as {
        summary?: string;
        importancia?: string;
        sentimiento?: string;
        // Tolerate English keys in case the model ignores the schema.
        importance?: string;
        sentiment?: string;
      };
      return {
        summary: parsed.summary?.trim() || fallbackSummary,
        importance: coerceEnum(
          parsed.importancia ?? parsed.importance,
          IMPORTANCE_VALUES,
          'NEUTRO'
        ),
        sentiment: coerceEnum(
          parsed.sentimiento ?? parsed.sentiment,
          SENTIMENT_VALUES,
          'NEUTRO'
        ),
      };
    }
  } catch (error) {
    console.warn('[aiService] enrichNews failed, using fallback:', error);
  }

  return { summary: fallbackSummary, sentiment: 'NEUTRO', importance: 'NEUTRO' };
}

export async function analyzeSentiment(text: string): Promise<Sentiment> {
  const result = (
    await runPrompt(
      `Responde SOLO con una palabra: POSITIVO, NEGATIVO o NEUTRO según el tono de esta noticia financiera: ${text}`,
      8
    )
  ).toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ]/g, '');

  if (SENTIMENT_VALUES.includes(result as Sentiment)) {
    return result as Sentiment;
  }

  return 'NEUTRO';
}
