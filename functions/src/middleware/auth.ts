import type { NextFunction, Request, Response } from "express";
import { auth } from "../services/firebaseService/firebaseService";
import { TtlCache } from "../services/newsService/cache";

/**
 * How long a uid stays "known good" after a successful revocation check.
 *
 * Firebase ID tokens live for an hour. Verifying only the signature means a
 * disabled or deleted account — or one whose sessions were revoked after a
 * compromise — keeps full API access until that hour runs out.
 *
 * Passing `checkRevoked` closes that, but it is not free: it makes the Admin
 * SDK fetch the user record to compare `tokensValidAfterTime`, i.e. an Identity
 * Toolkit round trip on EVERY request, plus the quota that implies.
 *
 * Caching the positive result for five minutes keeps the common path local
 * while cutting the worst-case exposure from 60 minutes to 5 — a 12x reduction
 * for roughly 1/N of the lookups. Only successes are cached: a revoked token
 * fails closed and is never remembered.
 */
const REVOCATION_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bounded so a flood of distinct uids cannot grow this without limit. */
const REVOCATION_CACHE_MAX_UIDS = 5_000;

const recentlyChecked = new TtlCache<true>(
  REVOCATION_CACHE_TTL_MS,
  REVOCATION_CACHE_MAX_UIDS
);

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    // First pass validates signature, issuer, audience and expiry locally
    // against Google's cached public keys — no network call in the warm case.
    const decoded = await auth.verifyIdToken(token);

    // Second pass asks whether this account is still entitled to that token.
    // Skipped while a recent check for the same uid is still fresh.
    if (!recentlyChecked.get(decoded.uid)) {
      await auth.verifyIdToken(token, true);
      recentlyChecked.set(decoded.uid, true);
    }

    (req as Request & { user?: unknown }).user = decoded;
    return next();
  } catch (error) {
    // Covers bad signature, expiry, AND revocation/disabled account. The client
    // is told only that the token is unusable: distinguishing "expired" from
    // "revoked" from "disabled" would confirm account states to an attacker.
    return res.status(401).json({ ok: false, message: "Invalid token" });
  }
}