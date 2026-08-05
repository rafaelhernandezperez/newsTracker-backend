import axios, { AxiosError } from 'axios';
<<<<<<< HEAD
import { appendFile } from 'node:fs/promises';
import path from 'node:path';

const HUGGING_FACE_CHAT_URL = 'https://router.huggingface.co/v1/chat/completions';
// Interactive pages should not remain blocked for the HTTP client's default
// 45 seconds before trying the fallback model.
const AI_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Primary model: Qwen 3.5 4B via Featherless AI.
 * Override with HF_MODEL. If the primary is unavailable (404/403 for the model,
 * provider outage), the fallback is tried before giving up.
 */
const DEFAULT_MODEL = 'Qwen/Qwen3.5-4B:featherless-ai';
const FALLBACK_MODEL = 'meta-llama/Llama-3.1-8B-Instruct';
=======

const HUGGING_FACE_CHAT_URL = 'https://router.huggingface.co/v1/chat/completions';

/**
 * Primary model: Llama 3.1 8B Instruct.
 * Override with HF_MODEL. If the primary is unavailable (404/403 for the model,
 * provider outage), the fallback is tried before giving up.
 */
const DEFAULT_MODEL = 'meta-llama/Llama-3.1-8B-Instruct';
const FALLBACK_MODEL = 'Qwen/Qwen3.5-4B';
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf

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

function aiDebugLogsEnabled(): boolean {
  return process.env.AI_DEBUG_LOGS?.trim().toLowerCase() === 'true';
}

<<<<<<< HEAD
async function writeAiEvaluationLog(entry: {
  aiUsed: string;
  rawMessage: unknown;
  results: string;
}): Promise<void> {
  const logPath = process.env.AI_EVALUATION_LOG_PATH?.trim() ||
    path.resolve(process.cwd(), 'ai-evaluation.log');

  try {
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    // Logging must never make an otherwise successful model call fail.
    console.warn(`[aiService] could not write AI evaluation log at ${logPath}`, error);
  }
}

=======
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
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

<<<<<<< HEAD
=======
/**
 * One-line description of a failed model call: HTTP status plus whatever the
 * provider said. The raw axios error is thousands of lines of socket state, so
 * without this the actual cause (bad token, gated model, rate limit, TLS) never
 * makes it into the logs.
 */
function describeError(error: unknown): string {
  const axiosError = error as AxiosError<unknown>;
  const status = axiosError?.response?.status;
  const parts = [status ? `HTTP ${status}` : (axiosError?.code ?? 'no response')];

  const provider = providerMessage(axiosError?.response?.data);
  parts.push(provider ?? axiosError?.message ?? String(error));

  return parts.join(' — ');
}

/** Pull the human-readable message out of the provider's error body. */
function providerMessage(body: unknown): string | undefined {
  if (typeof body === 'string') {
    return body.slice(0, 300);
  }

  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') {
    return error.slice(0, 300);
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message.slice(0, 300);
    }
  }

  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' ? message.slice(0, 300) : undefined;
}

