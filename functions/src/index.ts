import express from "express";
import cors from "cors";
import { onRequest } from "firebase-functions/v2/https";

import newsRouter from "./routes/news.js";
import marketRouter from "./routes/market.js";
import tickersRouter from "./routes/tickers.js";
import watchlistRouter from "./routes/watchlist.js";
import devicesRouter from "./routes/devices.js";
import { requireAuth } from "./middleware/auth.js";

const app = express();

app.use(cors());
app.use(express.json());

// Every route requires a Firebase ID token. /news in particular triggers paid
// LLM calls, so leaving it public would let anyone spend the HF quota.
app.use("/news", requireAuth, newsRouter);
app.use("/market", requireAuth, marketRouter);
app.use("/tickers", requireAuth, tickersRouter);
app.use("/watchlist", watchlistRouter);
app.use("/devices", devicesRouter);

app.use((req: express.Request, res: express.Response) => {
  return res.status(404).json({ ok: false, message: "Not found" });
});

app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Express Error]", err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({ ok: false, message: "Internal server error" });
});

export const api = onRequest(
  {
    region: "europe-west1",
    // Caps runaway scale-out (and with it, external API + LLM spend).
    maxInstances: 5,
  },
  app
);

// Scheduled functions (Cloud Scheduler): 15-min news store + daily user digest.
export { trackNews, dailyDigest } from "./scheduler/index.js";

export default app;
