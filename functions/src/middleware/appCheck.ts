import type { NextFunction, Request, Response } from "express";
import { appCheck } from "../services/firebaseService/firebaseService";

/**
 * App Check attestation.
 *
 * `requireAuth` answers "who is this?". It does not answer "is this our app?" —
 * and it cannot, because sign-up is open: anyone can create an account in
 * seconds and then hold a perfectly valid ID token. That matters here because
 * /news spends real money per call. App Check closes the gap by requiring proof
 * (reCAPTCHA v3, via the Firebase SDK) that the request came from the deployed
 * Angular app rather than a script.
 *
 * Rollout is deliberately two-phase. Attestation depends on client SDK setup
 * that can silently fail for real users — an old cached bundle, a blocked
 * reCAPTCHA domain, a privacy extension — so enforcing it blind is a good way
 * to lock out your own users. With APP_CHECK_ENFORCED unset, failures are
 * counted and allowed through; watch the Firebase console's App Check metrics
 * until verified traffic is effectively all of it, then set the flag to "true"
 * and redeploy to fail closed.
 */

const APP_CHECK_HEADER = "x-firebase-appcheck";

function isEnforced(): boolean {
  return process.env.APP_CHECK_ENFORCED?.trim().toLowerCase() === "true";
}

/** At most one line per 10s, so a flood cannot become a log-bill amplifier. */
let nextLogAt = 0;
function warnOnce(reason: string): void {
  const now = Date.now();
  if (now < nextLogAt) return;
  nextLogAt = now + 10_000;
  // Log the reason, never the token: it is a bearer credential.
  console.warn(
    `[appCheck] unattested request (${reason}) — ` +
      `${isEnforced() ? "rejected" : "allowed, monitoring only"}`
  );
}

export async function verifyAppCheck(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  const token = req.header(APP_CHECK_HEADER);

  if (!token) {
    warnOnce("no token");
    if (isEnforced()) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
    return next();
  }

  try {
    await appCheck.verifyToken(token);
    return next();
  } catch {
    // Same generic 401 as a bad ID token: distinguishing "bad attestation" from
    // "bad identity" tells an attacker which half to work on.
    warnOnce("invalid token");
    if (isEnforced()) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
    return next();
  }
}
