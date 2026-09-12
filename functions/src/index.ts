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
import { verifyAppCheck } from "./middleware/appCheck.js";
import { corsOptions, securityHeaders } from "./middleware/security.js";
import { limits } from "./middleware/rateLimit.js";
import { hfToken } from "./config/secrets.js";

const app = express();

/**
 * Trusted X-Forwarded-For hops. Cloud Functions v2 APPENDS the real client IP,
 * so the rightmost entry is the honest one and 1 is correct here. Raise to 2 if
 * `req.ip` ever shows a Google address — the symptom is every caller collapsing
 * into a single rate-limit bucket.
 */
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS) || 1;
app.set("trust proxy", TRUST_PROXY_HOPS);
app.disable("x-powered-by");

// Firebase Hosting forwards the original `/api/...` while the Angular dev-server
// proxy strips it. Normalise both onto the paths the routers are mounted at.
app.use((req, _res, next) => {
  if (req.url === "/api") {
    req.url = "/";
  } else if (req.url.startsWith("/api/")) {
    req.url = req.url.slice("/api".length);
  }
  next();
});

app.use(securityHeaders);
app.use(cors(corsOptions));
// Every endpoint takes a small JSON object; the 100kb default is 1000x that.
app.use(express.json({ limit: "16kb" }));

// Backstop, mounted before auth so an unauthenticated flood is rejected without
// reaching token verification. Per-route limiters below add cost-aware tiers.
app.use(limits.global);

// Attestation runs before identity: "is this our app?" is cheaper to answer
// than "who is this?", and rejecting a scripted caller here saves the Identity
// Toolkit round trip. Monitoring-only until APP_CHECK_ENFORCED=true.
app.use(verifyAppCheck);

// /news triggers paid LLM calls, so no route is public. Auth is re-applied
// inside each router, so one can never be mounted without it by accident.
app.use("/news", requireAuth, limits.ai, newsRouter);
app.use("/market", requireAuth, limits.lookup, marketRouter);
app.use("/tickers", requireAuth, limits.lookup, tickersRouter);
app.use("/watchlist", requireAuth, limits.write, watchlistRouter);
app.use("/devices", requireAuth, limits.write, devicesRouter);
app.use("/preferences", requireAuth, limits.write, preferencesRouter);

app.use((_req: express.Request, res: express.Response) => {
  return res.status(404).json({ ok: false, message: "Not found" });
});

/** Generic, non-revealing text for the client-error statuses we pass through. */
const CLIENT_ERROR_MESSAGES: Record<number, string> = {
  400: "Malformed request body",
  413: "Request body too large",
  415: "Unsupported content type",
};

// Four declared parameters: Express detects error handlers by arity, so `_req`
// must stay even though it is unused.
app.use((
  err: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  console.error("[Express Error]", err);
  if (res.headersSent) {
    return next(err);
  }

  // Body-parser rejections carry their own 4xx status; reporting a caller's
  // mistake as 500 would bury real outages among routine bad input.
  const status =
    (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    // Never echo err.message: body-parser quotes fragments of the payload.
    return res.status(status).json({
      ok: false,
      message: CLIENT_ERROR_MESSAGES[status] ?? "Bad request",
    });
  }

  // Never surface `err`: stack traces leak internal paths and dependency versions.
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
