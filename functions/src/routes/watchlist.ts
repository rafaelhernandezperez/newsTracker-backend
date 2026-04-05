import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
  addTickerToWatchlist,
  getUserWatchlist,
  removeTickerFromWatchlist,
} from "../services/firebaseService/firebaseService";

const router = Router();

router.use(requireAuth);

router.get("/", async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user?: { uid?: string } }).user;
    const uid = user?.uid;

    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const watchlist = await getUserWatchlist(uid);
    return res.json({ ok: true, count: watchlist.length, items: watchlist });
  } catch (error) {
    console.error("[routes/watchlist] GET error:", error);
    return res.status(500).json({ ok: false, message: "Error fetching watchlist" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user?: { uid?: string } }).user;
    const uid = user?.uid;

    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const ticker = typeof req.body?.ticker === "string" ? req.body.ticker.trim().toUpperCase() : "";
    const companyName = typeof req.body?.companyName === "string" ? req.body.companyName.trim() : undefined;

    if (!ticker) {
      return res.status(400).json({ ok: false, message: "ticker is required" });
    }

    await addTickerToWatchlist(uid, ticker, companyName);
    return res.status(201).json({ ok: true, ticker, message: "Ticker added" });
  } catch (error) {
    console.error("[routes/watchlist] POST error:", error);
    return res.status(500).json({ ok: false, message: "Error adding ticker" });
  }
});

router.delete("/:ticker", async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user?: { uid?: string } }).user;
    const uid = user?.uid;

    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const ticker = (req.params.ticker ?? "").trim().toUpperCase();
    if (!ticker) {
      return res.status(400).json({ ok: false, message: "ticker is required" });
    }

    await removeTickerFromWatchlist(uid, ticker);
    return res.json({ ok: true, ticker, message: "Ticker removed" });
  } catch (error) {
    console.error("[routes/watchlist] DELETE error:", error);
    return res.status(500).json({ ok: false, message: "Error removing ticker" });
  }
});

export default router;
