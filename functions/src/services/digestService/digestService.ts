import { fetchNewsForTicker } from "../newsService/newsService";
import { stableNewsKey, toTimestamp } from "../newsService/normalizers";
import {
  getUsersWithWatchlists,
  getRecentDigestNewsIds,
  recordDigestNewsId,
  getAlertPrefsForUsers,
} from "../firebaseService/firebaseService";
import { notifySubscribers } from "../notificationService/notificationService";
import type { NewsItem } from "../newsService/types";

// The digest looks at the last day of coverage, matching its once-a-day cadence.
const DIGEST_LOOKBACK_DAYS = 1;
// How many items to pull per ticker before ranking; small, since we keep one.
const PER_TICKER_LIMIT = 5;
// How many tickers to fetch/enrich concurrently.
const FETCH_CONCURRENCY = 5;

export type DigestSummary = {
  users: number;
  notified: number;
  skipped: number;
};

const IMPORTANCE_RANK: Record<string, number> = {
  MUY_IMPORTANTE: 3,
  IMPORTANTE: 2,
  NEUTRO: 1,
  POCO_RELEVANTE: 0,
};

function importanceRank(item: NewsItem): number {
  return item.importance ? IMPORTANCE_RANK[item.importance] ?? 1 : 1;
}

/**
 * Rank by AI importance, then keyword relevance, then recency. This is what
 * makes "the most relevant news across the user's tickers" concrete: a
 * high-impact story outranks routine coverage.
 */
function isMoreRelevant(candidate: NewsItem, current: NewsItem): boolean {
  const byImportance = importanceRank(candidate) - importanceRank(current);
  if (byImportance !== 0) return byImportance > 0;
  if (candidate.score !== current.score) return candidate.score > current.score;
  return (
    toTimestamp(candidate.isoDate ?? candidate.pubDate) >
    toTimestamp(current.isoDate ?? current.pubDate)
  );
}

/**
 * Fetch + enrich each unique ticker ONCE, however many users follow it, so cost
 * scales with distinct tickers rather than users × tickers.
 */
async function fetchNewsByTicker(
  tickers: Map<string, string | undefined>
): Promise<Map<string, NewsItem[]>> {
  const entries = Array.from(tickers.entries());
  const result = new Map<string, NewsItem[]>();

  for (let i = 0; i < entries.length; i += FETCH_CONCURRENCY) {
    await Promise.all(
      entries.slice(i, i + FETCH_CONCURRENCY).map(async ([ticker, companyName]) => {
        try {
          const items = await fetchNewsForTicker(ticker, {
            companyName,
            daysBack: DIGEST_LOOKBACK_DAYS,
            limit: PER_TICKER_LIMIT,
            enrich: true,
          });
          result.set(ticker, items);
        } catch (error) {
          console.error(`[digest] fetch failed for ${ticker}:`, error);
          result.set(ticker, []);
        }
      })
    );
  }

  return result;
}

/** Collect unique tickers across users, keeping the first companyName seen. */
function collectUniqueTickers(
  users: { tickers: { ticker: string; companyName?: string }[] }[]
): Map<string, string | undefined> {
  const unique = new Map<string, string | undefined>();
  for (const user of users) {
    for (const { ticker, companyName } of user.tickers) {
      if (!unique.has(ticker) || (!unique.get(ticker) && companyName)) {
        unique.set(ticker, companyName);
      }
    }
  }
  return unique;
}

/**
 * One daily digest cycle: for every user, find the single most relevant story
 * across the tickers they follow and push exactly one notification. Skips users
 * with no fresh news, or whose top story went out in a recent digest.
 */
export async function runDailyDigestCycle(): Promise<DigestSummary> {
  const allUsers = await getUsersWithWatchlists();
  const summary: DigestSummary = { users: allUsers.length, notified: 0, skipped: 0 };

  // Honor the onboarding "Daily digest" toggle before any news is fetched on a
  // user's behalf.
  const prefsByUid = await getAlertPrefsForUsers(allUsers.map((user) => user.uid));
  const users = allUsers.filter((user) => {
    const wantsDigest = prefsByUid.get(user.uid)?.dailyDigest !== false;
    if (!wantsDigest) summary.skipped += 1;
    return wantsDigest;
  });

  const newsByTicker = await fetchNewsByTicker(collectUniqueTickers(users));

  for (const user of users) {
    try {
      if (user.tickers.length === 0) {
        summary.skipped += 1;
        continue;
      }

      const recentIds = await getRecentDigestNewsIds(user.uid);

      // Rank EVERY fetched article across the user's tickers, skipping stories
      // already sent recently — yesterday's runner-up isn't today's news.
      let top: NewsItem | null = null;
      let topId: string | null = null;
      for (const { ticker } of user.tickers) {
        for (const item of newsByTicker.get(ticker) ?? []) {
          const newsId = stableNewsKey(item.link, item.title);
          if (recentIds.includes(newsId)) continue;
          if (!top || isMoreRelevant(item, top)) {
            top = item;
            topId = newsId;
          }
        }
      }

      if (!top || !topId) {
        summary.skipped += 1;
        continue;
      }

      const { sent } = await notifySubscribers([user.uid], {
        ticker: top.matchedTickers[0] ?? "",
        title: top.title,
        // Prefer the one-sentence AI summary; raw RSS snippets can be long/noisy.
        body: top.aiSummary || top.summary || top.title,
        link: top.link,
        newsId: topId,
        sentiment: top.sentiment,
      });

      if (sent > 0) {
        await recordDigestNewsId(user.uid, topId);
        summary.notified += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      // Never log the uid: it is personal data and logs outlive the cycle.
      // The error itself is what makes a failed digest actionable.
      console.error("[digest] failed processing one user:", error);
    }
  }

  console.log("[digest] cycle complete", summary);
  return summary;
}
