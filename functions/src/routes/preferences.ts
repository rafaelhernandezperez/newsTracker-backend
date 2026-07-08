import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
  DEFAULT_ALERT_PREFS,
  getAlertPrefs,
  setAlertPrefs,
  type AlertPrefs,
} from "../services/firebaseService/firebaseService";

const router = Router();

router.use(requireAuth);

router.get("/alerts", async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user?: { uid?: string } }).user;
    const uid = user?.uid;

    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const prefs = await getAlertPrefs(uid);
    return res.json({ ok: true, prefs });
  } catch (error) {
    console.error("[routes/preferences] GET error:", error);
    return res.status(500).json({ ok: false, message: "Error fetching preferences" });
  }
});

router.put("/alerts", async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user?: { uid?: string } }).user;
    const uid = user?.uid;

    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const body = (req.body ?? {}) as Partial<Record<keyof AlertPrefs, unknown>>;
    // Missing/malformed fields fall back to defaults, so a partial PUT can't
    // silently disable channels the client didn't mention.
    const prefs: AlertPrefs = {
      priceMoves: typeof body.priceMoves === "boolean" ? body.priceMoves : DEFAULT_ALERT_PREFS.priceMoves,
      highImpact: typeof body.highImpact === "boolean" ? body.highImpact : DEFAULT_ALERT_PREFS.highImpact,
      dailyDigest: typeof body.dailyDigest === "boolean" ? body.dailyDigest : DEFAULT_ALERT_PREFS.dailyDigest,
    };

    await setAlertPrefs(uid, prefs);
    return res.json({ ok: true, prefs });
  } catch (error) {
    console.error("[routes/preferences] PUT error:", error);
    return res.status(500).json({ ok: false, message: "Error saving preferences" });
  }
});

export default router;