>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
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
<<<<<<< HEAD
  const requestBody: Record<string, unknown> = {
=======
  const requestBody = {
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
    model,
    messages: [
      {
        role: 'system',
        content:
<<<<<<< HEAD
          'You are a senior financial analyst and translator. Follow the requested output ' +
          'language for each item, regardless of the source language. Return valid JSON only.',
=======
          'Eres un analista financiero senior. Clasificas noticias para inversores ' +
          'particulares. Respondes SIEMPRE con JSON valido y nada mas.',
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.1,
    stream: false,
  };

<<<<<<< HEAD
  // Qwen 3.5 reasons by default. For short translation/classification work,
  // thinking can consume the entire output allowance before JSON is emitted,
  // adding latency and forcing a fallback. Featherless forwards this standard
  // Qwen chat-template option to produce the answer directly.
  if (model.startsWith('Qwen/Qwen3.5-')) {
    requestBody.chat_template_kwargs = { enable_thinking: false };
=======
  if (aiDebugLogsEnabled()) {
    // Intentionally logs the exact model input for temporary evaluation runs.
    // Authentication headers/tokens are never included.
    console.log('[aiService][debug] REQUEST', JSON.stringify({
      endpoint: HUGGING_FACE_CHAT_URL,
      body: requestBody,
    }));
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
  }

  const response = await axios.post<HuggingFaceChatResponse>(
    HUGGING_FACE_CHAT_URL,
    requestBody,
    {
      headers: {
        Authorization: `Bearer ${getHuggingFaceToken()}`,
        'Content-Type': 'application/json',
      },
<<<<<<< HEAD
      timeout: AI_REQUEST_TIMEOUT_MS,
=======
      timeout: 45000,
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
    }
  );

  const content = response.data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Hugging Face returned an empty AI response');
  }

  if (aiDebugLogsEnabled()) {
<<<<<<< HEAD
    // Keep both the input and output raw for evaluation purposes.
    await writeAiEvaluationLog({
      aiUsed: model,
      rawMessage: requestBody.messages,
      results: content,
    });
=======
    // Keep this raw: do not parse, normalize, or extract JSON before logging.
    console.log('[aiService][debug] RAW_RESPONSE', JSON.stringify({
      model,
      content,
    }));
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
  }

  return content;
}

/**
 * Run a prompt against the configured model with one retry on transient errors,
 * then against the fallback model before giving up.
 */
<<<<<<< HEAD
type ModelResponse = { content: string; model: string };

function configuredModels(): string[] {
  const primary = process.env.HF_MODEL?.trim() || DEFAULT_MODEL;
  return primary === FALLBACK_MODEL ? [primary] : [primary, FALLBACK_MODEL];
}

async function runPrompt(
  prompt: string,
  maxTokens: number,
  models = configuredModels()
): Promise<ModelResponse> {
=======
async function runPrompt(prompt: string, maxTokens: number): Promise<string> {
  const primary = process.env.HF_MODEL?.trim() || DEFAULT_MODEL;
  const models = primary === FALLBACK_MODEL ? [primary] : [primary, FALLBACK_MODEL];
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf

  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
<<<<<<< HEAD
        return { content: await callModel(model, prompt, maxTokens), model };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) break; // model/auth problem: skip to fallback model
        // Back off only when another attempt will actually run. The old loop
        // slept after its final failure before moving to the fallback model.
        if (attempt < 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
=======
        return await callModel(model, prompt, maxTokens);
      } catch (error) {
        lastError = error;
        console.warn(
          `[aiService] ${model} attempt ${attempt + 1} failed: ${describeError(error)}`
        );
        if (!isRetryable(error)) break; // model/auth problem: skip to fallback model
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
      }
    }
  }

  throw lastError;
}

export type NewsEnrichment = {
  localizedTitle: string;
  summary: string;
  sentiment: Sentiment;
  importance: Importance;
};

export type EnrichmentInput = {
  /** Headline + snippet handed to the model. */
  text: string;
  /** Language in which the generated summary must be written. */
  targetLanguage?: 'en' | 'es';
  /** Used when the model produces no usable summary for this item. */
  fallbackSummary?: string;
};

/** Canonicalize separators and accents in a classification returned by an LLM. */
export function normalizeClassificationLabel(raw: string | undefined): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Normalize a raw model string to one of the allowed enum values. */
function coerceEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  // Models do not always preserve the exact separator requested by the
  // prompt. For example, "MUY IMPORTANTE" and "POCO-RELEVANTE" are valid
  // semantic answers, but the previous implementation removed the separator
  // entirely (MUYIMPORTANTE) and silently downgraded them to NEUTRO.
  const cleaned = normalizeClassificationLabel(raw);
  return (allowed as readonly string[]).includes(cleaned) ? (cleaned as T) : fallback;
}

/**
 * Explicit rubric so classifications are consistent run-to-run instead of
 * depending on the model's own notion of "important". IMPORTANCIA drives the
 * chart marker SIZE on the frontend; SENTIMIENTO drives its COLOR.
 */
