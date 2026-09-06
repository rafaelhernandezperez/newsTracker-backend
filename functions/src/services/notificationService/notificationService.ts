import admin from "firebase-admin";
import { getDeviceTokensForUsers, pruneInvalidTokens } from "../firebaseService/firebaseService";

export type NewsNotification = {
  ticker: string;
  title: string;
  /** Optional short, presentation-ready title; used by polished showcase pushes. */
  displayTitle?: string;
  body: string;
  link: string;
  newsId: string;
  sentiment?: string;
};

const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

/** sendEachForMulticast accepts at most 500 tokens per call. */
const FCM_MULTICAST_LIMIT = 500;

/**
 * Push one news item to every device of the given subscribers. Tokens FCM
 * reports as invalid or expired are pruned from Firestore.
 */
export async function notifySubscribers(
  subscribers: string[],
  notification: NewsNotification
): Promise<{ sent: number; failed: number }> {
  const tokens = await getDeviceTokensForUsers(subscribers);
  if (tokens.length === 0) {
    return { sent: 0, failed: 0 };
  }

  // Web pushes stay data-only: a notification payload is auto-rendered by the
  // Firebase SDK and would then ALSO reach our service worker's showNotification
  // handler, producing two browser notifications. Let the worker render exactly
  // one and own the validated click target.
  const payload = {
    data: {
      ticker: notification.ticker,
      title: (
        notification.displayTitle ?? `${notification.ticker}: ${notification.title}`
      ).slice(0, 240),
      body: notification.body.slice(0, 480),
      newsId: notification.newsId,
      link: notification.link,
      sentiment: notification.sentiment ?? "NEUTRO",
    },
    android: { priority: "high" as const },
    apns: { payload: { aps: { contentAvailable: true, sound: "default" } } },
    webpush: { headers: { Urgency: "high" } },
  };

  let sent = 0;
  let failed = 0;
  const invalidTokens: string[] = [];

  for (let offset = 0; offset < tokens.length; offset += FCM_MULTICAST_LIMIT) {
    const chunk = tokens.slice(offset, offset + FCM_MULTICAST_LIMIT);
    const message: admin.messaging.MulticastMessage = { tokens: chunk, ...payload };
    const response = await admin.messaging().sendEachForMulticast(message);

    sent += response.successCount;
    failed += response.failureCount;
    response.responses.forEach((resp, i) => {
      if (!resp.success && resp.error && INVALID_TOKEN_CODES.has(resp.error.code)) {
        invalidTokens.push(chunk[i]);
      }
    });
  }

  if (invalidTokens.length > 0) {
    await pruneInvalidTokens(invalidTokens).catch((err) =>
      console.warn("[notificationService] token prune failed:", err)
    );
  }

  return { sent, failed };
}
