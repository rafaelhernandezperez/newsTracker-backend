import { Router, type Request, type Response } from "express";
import { getUid, requireAuth } from "../middleware/auth";
import {
  coerceAlertPrefs,
  getAlertPrefs,
  setAlertPrefs,
} from "../services/firebaseService/firebaseService";

const router = Router();

router.use(requireAuth);

router.get("/alerts", async (req: Request, res: Response) => {
  try {
    const uid = getUid(req);
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
    const uid = getUid(req);
    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    // Missing/malformed fields fall back to defaults, so a partial PUT can't
    // silently disable channels the client didn't mention.
    const prefs = coerceAlertPrefs(req.body);

    await setAlertPrefs(uid, prefs);
    return res.json({ ok: true, prefs });
  } catch (error) {
    console.error("[routes/preferences] PUT error:", error);
    return res.status(500).json({ ok: false, message: "Error saving preferences" });
  }
});

export default router;
