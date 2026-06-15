// Device (FCM token) registration for push notifications.
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
  registerDeviceToken,
  removeDeviceToken,
} from "../services/firebaseService/firebaseService";

const router = Router();

router.use(requireAuth);

function getUid(req: Request): string | undefined {
  return (req as Request & { user?: { uid?: string } }).user?.uid;
}

// POST /devices  { token, platform }
router.post("/", async (req: Request, res: Response) => {
  try {
    const uid = getUid(req);
    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const platform =
      typeof req.body?.platform === "string" ? req.body.platform.trim() : undefined;

    if (!token) {
      return res.status(400).json({ ok: false, message: "token is required" });
    }

    await registerDeviceToken(uid, token, platform);
    return res.status(201).json({ ok: true, message: "Device registered" });
  } catch (error) {
    console.error("[routes/devices] POST error:", error);
    return res.status(500).json({ ok: false, message: "Error registering device" });
  }
});

// DELETE /devices/:token
router.delete("/:token", async (req: Request, res: Response) => {
  try {
    const uid = getUid(req);
    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const token = (req.params.token ?? "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, message: "token is required" });
    }

    await removeDeviceToken(uid, token);
    return res.json({ ok: true, message: "Device removed" });
  } catch (error) {
    console.error("[routes/devices] DELETE error:", error);
    return res.status(500).json({ ok: false, message: "Error removing device" });
  }
});

export default router;
