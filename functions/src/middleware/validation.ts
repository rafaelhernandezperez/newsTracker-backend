import type { NextFunction, Request, Response } from "express";

/**
 * Input validation for everything crossing the API boundary. Two jobs, kept
 * together so neither is forgotten:
 *
 *  1. Reject values that are not plausibly what the caller claims, bounding the
 *     work one request can buy (feed fetches, Yahoo lookups, LLM tokens).
 *  2. Guarantee anything used as a Firestore document id is a SINGLE path
 *     segment: `db.collection(c).doc(value)` splits `value` on "/", so an
 *     unvalidated id silently writes to a different depth of the tree.
 */

/** Firestore rejects these outright, or treats them as path traversal. */
const FIRESTORE_RESERVED = /^__.*__$/;

/**
 * A single Firestore path segment: no "/", not "." or "..", not reserved, and
 * within Firestore's 1500-byte id limit (bytes, not UTF-16 units).
 */
export function isSafeDocumentId(value: string): boolean {
  if (!value || value === "." || value === "..") return false;
  if (value.includes("/")) return false;
  if (FIRESTORE_RESERVED.test(value)) return false;
  return Buffer.byteLength(value, "utf8") <= 1500;
}

/**
 * Ticker symbols as the market data providers spell them: plain symbols (AAPL),
 * share classes (BRK.B), exchange suffixes (BBVA.MC), indices (^GSPC), FX pairs
 * (EURUSD=X) and hyphenated classes (RDS-A) — and nothing else, so a ticker can
 * never carry a path separator or an LLM instruction. The caret is anchored to
 * the front because that is the only place Yahoo uses it.
 */
const TICKER_PATTERN = /^\^?[A-Z0-9][A-Z0-9.=-]{0,14}$/;

const MAX_COMPANY_NAME_LENGTH = 120;
const MAX_SEARCH_QUERY_LENGTH = 64;
/** FCM registration tokens are ~140-400 chars; the ceiling is slack, not a spec. */
const MIN_DEVICE_TOKEN_LENGTH = 64;
const MAX_DEVICE_TOKEN_LENGTH = 4096;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]+$/;

/** Strip C0/C1 control characters, which no legitimate input here contains. */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

export function validateTicker(raw: unknown): Validated<string> {
  if (typeof raw !== "string") {
    return { ok: false, message: "ticker is required" };
  }
  // Deliberately NOT stripped of control characters: for a value this tightly
  // specified, deleting bytes would turn "AAPL\0evil" into a valid-looking
  // "AAPLEVIL" and hide the attempt. Free-text fields below are sanitized
  // instead, because there a stray character is usually a paste artifact.
  const ticker = raw.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker) || !isSafeDocumentId(ticker)) {
    return {
      ok: false,
      message: "ticker must be 1-15 characters using A-Z, 0-9, and . - ^ = only",
    };
  }
  return { ok: true, value: ticker };
}

export function validateCompanyName(raw: unknown): Validated<string | undefined> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string") {
    return { ok: false, message: "companyName must be a string" };
  }
  const name = stripControlChars(raw).trim();
  if (!name) return { ok: true, value: undefined };
  if (name.length > MAX_COMPANY_NAME_LENGTH) {
    return {
      ok: false,
      message: `companyName must be at most ${MAX_COMPANY_NAME_LENGTH} characters`,
    };
  }
  return { ok: true, value: name };
}

export function validateSearchQuery(raw: unknown): Validated<string> {
  if (typeof raw !== "string") {
    return { ok: false, message: "q must be a string" };
  }
  const query = stripControlChars(raw).trim();
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    return {
      ok: false,
      message: `q must be at most ${MAX_SEARCH_QUERY_LENGTH} characters`,
    };
  }
  return { ok: true, value: query };
}

export function validateDeviceToken(raw: unknown): Validated<string> {
  if (typeof raw !== "string") {
    return { ok: false, message: "token is required" };
  }
  const token = raw.trim();
  if (
    token.length < MIN_DEVICE_TOKEN_LENGTH ||
    token.length > MAX_DEVICE_TOKEN_LENGTH ||
    !DEVICE_TOKEN_PATTERN.test(token) ||
    !isSafeDocumentId(token)
  ) {
    return { ok: false, message: "token is not a valid device registration token" };
  }
  return { ok: true, value: token };
}

/** Platform is a display/diagnostic label, so restrict it to a known set. */
const ALLOWED_PLATFORMS = new Set(["web", "android", "ios"]);

export function validatePlatform(raw: unknown): Validated<string> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: "unknown" };
  }
  if (typeof raw !== "string") {
    return { ok: false, message: "platform must be a string" };
  }
  const platform = raw.trim().toLowerCase();
  if (!ALLOWED_PLATFORMS.has(platform)) {
    return { ok: false, message: "platform must be one of: web, android, ios" };
  }
  return { ok: true, value: platform };
}

/**
 * Coerce a query-string integer into [min, max], falling back for anything
 * absent or unparseable. These are display knobs, so a clamped default is
 * friendlier than a 400.
 */
export function clampInt(
  raw: unknown,
  { min, max, fallback }: { min: number; max: number; fallback: number }
): number {
  const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const ALLOWED_LANGUAGES = new Set(["en", "es"]);

export function validateLanguage(
  raw: unknown,
  fallback: "en" | "es"
): Validated<"en" | "es"> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: fallback };
  }
  if (typeof raw !== "string" || !ALLOWED_LANGUAGES.has(raw)) {
    return { ok: false, message: 'language must be "en" or "es"' };
  }
  return { ok: true, value: raw as "en" | "es" };
}

/** ISO-8601-ish date bound, rejecting anything Date cannot parse. */
export function validateDateInput(raw: unknown): Validated<string | undefined> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string" || raw.length > 40) {
    return { ok: false, message: "date must be an ISO-8601 string" };
  }
  if (!Number.isFinite(new Date(raw).getTime())) {
    return { ok: false, message: "date must be a valid ISO-8601 date" };
  }
  return { ok: true, value: raw };
}

/**
 * Validate `:ticker` once, at the edge, and hand the canonical form to handlers
 * via `res.locals.ticker` so no route re-derives it.
 */
export function requireValidTicker(
  req: Request,
  res: Response,
  next: NextFunction
): void | Response {
  const result = validateTicker(req.params.ticker);
  if (!result.ok) {
    return res.status(400).json({ ok: false, message: result.message });
  }
  res.locals.ticker = result.value;
  return next();
}
