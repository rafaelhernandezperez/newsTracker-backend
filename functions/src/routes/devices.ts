// Device (FCM token) registration for push notifications.
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
  validateDeviceToken,
  validatePlatform,
  validatePushTestId,
} from "../middleware/validation";
import {
  getPushTestNews,
  registerDeviceToken,
  removeDeviceToken,
} from "../services/firebaseService/firebaseService";
import { generatePushNotificationCopy } from "../services/aiService/aiService";
import { notifySubscribers } from "../services/notificationService/notificationService";

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

// POST /devices/test  { language?: "en" | "es"; testId: string }
// Sends a real stored company story through the same FCM path as live alerts.
// It prefers the caller's watchlist and targets only their registered devices.
router.post("/test", async (req: Request, res: Response) => {
  try {
    const uid = getUid(req);
    if (!uid) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const testId = validatePushTestId(req.body?.testId);
    if (!testId.ok) {
      return res.status(400).json({ ok: false, message: testId.message });
    }

    const targetLanguage = req.body?.language === "es" ? "es" : "en";
    const selection = await getPushTestNews(uid);
    if (!selection) {
      return res.status(409).json({
        ok: false,
        code: "no-news",
        message: "No stored news is available for a realistic test notification",
      });
    }

    const { story, companyName } = selection;
    const ticker = String(story.ticker ?? "").trim().toUpperCase() || "MARKET";
    const articleTitle = String(story.title ?? "").trim();
    const sourceSummary = String(story.summary ?? "").trim();
    const copy = await generatePushNotificationCopy({
      ticker,
      companyName,
      title: articleTitle,
      summary: sourceSummary,
      source: story.source,
      targetLanguage,
    });
    if (!copy) {
      return res.status(503).json({
        ok: false,
        code: "copy-unavailable",
        message: "A credible notification summary could not be generated",
      });
    }

    const result = await notifySubscribers([uid], {
      ticker,
      title: articleTitle,
      displayTitle: copy.title,
      body: copy.body,
      link: String(story.link ?? "").trim() || `/portfolio/${ticker}`,
      // Keep this prefix: the focused client uses it to acknowledge that the
      // exact FCM test reached the browser and to make the banner persistent.
      newsId: `push-test-${testId.value}`,
      sentiment: story.sentiment ?? "NEUTRO",
    });

    if (result.sent === 0) {
      return res.status(result.failed > 0 ? 502 : 409).json({
        ok: false,
        message:
          result.failed > 0
            ? "FCM rejected the test notification"
            : "No notification device is registered for this account",
        ...result,
      });
    }

    return res.json({
      ok: true,
      message: "Showcase-quality real-story notification sent",
      sample: {
        ticker,
        title: copy.title,
        body: copy.body,
        articleTitle,
        source: story.source,
      },
      ...result,
    });
  } catch (error) {
    console.error("[routes/devices] test push error:", error);
    return res.status(500).json({ ok: false, message: "Error sending test notification" });
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
