import type { NextFunction, Request, Response } from "express";

/**
 * Fixed-window rate limiting, keyed by authenticated uid when available and by
 * client IP otherwise.
 *
 * Scope: the counters live in the instance's memory. Cloud Functions may run up
 * to `maxInstances` copies of this app (5, see index.ts), so a determined
 * caller spread across instances can reach at most 5x a configured limit. That
 * is an acceptable bound here — the point is to cap runaway cost and scripted
 * abuse, not to meter billing precisely. Anything stricter would need a shared
 * store (Firestore/Redis), which would add a write to every single request.
 *
 * Windows are swept lazily on write, so an idle instance holds no timers and a
 * burst of unique keys cannot grow the map without bound (see MAX_KEYS).
 */

type Window = {
  count: number;
  /** Epoch ms at which this window expires and the count resets. */
  resetAt: number;
};

export type RateLimitOptions = {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests permitted per key within a window. */
  max: number;
  /** Label used in logs so a tripped limiter is identifiable. */
  name: string;
};

/**
 * Hard ceiling on tracked keys per limiter. Reached only under a distributed
 * flood; evicting the oldest entries degrades to "some callers get a fresh
 * window" rather than letting an attacker exhaust the instance's memory.
 */
const MAX_KEYS = 10_000;

/**
 * Identify the caller: uid for authenticated requests (survives IP changes and
 * is the identity that actually spends quota), IP otherwise.
 *
 * `req.ip` is trusted only because Cloud Functions terminates the connection at
 * Google's front end, which rewrites X-Forwarded-For. Do not reuse this keying
 * behind an untrusted proxy without pinning `trust proxy` accordingly.
 */
function identify(req: Request): string {
  const uid = (req as Request & { user?: { uid?: string } }).user?.uid;
  if (uid) return `uid:${uid}`;
  return `ip:${req.ip ?? "unknown"}`;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, name } = options;
  const windows = new Map<string, Window>();
  /** Earliest time a full sweep is allowed to run again. */
  let nextSweepAt = 0;
  /** Rate-limit our own logging, so a flood cannot also flood Cloud Logging. */
  let nextLogAt = 0;

  /**
   * Reclaim expired windows. This is O(number of tracked keys), so it must NOT
   * run per request: a distributed flood creates a new key every time, and an
   * unconditional sweep at capacity made each of those requests ~174x more
   * expensive than a normal one — turning the limiter itself into the cheapest
   * way to burn our CPU. It is therefore capped at once per window.
   */
  function sweepExpired(now: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
    nextSweepAt = now + windowMs;
  }

  /**
   * Make room for one new key. Every window in this limiter has the same TTL,
   * so Map insertion order is also expiry order: the front entry is always the
   * oldest and the next to expire. Dropping from the front is therefore O(1)
   * per eviction and needs no scan.
   */
  function evictOldest(): void {
    while (windows.size >= MAX_KEYS) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
  }

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void | Response {
    const now = Date.now();
    const key = `${name}|${identify(req)}`;

    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      // Cheap, unconditional bound first; the full sweep is only an
      // optimisation to reclaim memory and is throttled to once per window.
      if (windows.size >= MAX_KEYS) {
        if (now >= nextSweepAt) sweepExpired(now);
        evictOldest();
      }
      window = { count: 0, resetAt: now + windowMs };
      windows.set(key, window);
    }

    window.count += 1;

    const remaining = Math.max(0, max - window.count);
    const resetSeconds = Math.ceil((window.resetAt - now) / 1000);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (window.count > max) {
      res.setHeader("Retry-After", String(resetSeconds));
      // Log at most once every 10s per limiter. Logging every rejection means a
      // flood also becomes a log-volume (and log-bill) amplifier. Log the KIND
      // of identity, never the identity: uids and IPs are personal data, and
      // logs are retained far longer than any rate window.
      if (now >= nextLogAt) {
        nextLogAt = now + 10_000;
        const identityKind = key.includes("|uid:") ? "an authenticated user" : "an IP";
        console.warn(`[rateLimit] ${name} limit exceeded for ${identityKind}`);
      }
      return res.status(429).json({
        ok: false,
        message: "Too many requests. Please slow down and try again shortly.",
      });
    }

    return next();
  };
}

/**
 * Tiers, tightest first. `ai` guards the only endpoints that spend real money
 * (LLM enrichment), so it is deliberately far below what a human browsing the
 * app can reach: opening a company page costs one request, and repeat views
 * are served from the enrichment cache.
 */
export const limits = {
  /** Whole-API backstop, applied before auth so unauthenticated floods are cheap. */
  global: rateLimit({ name: "global", windowMs: 60_000, max: 120 }),
  /** LLM-backed news enrichment. */
  ai: rateLimit({ name: "ai", windowMs: 60_000, max: 20 }),
  /** Outbound third-party lookups (Yahoo search/quotes) — no LLM spend. */
  lookup: rateLimit({ name: "lookup", windowMs: 60_000, max: 60 }),
  /** Firestore reads/writes owned by the caller. */
  write: rateLimit({ name: "write", windowMs: 60_000, max: 40 }),
};