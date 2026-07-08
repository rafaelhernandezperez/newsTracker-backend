import { fetchNewsForTicker } from "../newsService/newsService";
import { stableNewsKey } from "../newsService/normalizers";
import { enrichNewsBatch } from "../aiService/aiService";
import {
  filterNewNewsIds,
  getAllWatchedTickers,
  saveNewsItem,
  type StoredNews,
  type WatchedTicker,
} from "../firebaseService/firebaseService";
import { notifySubscribers } from "../notificationService/notificationService";

// How far back the scheduler looks each run. Generous enough to survive a
// missed run, while dedup prevents re-notifying on already-seen stories.
const LOOKBACK_DAYS = 3;
// Cap AI enrichment + notifications per ticker per run to bound cost/latency.
const MAX_NEW_PER_TICKER = 5;

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
 *   5. Persist (and, when `notify` is set, push to subscribers via FCM).
 *
 * User-facing alerts now go out once a day via the digest, so this 15-minute
 * cycle defaults to STORAGE ONLY (it keeps the enriched news + history fresh,
 * which also feeds the chart). Pass `{ notify: true }` to restore per-item push.
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

  for (const entry of watched) {
    try {
      const result = await processTicker(entry, notify);
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

async function processTicker(entry: WatchedTicker, notify: boolean) {
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

    if (notify && entry.subscribers.length > 0) {
      const { sent } = await notifySubscribers(entry.subscribers, {
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
