import admin from "firebase-admin";
import { getDeviceTokensForUsers, pruneInvalidTokens } from "../firebaseService/firebaseService";

export type NewsNotification = {
  ticker: string;
  title: string;
  body: string;
  link: string;
  newsId: string;
  sentiment?: string;
};

const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

/**
 * Push a single news item to every device of the given subscribers via FCM.
 * Invalid/expired tokens reported by FCM are pruned from Firestore.
 */
export async function notifySubscribers(
  subscribers: string[],
  notification: NewsNotification
): Promise<{ sent: number; failed: number }> {
  const tokens = await getDeviceTokensForUsers(subscribers);
  if (tokens.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const payload = {
    notification: {
      title: `${notification.ticker}: ${notification.title}`.slice(0, 240),
      body: notification.body.slice(0, 480),
    },
    data: {
      ticker: notification.ticker,
      newsId: notification.newsId,
      link: notification.link,
      sentiment: notification.sentiment ?? "NEUTRO",
    },
    android: { priority: "high" as const },
    apns: { payload: { aps: { sound: "default" } } },
  };

  // sendEachForMulticast accepts at most 500 tokens per call.
  let sent = 0;
  let failed = 0;
  const invalidTokens: string[] = [];
  for (let offset = 0; offset < tokens.length; offset += 500) {
    const chunk = tokens.slice(offset, offset + 500);
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
