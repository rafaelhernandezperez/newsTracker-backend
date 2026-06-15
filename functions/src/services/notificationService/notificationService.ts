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

  const message: admin.messaging.MulticastMessage = {
    tokens,
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
    android: { priority: "high" },
    apns: { payload: { aps: { sound: "default" } } },
  };

  const response = await admin.messaging().sendEachForMulticast(message);

  const invalidTokens: string[] = [];
  response.responses.forEach((resp, i) => {
    if (!resp.success && resp.error && INVALID_TOKEN_CODES.has(resp.error.code)) {
      invalidTokens.push(tokens[i]);
    }
  });
  if (invalidTokens.length > 0) {
    await pruneInvalidTokens(invalidTokens).catch((err) =>
      console.warn("[notificationService] token prune failed:", err)
    );
  }

  return { sent: response.successCount, failed: response.failureCount };
}
