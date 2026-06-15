import { onSchedule } from "firebase-functions/v2/scheduler";
import { runTrackingCycle } from "../services/trackerService/trackerService";
import { runDailyDigestCycle } from "../services/digestService/digestService";

/**
 * News tracker. Runs every 15 minutes to keep the enriched news store + history
 * fresh (this also backs the chart). It no longer pushes per-item notifications:
 * user-facing alerts are delivered once a day by the digest below.
 */
export const trackNews = onSchedule(
  {
    schedule: "every 15 minutes",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Avoid overlapping runs piling up if a cycle runs long.
    retryCount: 0,
  },
  async () => {
    await runTrackingCycle();
  }
);

/**
 * Daily digest. Once a day at 12:00 (Europe/Madrid) it sends each user a single
 * notification with the most relevant news across all the tickers they follow.
 */
export const dailyDigest = onSchedule(
  {
    schedule: "0 12 * * *",
    timeZone: "Europe/Madrid",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "512MiB",
    retryCount: 0,
  },
  async () => {
    await runDailyDigestCycle();
  }
);
