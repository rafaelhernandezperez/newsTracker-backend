import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";

/**
 * Origins allowed to call the API from a browser. A bare `cors()` answers every
 * preflight with `*`, which lets any page on the internet script this API with
 * a token it has obtained. Set ALLOWED_ORIGINS (comma-separated) to override.
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
    // No Origin header: same-origin fetches, curl and native clients. Not
    // browser cross-origin requests, so there is nothing to gate.
    if (!origin) return callback(null, true);

    // Decline rather than error, so the caller gets a clean CORS failure
    // instead of a 500 that looks like a server bug.
    return callback(null, allowedOrigins().includes(origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  // X-Firebase-AppCheck must be listed or the browser's preflight rejects
  // every attested request before it is ever sent.
  allowedHeaders: ["Authorization", "Content-Type", "X-Firebase-AppCheck"],
  // The API is stateless and token-authenticated; it never reads cookies.
  credentials: false,
  maxAge: 3600,
};

/**
 * Response headers for a JSON-only API: no content sniffing, no framing, no
 * referrers, no cross-origin embedding. A full CSP belongs on the Angular app's
 * hosting config, not on an endpoint that only returns application/json.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  // Advertising the framework hands attackers a free version-specific CVE hunt.
  res.removeHeader("X-Powered-By");
  next();
}