const CLASSIFICATION_RUBRIC =
<<<<<<< HEAD
  'For every news item return:\n' +
  '- "summary": one informative sentence of 25 to 45 words, written ONLY in that item’s ' +
  'TARGET OUTPUT LANGUAGE. Explain the main event and, where supported by the input, include ' +
  'a useful figure, context, or investor consequence. Do not merely repeat the headline, invent ' +
  'facts, or mix languages.\n' +
  '- "localizedTitle": a faithful translation of the headline, written ONLY in that item’s ' +
  'TARGET OUTPUT LANGUAGE. Preserve names, tickers, figures, and meaning. Add no information. ' +
  'Remove exchange annotations such as (NYSE:IBM) or (NASDAQ:AMZN).\n' +
  '- "importancia", based on potential impact on the company share price:\n' +
  '  * MUY_IMPORTANTE: earnings, mergers/acquisitions/takeovers, profit warnings, guidance ' +
  'changes, material regulatory or court decisions, CEO/CFO changes, capital raises, dividend ' +
  'changes, or bankruptcy.\n' +
  '  * IMPORTANTE: analyst rating/target changes, significant contracts or products, sharp ' +
  'share-price moves, or concrete strategic changes.\n' +
  '  * NEUTRO: general coverage, passing mentions, or analysis without a new event.\n' +
  '  * POCO_RELEVANTE: sponsorship, CSR, branding, generic lists, or promotional content.\n' +
  '- "sentimiento": expected shareholder effect: POSITIVO, NEGATIVO, or NEUTRO.\n';

const SPANISH_LANGUAGE_MARKERS = new Set([
  'acciones', 'accionistas', 'anuncia', 'beneficios', 'cae', 'de', 'del', 'el', 'empresa',
  'en', 'está', 'ganancias', 'ingresos', 'inversores', 'la', 'las', 'los', 'para', 'por',
  'que', 'resultados', 'sube', 'una', 'y',
]);

const ENGLISH_LANGUAGE_MARKERS = new Set([
  'and', 'announces', 'company', 'earnings', 'for', 'from', 'in', 'investors', 'is', 'of',
  'on', 'revenue', 'shares', 'stock', 'the', 'to', 'with',
]);

/**
 * Catch clear model failures where it ignored the requested translation
 * language. This deliberately requires a strong signal so company names and
 * short finance terms cannot cause a valid translation to be rejected.
 */
function isClearlyWrongLanguage(
  text: string,
  targetLanguage: 'en' | 'es',
  minimumWrongLanguageScore = 3
): boolean {
  const words = text
    .toLocaleLowerCase()
    .match(/[\p{L}]+/gu) ?? [];
  const spanishScore = words.reduce(
    (score, word) => score + (SPANISH_LANGUAGE_MARKERS.has(word) ? 1 : 0),
    0
  );
  const englishScore = words.reduce(
    (score, word) => score + (ENGLISH_LANGUAGE_MARKERS.has(word) ? 1 : 0),
    0
  );

  return targetLanguage === 'en'
    ? spanishScore >= minimumWrongLanguageScore && spanishScore >= englishScore + 2
    : englishScore >= minimumWrongLanguageScore && englishScore >= spanishScore + 2;
=======
  'Para cada noticia devuelve:\n' +
  '- "summary": una frase informativa de entre 25 y 45 palabras en el idioma indicado. ' +
  'Debe explicar el hecho principal y, cuando el texto lo permita, añadir una cifra, contexto ' +
  'o consecuencia relevante para el inversor. No copies, traduzcas ni reformules simplemente ' +
  'el titular. No añadas datos que no estén en la noticia y no mezcles idiomas.\n' +
  '- "localizedTitle": traduccion fiel del titular al idioma indicado. Conserva nombres propios, ' +
  'tickers, cifras y significado; no añadas informacion. Omite anotaciones de bolsa entre ' +
  'parentesis como (NYSE:IBM) o (NASDAQ:AMZN).\n' +
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
  return {
    localizedTitle: '',
    summary: fallbackSummary,
    sentiment: 'NEUTRO',
    importance: 'NEUTRO',
  };
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
}

function parseEnrichment(
  parsed: {
    summary?: string;
    localizedTitle?: string;
    importancia?: string;
    sentimiento?: string;
    // Tolerate English keys in case the model ignores the schema.
    importance?: string;
    sentiment?: string;
  },
  fallbackSummary: string
): NewsEnrichment {
  return {
    localizedTitle: parsed.localizedTitle?.trim() || '',
    summary: parsed.summary?.trim() || fallbackSummary,
    importance: coerceEnum(parsed.importancia ?? parsed.importance, IMPORTANCE_VALUES, 'NEUTRO'),
    sentiment: coerceEnum(parsed.sentimiento ?? parsed.sentiment, SENTIMENT_VALUES, 'NEUTRO'),
  };
}

