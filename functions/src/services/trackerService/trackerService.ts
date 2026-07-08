import { fetchNewsForTicker } from "../newsService/newsService";
import { stableNewsKey } from "../newsService/normalizers";
import { enrichNewsBatch } from "../aiService/aiService";
import {
  claimPriceAlert,
  filterNewNewsIds,
  getAlertPrefsForUsers,
  getAllWatchedTickers,
  saveNewsItem,
  type AlertPrefs,
  type StoredNews,
  type WatchedTicker,
} from "../firebaseService/firebaseService";
import { notifySubscribers } from "../notificationService/notificationService";
import { getQuote } from "../marketService/marketService";

// How far back the scheduler looks each run. Generous enough to survive a
// missed run, while dedup prevents re-notifying on already-seen stories.
const LOOKBACK_DAYS = 3;
// Cap AI enrichment + notifications per ticker per run to bound cost/latency.
const MAX_NEW_PER_TICKER = 5;
// Daily change (in %) beyond which the "Big price moves" alert fires.
const PRICE_MOVE_THRESHOLD = 3;

export type TrackerSummary = {
  tickers: number;
  candidates: number;
  newItems: number;
  notified: number;
};

/**
 * One tracking cycle:
 *   1. Gather every watched ticker across all users.
 *   2. Fetch recent news per ticker.
 *   3. Keep only items not already stored (dedup by stable key).
 *   4. AI summarize + sentiment for the new ones.
 *   5. Persist. Routine items are NOT pushed (the daily digest covers them),
 *      but MUY_IMPORTANTE items go out immediately to subscribers who enabled
 *      the "High-impact news" alert preference. Pass `{ notify: true }` to
 *      force per-item push for everything (manual/debug use).
 */
export async function runTrackingCycle(
  options: { notify?: boolean } = {}
): Promise<TrackerSummary> {
  const { notify = false } = options;
  const watched = await getAllWatchedTickers();
  const summary: TrackerSummary = {
    tickers: watched.length,
    candidates: 0,
    newItems: 0,
    notified: 0,
  };

  // One batched prefs read for every subscriber in this cycle, so the per-item
  // high-impact fan-out below never hits Firestore again.
  const prefsByUid = await getAlertPrefsForUsers(watched.flatMap((entry) => entry.subscribers));

  for (const entry of watched) {
    try {
      const result = await processTicker(entry, notify, prefsByUid);
      summary.candidates += result.candidates;
      summary.newItems += result.newItems;
      summary.notified += result.notified;
    } catch (error) {
      console.error(`[tracker] Failed processing ${entry.ticker}:`, error);
    }
  }

  console.log("[tracker] cycle complete", summary);
  return summary;
}

