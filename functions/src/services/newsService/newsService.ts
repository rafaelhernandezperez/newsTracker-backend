// WebScrapping
import Parser from 'rss-parser';
import { FEED_SOURCES } from './sources';
import { buildCompanyProfile } from './companyResolver';
import { calculateRelevanceScore, countMatches } from './relevance';
import { createNewsId, dedupeNews } from './normalizers';
import type { NewsItem } from './types';

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'financial-news-app/1.0',
  },
});

type FetchNewsOptions = {
  companyName?: string;
  limit?: number;
  minScore?: number;
  from?: string;
  to?: string;
  range?: string;
  daysBack?: number;
};

type FeedItem = {
  title?: string;
  contentSnippet?: string;
  content?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
};

type ResolvedDateRange = {
  from?: Date;
  to?: Date;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_DAYS = 365;

function toTimestamp(value?: string): number {
  const ts = new Date(value ?? '').getTime();
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

function parseDateInput(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function parseRangeToDays(range?: string): number | undefined {
  if (!range) {
    return undefined;
  }

  const normalized = range.trim().toUpperCase();
  const map: Record<string, number> = {
    '1D': 1,
    '5D': 5,
    '1W': 7,
    '1M': 30,
    '3M': 90,
    '6M': 182,
    '1Y': 365,
  };

  return map[normalized];
}

function normalizeDaysBack(daysBack?: number, range?: string): number | undefined {
  if (typeof daysBack === 'number' && Number.isFinite(daysBack) && daysBack > 0) {
    return Math.min(Math.floor(daysBack), MAX_LOOKBACK_DAYS);
  }

  const fromRange = parseRangeToDays(range);
  if (typeof fromRange === 'number') {
    return Math.min(fromRange, MAX_LOOKBACK_DAYS);
  }

  return undefined;
}

function resolveDateRange(options: FetchNewsOptions): ResolvedDateRange {
  const now = new Date();
  const oldestAllowed = new Date(now.getTime() - (MAX_LOOKBACK_DAYS * ONE_DAY_MS));

  let from = parseDateInput(options.from);
  let to = parseDateInput(options.to) ?? now;
  const daysBack = normalizeDaysBack(options.daysBack, options.range);

  if (!from && typeof daysBack === 'number') {
    from = new Date(now.getTime() - (daysBack * ONE_DAY_MS));
  }

  if (from && from < oldestAllowed) {
    from = oldestAllowed;
  }

  if (to > now) {
    to = now;
  }

  if (from && from > to) {
    const swappedFrom = new Date(to);
    to = new Date(from);
    from = swappedFrom;
  }

  return {
    from,
    to,
  };
}

function isWithinDateRange(item: NewsItem, range: ResolvedDateRange): boolean {
  if (!range.from && !range.to) {
    return true;
  }

  const publishedAt = toTimestamp(item.isoDate ?? item.pubDate);
  if (!publishedAt) {
    return false;
  }

  if (range.from && publishedAt < range.from.getTime()) {
    return false;
  }

  if (range.to && publishedAt > range.to.getTime()) {
    return false;
  }

  return true;
}

async function fetchRssNewsForTicker(
  profile: ReturnType<typeof buildCompanyProfile>
): Promise<NewsItem[]> {
  const allResults = await Promise.all(
    FEED_SOURCES.map(async (source) => {
      try {
        const feed = await parser.parseURL(source.url);

        return (feed.items ?? []).map((item: FeedItem) => {
          const title = item.title?.trim() ?? '';
          const summary =
            item.contentSnippet?.trim() ||
            item.content?.trim() ||
            '';
          const link = item.link?.trim() ?? '';

          const combinedText = `${title} ${summary}`;
          const matches = countMatches(combinedText, profile.aliases);
          const score = calculateRelevanceScore(
            title,
            summary,
            profile.aliases,
            profile.ticker
          );

          const newsItem: NewsItem = {
            id: createNewsId(source.name, link, title),
            title,
            link,
            source: source.name,
            summary,
            pubDate: item.pubDate,
            isoDate: item.isoDate,
            language: source.language,
            matchedTickers: matches.length > 0 ? [profile.ticker] : [],
            score,
          };

          return newsItem;
        });
      } catch (error) {
        console.error(`[newsService] Error con feed ${source.name}:`, error);
        return [];
      }
    })
  );

  return allResults.flat();
}

export async function fetchNewsForTicker(
  ticker: string,
  options: FetchNewsOptions = {}
): Promise<NewsItem[]> {
  const { companyName, limit = 20, minScore = 4 } = options;

  const profile = buildCompanyProfile(ticker, companyName);
  const dateRange = resolveDateRange(options);

  const rssNews = await fetchRssNewsForTicker(profile);

  const filtered = rssNews.filter(
    (item: NewsItem) =>
      item.link &&
      item.title &&
      item.matchedTickers.length > 0 &&
      item.score >= minScore &&
      isWithinDateRange(item, dateRange)
  );

  const deduped = dedupeNews(filtered);

  const sorted = deduped.sort((a, b) => {
    const dateA = toTimestamp(a.isoDate ?? a.pubDate);
    const dateB = toTimestamp(b.isoDate ?? b.pubDate);

    if (dateB !== dateA) return dateB - dateA;
    return b.score - a.score;
  });

  return sorted.slice(0, limit);
}