// How many news items to classify per LLM call. Keeps calls per request low
// (40 items = 5 calls) without the response growing past max_tokens.
const BATCH_SIZE = 8;
<<<<<<< HEAD
// Long chart ranges can contain several batches. Run a few concurrently so a
// 30/40-item request does not pay the model latency four or five times in
// sequence, while keeping provider pressure bounded.
const BATCH_CONCURRENCY = 3;
=======

// Token budget per item in a batch. A localized title plus a 25-45 word summary
// in Spanish runs longer than in English; too small a budget truncates the JSON
// array mid-answer, which used to discard the whole batch (no translated titles,
// no classification) rather than just the tail.
const MAX_TOKENS_PER_ITEM = 230;
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf

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
<<<<<<< HEAD
  const chunks: EnrichmentInput[][] = [];

  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    chunks.push(items.slice(offset, offset + BATCH_SIZE));
  }

  for (let offset = 0; offset < chunks.length; offset += BATCH_CONCURRENCY) {
    const wave = await Promise.all(
      chunks.slice(offset, offset + BATCH_CONCURRENCY).map((chunk) => enrichChunk(chunk))
    );
    results.push(...wave.flat());
  }

  return results;
}

function parseChunkResponse(
  raw: string,
  chunk: EnrichmentInput[]
): Array<NewsEnrichment | null> | null {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return null;

  const parsed = JSON.parse(match[0]) as Array<{
    id?: number;
    summary?: string;
    localizedTitle?: string;
    importancia?: string;
    sentimiento?: string;
    importance?: string;
    sentiment?: string;
  }>;

  if (!Array.isArray(parsed)) return null;

  return chunk.map((item, i) => {
    const entry = parsed.find((candidate) => candidate.id === i + 1) ?? parsed[i];
    // A skipped item is not a valid neutral classification: caching it would
    // leave localizedTitle empty and leak the raw source headline.
    if (!entry) return null;

    const enrichment = parseEnrichment(entry, item.fallbackSummary ?? '');
    const targetLanguage = item.targetLanguage === 'es' ? 'es' : 'en';
    if (
      !enrichment.localizedTitle ||
      !enrichment.summary ||
      isClearlyWrongLanguage(enrichment.localizedTitle, targetLanguage, 2) ||
      isClearlyWrongLanguage(enrichment.summary, targetLanguage)
    ) {
      console.warn(
        `[aiService] rejected incomplete or wrong-language ${targetLanguage} enrichment`
      );
      return null;
    }
    return enrichment;
  });
}

async function enrichChunk(chunk: EnrichmentInput[]): Promise<Array<NewsEnrichment | null>> {
  const numbered = chunk
    .map((item, i) => {
      const language = item.targetLanguage === 'es' ? 'SPANISH' : 'ENGLISH';
      return (
        `${i + 1}. [TARGET OUTPUT LANGUAGE: ${language}] ` +
        `[SOURCE TEXT: ${item.text.replace(/\s+/g, ' ').slice(0, 600)}]`
      );
    })
    .join('\n');

  const targetLanguages = new Set(
    chunk.map((item) => (item.targetLanguage === 'es' ? 'SPANISH' : 'ENGLISH'))
  );
  const languageDirective = targetLanguages.size === 1
    ? `MANDATORY: Write every localizedTitle and summary ONLY in ${[...targetLanguages][0]}. ` +
      'Translate source text that is in another language.\n'
    : 'MANDATORY: Obey each item’s TARGET OUTPUT LANGUAGE independently. Translate as needed.\n';

  try {
    const prompt =
      'Analyze and localize these financial news items.\n' +
        languageDirective +
        CLASSIFICATION_RUBRIC +
        'Return ONLY a JSON array with one object per item, in the SAME order, ' +
        'using this exact shape:\n' +
        '[{"id": 1, "localizedTitle": "...", "summary": "...", ' +
        '"importancia": "...", "sentimiento": "..."}, ...]\n\n' +
        'News items:\n' +
        numbered +
        '\n\nFINAL LANGUAGE CHECK: localizedTitle and summary must use each item’s TARGET OUTPUT LANGUAGE.';
    const maxTokens = 160 * chunk.length;
    const response = await runPrompt(prompt, maxTokens);
    const primaryResults = parseChunkResponse(response.content, chunk);

    if (
      primaryResults &&
      (primaryResults.every((result) => result !== null) || response.model === FALLBACK_MODEL)
    ) {
      return primaryResults;
    }

    if (response.model !== FALLBACK_MODEL) {
      // HTTP fallbacks alone are insufficient: a model can return malformed
      // JSON or valid JSON in the wrong language. Retry invalid entries using
      // Llama, while retaining any valid Qwen results.
      const fallbackResponse = await runPrompt(prompt, maxTokens, [FALLBACK_MODEL]);
      const fallbackResults = parseChunkResponse(fallbackResponse.content, chunk);
      if (fallbackResults) {
        return primaryResults
          ? primaryResults.map((result, index) => result ?? fallbackResults[index])
          : fallbackResults;
      }
    }
    console.warn('[aiService] enrichChunk: response contained no JSON array');
  } catch (error) {
    console.warn('[aiService] enrichChunk failed:', error);
  }

  // Signal failure so callers skip caching/persisting and retry later.
  return chunk.map(() => null);
}

