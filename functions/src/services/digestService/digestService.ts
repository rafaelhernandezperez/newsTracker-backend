import { fetchNewsForTicker } from "../newsService/newsService";
import { stableNewsKey } from "../newsService/normalizers";
import {
  getUsersWithWatchlists,
  getLastDigestNewsId,
  setLastDigestNewsId,
  type UserWatchlist,
} from "../firebaseService/firebaseService";
import { notifySubscribers } from "../notificationService/notificationService";
import type { NewsItem } from "../newsService/types";

// The digest looks at the last day of coverage, matching its once-a-day cadence.
const DIGEST_LOOKBACK_DAYS = 1;
// How many items to pull per ticker before ranking; small, since we only keep one.
const PER_TICKER_LIMIT = 5;

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

function publishedAtMs(item: NewsItem): number {
  const ts = new Date(item.isoDate ?? item.pubDate ?? "").getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Rank by AI importance first, then keyword relevance score, then recency. This
 * is what makes "the most relevant news across all the user's tickers" concrete:
 * a freshly listed/▲ high-impact story outranks routine coverage.
 */
function isMoreRelevant(candidate: NewsItem, current: NewsItem): boolean {
  const ri = importanceRank(candidate) - importanceRank(current);
  if (ri !== 0) return ri > 0;
  if (candidate.score !== current.score) return candidate.score > current.score;
  return publishedAtMs(candidate) > publishedAtMs(current);
}

/** Find the single most relevant recent article across all of a user's tickers. */
async function pickTopNewsForUser(user: UserWatchlist): Promise<NewsItem | null> {
  const perTicker = await Promise.all(
    user.tickers.map(async ({ ticker, companyName }) => {
      try {
        return await fetchNewsForTicker(ticker, {
          companyName,
          daysBack: DIGEST_LOOKBACK_DAYS,
          limit: PER_TICKER_LIMIT,
          enrich: true,
        });
      } catch (error) {
        console.error(`[digest] fetch failed for ${ticker}:`, error);
        return [] as NewsItem[];
      }
    })
  );

  // Rank EVERY fetched article (across all tickers) against each other and keep
  // the single most relevant one.
  let top: NewsItem | null = null;
  for (const item of perTicker.flat()) {
    if (!top || isMoreRelevant(item, top)) {
      top = item;
    }
  }

  return top;
}

/**
 * One daily digest cycle: for every user, find the single most relevant story
 * across the tickers they follow and push exactly one notification. Skips users
 * with no fresh news or whose top story was already sent in the previous digest.
 */
export async function runDailyDigestCycle(): Promise<DigestSummary> {
  const users = await getUsersWithWatchlists();
  const summary: DigestSummary = { users: users.length, notified: 0, skipped: 0 };

  for (const user of users) {
    try {
      if (user.tickers.length === 0) {
        summary.skipped += 1;
        continue;
      }

      const top = await pickTopNewsForUser(user);
      if (!top) {
        summary.skipped += 1;
        continue;
      }

      const newsId = stableNewsKey(top.link, top.title);
      const lastSent = await getLastDigestNewsId(user.uid);
      if (newsId === lastSent) {
        // Nothing more relevant than yesterday's headline — don't repeat it.
        summary.skipped += 1;
        continue;
      }

      const { sent } = await notifySubscribers([user.uid], {
        ticker: top.matchedTickers[0] ?? "",
        title: top.title,
        // Prefer the one-sentence AI summary; raw RSS snippets can be long/noisy.
        body: top.aiSummary || top.summary || top.title,
        link: top.link,
        newsId,
        sentiment: top.sentiment,
      });

      if (sent > 0) {
        await setLastDigestNewsId(user.uid, newsId);
        summary.notified += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      console.error(`[digest] Failed processing user ${user.uid}:`, error);
    }
  }

  console.log("[digest] cycle complete", summary);
  return summary;
}
