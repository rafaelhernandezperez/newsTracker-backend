import type { NextFunction, Request, Response } from "express";
import type { DecodedIdToken } from "firebase-admin/auth";
import { auth } from "../services/firebaseService/firebaseService";
import { TtlCache } from "../services/newsService/cache";

type AuthenticatedRequest = Request & { user?: DecodedIdToken };

/**
 * Verifying only the signature leaves a revoked, disabled or deleted account
 * with full access until its token expires (1h). `checkRevoked` closes that but
 * costs an Identity Toolkit round trip per request, so successful checks are
 * cached for 5 minutes — 5 minutes of exposure instead of 60. Only successes
 * are cached: a revoked token fails closed and is never remembered.
 */
const REVOCATION_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bounded so a flood of distinct uids cannot grow this without limit. */
const REVOCATION_CACHE_MAX_UIDS = 5_000;

const recentlyChecked = new TtlCache<true>(
  REVOCATION_CACHE_TTL_MS,
  REVOCATION_CACHE_MAX_UIDS
);

/** uid of the caller authenticated by `requireAuth`, if any. */
export function getUid(req: Request): string | undefined {
  return (req as AuthenticatedRequest).user?.uid;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  // Routers re-apply this as a safety net; don't verify the same token twice.
  if (getUid(req)) {
    return next();
  }

  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    // Validates signature, issuer, audience and expiry against Google's cached
    // public keys — no network call in the warm case.
    const decoded = await auth.verifyIdToken(token);

    // Is this account still entitled to that token? Skipped while a recent
    // check for the same uid is still fresh.
    if (!recentlyChecked.get(decoded.uid)) {
      await auth.verifyIdToken(token, true);
      recentlyChecked.set(decoded.uid, true);
    }

    (req as AuthenticatedRequest).user = decoded;
    return next();
  } catch {
    // Covers bad signature, expiry, revocation and disabled accounts alike:
    // distinguishing them would confirm account states to an attacker.
    return res.status(401).json({ ok: false, message: "Invalid token" });
  }
}
