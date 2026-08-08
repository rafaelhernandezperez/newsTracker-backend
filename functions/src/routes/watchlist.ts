import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { validateCompanyName, validateTicker } from "../middleware/validation";
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

    // The ticker becomes a Firestore document id, so it must be validated as a
    // single path segment before it reaches the service layer.
    const ticker = validateTicker(req.body?.ticker);
    if (!ticker.ok) {
      return res.status(400).json({ ok: false, message: ticker.message });
    }

    const companyName = validateCompanyName(req.body?.companyName);
    if (!companyName.ok) {
      return res.status(400).json({ ok: false, message: companyName.message });
    }

    await addTickerToWatchlist(uid, ticker.value, companyName.value);
    return res.status(201).json({ ok: true, ticker: ticker.value, message: "Ticker added" });
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

    const ticker = validateTicker(req.params.ticker);
    if (!ticker.ok) {
      return res.status(400).json({ ok: false, message: ticker.message });
    }

    await removeTickerFromWatchlist(uid, ticker.value);
    return res.json({ ok: true, ticker: ticker.value, message: "Ticker removed" });
  } catch (error) {
    console.error("[routes/watchlist] DELETE error:", error);
    return res.status(500).json({ ok: false, message: "Error removing ticker" });
  }
});

export default router;
