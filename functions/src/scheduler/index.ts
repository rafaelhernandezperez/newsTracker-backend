import { onSchedule } from "firebase-functions/v2/scheduler";
import { runTrackingCycle, runPriceAlertCycle } from "../services/trackerService/trackerService";
import { runDailyDigestCycle } from "../services/digestService/digestService";

/**
 * News tracker. Runs every 15 minutes to keep the enriched news store + history
 * fresh (this also backs the chart). Routine coverage is NOT pushed per item
 * (the daily digest covers it); the exceptions, matching the onboarding alert
 * preferences, are high-impact stories and >3% price moves, pushed immediately
 * to the users who opted in.
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
    await runPriceAlertCycle();
  }
);

/**
 * Daily digest. Once a day at 9:00 (Europe/Madrid) — the time promised by the
 * onboarding "Daily digest (9am)" toggle — it sends each opted-in user a single
 * notification with the most relevant news across all the tickers they follow.
 */
export const dailyDigest = onSchedule(
  {
    schedule: "0 9 * * *",
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