=======

  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    const chunk = items.slice(offset, offset + BATCH_SIZE);
    results.push(...(await enrichChunk(chunk)));
  }

  return results;
}

async function enrichChunk(chunk: EnrichmentInput[]): Promise<Array<NewsEnrichment | null>> {
  const numbered = chunk
    .map((item, i) => {
      const language = item.targetLanguage === 'es' ? 'español' : 'inglés';
      return `${i + 1}. [idioma: ${language}] ${item.text.replace(/\s+/g, ' ').slice(0, 600)}`;
    })
    .join('\n');

  let raw: string;
  try {
    raw = await runPrompt(
      'Analiza estas noticias financieras.\n' +
        CLASSIFICATION_RUBRIC +
        'Devuelve SOLO un array JSON con un objeto por noticia, en el MISMO orden, ' +
        'con esta forma exacta:\n' +
        '[{"id": 1, "localizedTitle": "...", "summary": "...", ' +
        '"importancia": "...", "sentimiento": "..."}, ...]\n\n' +
        'Noticias:\n' +
        numbered,
      MAX_TOKENS_PER_ITEM * chunk.length
    );
  } catch (error) {
    // Transport/auth/model failure: every attempt and both models are already
    // exhausted, and splitting the batch would only repeat it. Signal failure so
    // callers skip caching and a later request retries.
    console.warn(
      `[aiService] enrichChunk: model call failed for ${chunk.length} item(s) — ` +
        describeError(error)
    );
    return chunk.map(() => null);
  }

  const parsed = parseEnrichmentArray(raw);
  if (parsed) {
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

  // The model answered, but the JSON was unusable — typically truncated at
  // max_tokens. Halve the batch and retry: a single bad response used to cost
  // every item in it its translation and classification. Recursion bottoms out
  // at one item, so the worst case loses only that item.
  if (chunk.length > 1) {
    const middle = Math.ceil(chunk.length / 2);
    console.warn(
      `[aiService] enrichChunk: unusable response for ${chunk.length} items, splitting`
    );
    const [first, second] = await Promise.all([
      enrichChunk(chunk.slice(0, middle)),
      enrichChunk(chunk.slice(middle)),
    ]);
    return [...first, ...second];
  }

  console.warn('[aiService] enrichChunk: unusable response for a single item');
  return chunk.map(() => null);
}

type RawEnrichmentEntry = {
  id?: number;
  summary?: string;
  localizedTitle?: string;
  importancia?: string;
  sentimiento?: string;
  // Tolerate English keys in case the model ignores the schema.
  importance?: string;
  sentiment?: string;
};

/**
 * The JSON array out of a model answer, or null when it isn't usable. An empty
 * array counts as unusable: caching a NEUTRO with no translated title for every
 * item in the batch is worse than retrying.
 */
function parseEnrichmentArray(raw: string): RawEnrichmentEntry[] | null {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(match[0]);
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as RawEnrichmentEntry[])
      : null;
  } catch {
    return null;
  }
}

>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
/**
 * Summarize, classify market IMPORTANCE, and classify SENTIMENT for a single
 * news item (one LLM call). Returns null when enrichment failed.
 */
export async function enrichNews(
  text: string,
  fallbackSummary = '',
  targetLanguage: 'en' | 'es' = 'en'
): Promise<NewsEnrichment | null> {
  const [result] = await enrichNewsBatch([{ text, fallbackSummary, targetLanguage }]);
  return result ?? null;
}
