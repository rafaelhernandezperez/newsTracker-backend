import express from "express";
import cors from "cors";
import { onRequest } from "firebase-functions/v2/https";

import newsRouter from "./routes/news.js";
import marketRouter from "./routes/market.js";
import tickersRouter from "./routes/tickers.js";
import watchlistRouter from "./routes/watchlist.js";
import devicesRouter from "./routes/devices.js";
import preferencesRouter from "./routes/preferences.js";
import { requireAuth } from "./middleware/auth.js";
import { corsOptions, securityHeaders } from "./middleware/security.js";
import { limits } from "./middleware/rateLimit.js";
import { hfToken } from "./config/secrets.js";

const app = express();

/**
 * How many X-Forwarded-For hops to treat as trusted infrastructure.
 *
 * Express resolves `req.ip` to the Nth XFF entry counting from the RIGHT. On
 * Cloud Functions v2 (Cloud Run) Google's front end APPENDS the real client IP,
 * so the rightmost entry is the trustworthy one and N = 1 is correct. A client
 * that sends its own X-Forwarded-For only ever prepends to the list, so a
 * spoofed value cannot displace the appended one — IP rate-limit buckets stay
 * honest.
 *
 * This is the one piece of rate limiting that depends on platform behaviour, so
 * it is overridable. If `req.ip` ever shows a Google address rather than real
 * client addresses, every caller collapses into one bucket: raise this to 2.
 * Verify once after deploying with:
 *   gcloud functions logs read api --gen2 --region europe-west1
 * The cost-critical limits are keyed on uid from a verified Firebase JWT, which
 * no header can influence, so this setting is not what protects the LLM budget.
 */
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS) || 1;
app.set("trust proxy", TRUST_PROXY_HOPS);
// Never advertise Express (also stripped per-response in securityHeaders).
app.disable("x-powered-by");

/**
 * Accept requests with or without the `/api` prefix.
 *
 * The frontend always calls `/api/...`. In development the Angular dev-server
 * proxy rewrites that away, so this app sees `/news/...`. Firebase Hosting
 * rewrites do NOT strip anything — the function receives the original
 * `/api/news/...` — so without this every production call would 404 against
 * routers mounted at `/news`, `/market`, and so on.
 *
 * Normalising here (rather than re-mounting every router under both prefixes)
 * keeps one set of routes and one place where the difference is explained.
 */
app.use((req, _res, nextHandler) => {
  if (req.url === "/api") {
    req.url = "/";
  } else if (req.url.startsWith("/api/")) {
    req.url = req.url.slice("/api".length);
  }
  nextHandler();
});

app.use(securityHeaders);
app.use(cors(corsOptions));
// Every endpoint takes a small JSON object; the default 100kb ceiling is 3
// orders of magnitude more than any of them need.
app.use(express.json({ limit: "16kb" }));

// Backstop limiter, mounted before auth so an unauthenticated flood is rejected
// without ever reaching token verification (which costs a network round trip on
// a cold key cache). Per-route limiters below add tighter, cost-aware tiers.
app.use(limits.global);

// Every route requires a Firebase ID token. /news in particular triggers paid
// LLM calls, so leaving it public would let anyone spend the HF quota. Auth is
// also re-applied inside each router, so a router can never be mounted without
// it by accident.
app.use("/news", requireAuth, limits.ai, newsRouter);
app.use("/market", requireAuth, limits.lookup, marketRouter);
app.use("/tickers", requireAuth, limits.lookup, tickersRouter);
app.use("/watchlist", requireAuth, limits.write, watchlistRouter);
app.use("/devices", requireAuth, limits.write, devicesRouter);
app.use("/preferences", requireAuth, limits.write, preferencesRouter);

app.use((req: express.Request, res: express.Response) => {
  return res.status(404).json({ ok: false, message: "Not found" });
});

/** Generic, non-revealing text for the client-error statuses we pass through. */
const CLIENT_ERROR_MESSAGES: Record<number, string> = {
  400: "Malformed request body",
  413: "Request body too large",
  415: "Unsupported content type",
};

app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Express Error]", err);
  if (res.headersSent) {
    return next(err);
  }

  // Body-parser rejections (malformed JSON, oversized payload, bad charset)
  // carry their own 4xx status. Honour it: reporting a caller's mistake as 500
  // both misleads the client and buries real outages among routine bad input.
  const status = (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return res.status(status).json({
      ok: false,
      // Use our own text, never err.message — body-parser echoes fragments of
      // the offending payload, and this response is attacker-visible.
      message: CLIENT_ERROR_MESSAGES[status] ?? "Bad request",
    });
  }

  // Never surface `err` itself: stack traces and upstream provider messages
  // leak internal paths, dependency versions, and sometimes credentials.
  return res.status(500).json({ ok: false, message: "Internal server error" });
});

export const api = onRequest(
  {
    region: "europe-west1",
    // Caps runaway scale-out (and with it, external API + LLM spend).
    maxInstances: 5,
    secrets: [hfToken],
  },
  app
);

// Scheduled functions (Cloud Scheduler): 15-min news store + daily user digest.
export { trackNews, dailyDigest } from "./scheduler/index.js";

export default app;