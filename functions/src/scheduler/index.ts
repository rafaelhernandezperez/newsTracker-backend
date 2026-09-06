import { onSchedule } from "firebase-functions/v2/scheduler";
import { runTrackingCycle, runPriceAlertCycle } from "../services/trackerService/trackerService";
import { runDailyDigestCycle } from "../services/digestService/digestService";
import { hfToken } from "../config/secrets";

/**
 * News tracker. Keeps the enriched news store (which also backs the chart)
 * fresh. Routine coverage is not pushed per item — the daily digest covers it —
 * only high-impact stories and >3% price moves, to the users who opted in.
 */
export const trackNews = onSchedule(
  {
    schedule: "every 15 minutes",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Avoid overlapping runs piling up if a cycle runs long.
    retryCount: 0,
    secrets: [hfToken],
  },
  async () => {
    await runTrackingCycle();
    await runPriceAlertCycle();
  }
);

/**
 * Daily digest at the time promised by the onboarding "Daily digest (9am)"
 * toggle: one notification per opted-in user, with the most relevant news
 * across every ticker they follow.
 */
export const dailyDigest = onSchedule(
  {
    schedule: "0 9 * * *",
    timeZone: "Europe/Madrid",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "512MiB",
    retryCount: 0,
    secrets: [hfToken],
  },
  async () => {
    await runDailyDigestCycle();
  }
);
