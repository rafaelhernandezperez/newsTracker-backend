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

// Cloud Functions terminates TLS at Google's front end and rewrites
// X-Forwarded-For, so the last proxy hop is trustworthy. Without this, req.ip
// is the load balancer for every caller and IP-based rate limiting collapses
// into one shared bucket.
app.set("trust proxy", 1);
// Never advertise Express (also stripped per-response in securityHeaders).
app.disable("x-powered-by");

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