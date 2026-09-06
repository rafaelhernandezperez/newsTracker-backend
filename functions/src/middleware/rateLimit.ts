import type { NextFunction, Request, Response } from "express";
import { getUid } from "./auth";

/**
 * Fixed-window rate limiting, keyed by authenticated uid when available and by
 * client IP otherwise.
 *
 * Counters live in the instance's memory, so a caller spread across the 5
 * configured instances can reach at most 5x a limit. That bound is acceptable:
 * the point is to cap runaway cost and scripted abuse, not to meter billing.
 * Anything stricter needs a shared store, i.e. a write on every request.
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
 * uid for authenticated requests (it survives IP changes and is the identity
 * that actually spends quota), IP otherwise. `req.ip` is trustworthy only
 * because Google's front end rewrites X-Forwarded-For — see TRUST_PROXY_HOPS.
 */
function identify(req: Request): string {
  const uid = getUid(req);
  return uid ? `uid:${uid}` : `ip:${req.ip ?? "unknown"}`;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, name } = options;
  const windows = new Map<string, Window>();
  /** Earliest time a full sweep is allowed to run again. */
  let nextSweepAt = 0;
  /** Rate-limit our own logging, so a flood cannot also flood Cloud Logging. */
  let nextLogAt = 0;

  /**
   * Reclaim expired windows. O(tracked keys), so it must NOT run per request: a
   * distributed flood creates a key every time, and sweeping unconditionally at
   * capacity made those requests ~174x more expensive than a normal one.
   */
  function sweepExpired(now: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
    nextSweepAt = now + windowMs;
  }

  /**
   * Make room for one new key. Every window here shares one TTL, so Map
   * insertion order is expiry order and dropping from the front is O(1).
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
      // Cheap unconditional bound first; the sweep only reclaims memory and is
      // throttled to once per window.
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
      // At most one line per 10s, so a flood cannot become a log-bill amplifier.
      // Log the KIND of identity, never the identity: uids and IPs are personal
      // data, and logs outlive every rate window.
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
 * Tiers, tightest first. `ai` guards the only endpoints that spend real money,
 * so it sits far below what a human browsing the app can reach: a company page
 * costs one request, and repeat views are served from the enrichment cache.
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
