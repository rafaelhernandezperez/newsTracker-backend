import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";

/**
 * Origins allowed to call the API from a browser.
 *
 * `cors()` with no arguments answers every preflight with
 * `Access-Control-Allow-Origin: *`, which lets any page on the internet script
 * this API using a token it has obtained. Bearer tokens are not sent
 * automatically the way cookies are, so this was not CSRF — but a wildcard
 * removes the browser's origin check for free, and there is no reason to
 * donate it.
 *
 * Set ALLOWED_ORIGINS (comma-separated) to override for a new deploy target.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  "https://financialnewstracker.web.app",
  "https://financialnewstracker.firebaseapp.com",
  // Angular dev server (`ng serve`) proxies /api to the local dev-server.
  "http://localhost:4200",
  "http://127.0.0.1:4200",
];

function allowedOrigins(): string[] {
  const configured = process.env.ALLOWED_ORIGINS?.trim();
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header: same-origin fetches, curl, and the mobile/native case.
    // These are not browser cross-origin requests, so there is nothing to gate.
    if (!origin) return callback(null, true);

    if (allowedOrigins().includes(origin)) {
      return callback(null, true);
    }
    // Reject by declining the origin rather than erroring: the browser then
    // blocks the response, and the caller gets a clean CORS failure instead of
    // a 500 that looks like a server bug.
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  // The API is stateless and token-authenticated; it never reads cookies.
  credentials: false,
  maxAge: 3600,
};

/**
 * Response headers for a JSON-only API.
 *
 * There is no HTML surface here, so this is deliberately narrow: stop content
 * sniffing, refuse framing, keep referrers off third parties, and forbid
 * cross-origin embedding of responses. A full CSP belongs on the Angular app's
 * hosting config, not on an endpoint that only ever returns application/json.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  // Advertising the framework hands attackers a free version-specific CVE hunt.
  res.removeHeader("X-Powered-By");
  next();
}