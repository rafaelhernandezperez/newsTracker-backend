// Device (FCM token) registration for push notifications.
import { Router, type Request, type Response } from "express";
import { getUid, requireAuth } from "../middleware/auth";
import { validateDeviceToken, validatePlatform } from "../middleware/validation";
import {
  registerDeviceToken,
  removeDeviceToken,
} from "../services/firebaseService/firebaseService";

const router = Router();

router.use(requireAuth);

// POST /devices  { token, platform }
router.post("/", async (req: Request, res: Response) => {
  try {
    const uid = getUid(req);
    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    // The token becomes a Firestore document id, so it must be validated as a
    // single path segment before it reaches the service layer.
    const token = validateDeviceToken(req.body?.token);
    if (!token.ok) {
      return res.status(400).json({ ok: false, message: token.message });
    }

    const platform = validatePlatform(req.body?.platform);
    if (!platform.ok) {
      return res.status(400).json({ ok: false, message: platform.message });
    }

    await registerDeviceToken(uid, token.value, platform.value);
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

    const token = validateDeviceToken(req.params.token);
    if (!token.ok) {
      return res.status(400).json({ ok: false, message: token.message });
    }

    await removeDeviceToken(uid, token.value);
    return res.json({ ok: true, message: "Device removed" });
  } catch (error) {
    console.error("[routes/devices] DELETE error:", error);
    return res.status(500).json({ ok: false, message: "Error removing device" });
  }
});

export default router;