async function processTicker(
  entry: WatchedTicker,
  notify: boolean,
  prefsByUid: Map<string, AlertPrefs>
) {
  const news = await fetchNewsForTicker(entry.ticker, {
    companyName: entry.companyName,
    daysBack: LOOKBACK_DAYS,
    limit: 25,
    // Stricter than the on-demand API: only push notifications for items that
    // clearly name the company, not tangential market mentions.
    minScore: 4,
  });

  const result = { candidates: news.length, newItems: 0, notified: 0 };
  if (news.length === 0) return result;

  // Map each item to its stable, source-independent id and dedup the batch.
  const byKey = new Map<string, (typeof news)[number]>();
  for (const item of news) {
    byKey.set(stableNewsKey(item.link, item.title), item);
  }

  const newKeys = await filterNewNewsIds(Array.from(byKey.keys()));
  if (newKeys.size === 0) return result;

  // Newest first, bounded per run.
  const fresh = Array.from(byKey.entries())
    .filter(([key]) => newKeys.has(key))
    .slice(0, MAX_NEW_PER_TICKER);

  // One batched LLM call for the whole run's fresh items instead of one per item.
  const enrichments = await enrichNewsBatch(
    fresh.map(([, item]) => ({
      text: `${item.title}. ${item.summary ?? ""}`,
      fallbackSummary: item.summary ?? "",
    }))
  );

  for (const [index, [id, item]] of fresh.entries()) {
    const enrichment = enrichments[index];

    // Enrichment failed (LLM unreachable, bad response…): skip persisting so
    // the item is still "new" next cycle and gets retried — storing it now
    // would freeze a fake NEUTRO classification forever.
    if (!enrichment) {
      console.warn(`[tracker] skipping ${entry.ticker} item (enrichment failed): ${item.title}`);
      continue;
    }

    const stored: StoredNews = {
      id,
      ticker: entry.ticker,
      title: item.title,
      link: item.link,
      source: item.source,
      summary: item.summary,
      aiSummary: enrichment.summary,
      sentiment: enrichment.sentiment,
      importance: enrichment.importance,
      language: item.language,
      pubDate: item.pubDate,
      isoDate: item.isoDate,
      score: item.score,
    };

    await saveNewsItem(stored);
    result.newItems += 1;

    // `notify` forces per-item push to everyone (debug); otherwise only
    // high-impact stories are pushed, and only to users who opted in.
    const recipients = notify
      ? entry.subscribers
      : enrichment.importance === "MUY_IMPORTANTE"
        ? entry.subscribers.filter((uid) => prefsByUid.get(uid)?.highImpact !== false)
        : [];

    if (recipients.length > 0) {
      const { sent } = await notifySubscribers(recipients, {
        ticker: entry.ticker,
        title: item.title,
        body: enrichment.summary || item.summary || item.title,
        link: item.link,
        newsId: id,
        sentiment: enrichment.sentiment,
      });
      result.notified += sent;
    }
  }

  return result;
}

export type PriceAlertSummary = {
  tickers: number;
  triggered: number;
  notified: number;
};

/** Today's date in the market-facing timezone, used to key one alert per day. */
function madridDateKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
}

/**
 * "Big price moves" alert cycle: for every watched ticker, check the current
 * daily change and push one notification per ticker per day when it moves more
 * than ±3%, to the subscribers who enabled the preference. The Firestore
 * `claimPriceAlert` doc makes the once-a-day guarantee hold across runs.
 */
export async function runPriceAlertCycle(): Promise<PriceAlertSummary> {
  const watched = await getAllWatchedTickers();
  const summary: PriceAlertSummary = { tickers: watched.length, triggered: 0, notified: 0 };
  const dateKey = madridDateKey();

  const prefsByUid = await getAlertPrefsForUsers(watched.flatMap((entry) => entry.subscribers));

  for (const entry of watched) {
    const recipients = entry.subscribers.filter(
      (uid) => prefsByUid.get(uid)?.priceMoves !== false
    );
    if (recipients.length === 0) continue;

    try {
      const quote = await getQuote(entry.ticker);
      const change = quote?.change;
      if (change == null || Math.abs(change) < PRICE_MOVE_THRESHOLD) continue;

      // Skip if today's alert for this ticker already went out.
      if (!(await claimPriceAlert(entry.ticker, dateKey))) continue;
      summary.triggered += 1;

      const direction = change > 0 ? "▲ up" : "▼ down";
      const name = entry.companyName || entry.ticker;
      const { sent } = await notifySubscribers(recipients, {
        ticker: entry.ticker,
        title: `${name} is ${direction} ${Math.abs(change).toFixed(1)}% today`,
        body: `${entry.ticker} moved more than ${PRICE_MOVE_THRESHOLD}% today. Open NewsTracker to see what's driving it.`,
        link: `/portfolio/${entry.ticker}`,
        newsId: `price_${entry.ticker}_${dateKey}`,
        sentiment: change > 0 ? "POSITIVO" : "NEGATIVO",
      });
      summary.notified += sent;
    } catch (error) {
      console.error(`[tracker] price alert failed for ${entry.ticker}:`, error);
    }
  }

  console.log("[tracker] price alert cycle complete", summary);
  return summary;
}
