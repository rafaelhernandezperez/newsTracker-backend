import Parser from 'rss-parser';
import axios from 'axios';
import YahooFinance from 'yahoo-finance2';
import {
  GOOGLE_EDITIONS,
  googleNewsHistoricalUrl,
  QUERY_SOURCES,
} from './sources';
import { resolveCompanyProfile } from './companyResolver';
import { calculateRelevanceScore, financialSignal } from './relevance';
import { createNewsId, dedupeNews } from './normalizers';
import { TtlCache } from './cache';
import { enrichNewsBatch } from '../aiService/aiService';
import type { CompanyProfile, NewsItem } from './types';

const parser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (compatible; financial-news-tracker/2.0; +https://example.com/bot)',
  },
});

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// Per-ticker results are cached briefly so the on-demand API and the scheduler
// don't hammer the same feeds repeatedly.
const newsCache = new TtlCache<NewsItem[]>(5 * 60 * 1000);

// Historical company news (Finnhub), cached per ticker + date window. This is a
// source that carries OLD-dated stories, so the frontend can spread its chart
// markers across real publish dates instead of clustering on "today".
const finnhubCache = new TtlCache<NewsItem[]>(30 * 60 * 1000);
const FINNHUB_COMPANY_NEWS_URL = 'https://finnhub.io/api/v1/company-news';

// Historical Google News windows are immutable once the window is in the past,
// so they can be cached much longer than the live feeds.
const googleHistoryCache = new TtlCache<NewsItem[]>(12 * 60 * 60 * 1000);

// AI classification of a given story is stable, so it's cached far longer than
// the feed results and keyed by the item's stable id. This keeps repeated
// on-demand requests cheap and bounds LLM calls.
const enrichmentCache = new TtlCache<{
  importance: NonNullable<NewsItem['importance']>;
  sentiment: NonNullable<NewsItem['sentiment']>;
  aiSummary?: string;
}>(6 * 60 * 60 * 1000);

// Bound how many items we send to the LLM per request. Classification is
// batched (several items per call), so this stays responsive even at 40.
const MAX_ENRICH_PER_REQUEST = 40;

type FetchNewsOptions = {
  companyName?: string;
  limit?: number;
  minScore?: number;
  from?: string;
  to?: string;
  range?: string;
  daysBack?: number;
  requireFinancial?: boolean;
  /** When true, attach AI importance + sentiment to the returned items. */
  enrich?: boolean;
};

/**
 * Attach AI importance + sentiment + summary to each item. Cached per item id;
 * uncached items are classified in batched LLM calls. On failure items are
 * returned unchanged (markers then fall back to a neutral size/color).
 */
export async function enrichNewsItems(items: NewsItem[]): Promise<NewsItem[]> {
  const pending = items.filter((item) => !enrichmentCache.get(item.id));

  if (pending.length > 0) {
    try {
      const enrichments = await enrichNewsBatch(
        pending.map((item) => ({
          text: `${item.title}. ${item.summary ?? ''}`,
          fallbackSummary: item.summary ?? '',
        }))
      );
      enrichments.forEach((enrichment, i) => {
        enrichmentCache.set(pending[i].id, {
          importance: enrichment.importance,
          sentiment: enrichment.sentiment,
          aiSummary: enrichment.summary || undefined,
        });
      });
    } catch (error) {
      console.warn('[newsService] batch enrichment failed:', error);
    }
  }

  return items.map((item) => {
    const enrichment = enrichmentCache.get(item.id);
    return enrichment ? { ...item, ...enrichment } : item;
  });
}

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
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function parseRangeToDays(range?: string): number | undefined {
  if (!range) return undefined;
  const map: Record<string, number> = {
    '1D': 1,
    '5D': 5,
    '1W': 7,
    '1M': 30,
    '3M': 90,
    '6M': 182,
    '1Y': 365,
  };
  return map[range.trim().toUpperCase()];
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
  const oldestAllowed = new Date(now.getTime() - MAX_LOOKBACK_DAYS * ONE_DAY_MS);

  let from = parseDateInput(options.from);
  let to = parseDateInput(options.to) ?? now;
  const daysBack = normalizeDaysBack(options.daysBack, options.range);

  if (!from && typeof daysBack === 'number') {
    from = new Date(now.getTime() - daysBack * ONE_DAY_MS);
  }
  if (from && from < oldestAllowed) from = oldestAllowed;
  if (to > now) to = now;
  if (from && from > to) {
    const swap = new Date(to);
    to = new Date(from);
    from = swap;
  }

  return { from, to };
}

function isWithinDateRange(item: NewsItem, range: ResolvedDateRange): boolean {
  if (!range.from && !range.to) return true;
  const publishedAt = toTimestamp(item.isoDate ?? item.pubDate);
  if (!publishedAt) return false;
  if (range.from && publishedAt < range.from.getTime()) return false;
  if (range.to && publishedAt > range.to.getTime()) return false;
  return true;
}

/** Strip Google News' trailing " - Publisher" suffix from a title. */
function cleanTitle(title: string): string {
  return title.replace(/\s+-\s+[^-]+$/, '').trim() || title.trim();
}

type ScoredItemInput = {
  profile: CompanyProfile;
  sourceName: string;
  language: string;
  title: string;
  summary: string;
  link: string;
  pubDate?: string;
  isoDate?: string;
  /**
   * True when the source is a literal per-company query (search feed, Finnhub
   * company-news, Yahoo ticker search): provenance alone is evidence of
   * relevance, so those items get base credit on top of keyword matching.
   */
  searchProvenance: boolean;
};

/** Score + assemble a NewsItem the same way for every source. */
function buildScoredItem(input: ScoredItemInput): NewsItem | null {
  const title = cleanTitle(input.title.trim());
  const link = input.link.trim();
  if (!title || !link) return null;

  const keywordScore = calculateRelevanceScore(
    title,
    input.summary,
    input.profile.aliases,
    input.profile.ticker
  );
  const base = input.searchProvenance ? keywordScore + 2 : keywordScore;
  // Bias toward financial coverage and away from sponsorship/sports/CSR
  // brand mentions that merely carry the company name.
  const signal = financialSignal(title, input.summary);

  return {
    id: createNewsId(input.sourceName, link, title),
    title,
    link,
    source: input.sourceName,
    summary: input.summary,
    pubDate: input.pubDate,
    isoDate: input.isoDate,
    language: input.language,
    matchedTickers: [input.profile.ticker],
    score: base + signal.delta,
    isFinancial: signal.isFinancial,
  };
}

function mapFeedItems(
  items: FeedItem[],
  profile: CompanyProfile,
  sourceName: string,
  language: string,
  searchProvenance: boolean
): NewsItem[] {
  return items
    .map((item) =>
      buildScoredItem({
        profile,
        sourceName,
        language,
        title: item.title ?? '',
        summary: item.contentSnippet?.trim() || item.content?.trim() || '',
        link: item.link ?? '',
        pubDate: item.pubDate,
        isoDate: item.isoDate,
        searchProvenance,
      })
    )
    .filter((item): item is NewsItem => item !== null);
}

async function fetchFromQuerySources(profile: CompanyProfile): Promise<NewsItem[]> {
  const results = await Promise.all(
    QUERY_SOURCES.map(async (source) => {
      const url = source.build(profile);
      try {
        const feed = await parser.parseURL(url);
        return mapFeedItems(
          feed.items ?? [],
          profile,
          source.name,
          source.language,
          source.kind === 'search'
        );
      } catch (error) {
        console.error(`[newsService] Feed error (${source.name}) for ${profile.ticker}:`, error);
        return [] as NewsItem[];
      }
    })
  );

  return results.flat();
}

type YahooSearchNews = {
  title?: string;
  link?: string;
  publisher?: string;
  providerPublishTime?: Date | number;
};

/**
 * Yahoo Finance ticker search news (yahoo-finance2). Keyless, ticker-scoped,
 * dated, and publisher-attributed — a solid complement to the RSS feeds.
 */
async function fetchYahooSearchNews(profile: CompanyProfile): Promise<NewsItem[]> {
  try {
    // validateResult:false loosens the return type; cast to the fields we read.
    const result = (await yf.search(
      profile.ticker,
      { newsCount: 12, quotesCount: 1 },
      { validateResult: false }
    )) as { news?: YahooSearchNews[] };
    const news: YahooSearchNews[] = Array.isArray(result?.news) ? result.news : [];

    return news
      .map((article) => {
        const publishedAt =
          article.providerPublishTime instanceof Date
            ? article.providerPublishTime.toISOString()
            : typeof article.providerPublishTime === 'number'
              ? new Date(article.providerPublishTime * 1000).toISOString()
              : undefined;

        return buildScoredItem({
          profile,
          sourceName: `Yahoo Finance${article.publisher ? ` · ${article.publisher}` : ''}`,
          language: 'en',
          title: article.title ?? '',
          summary: '',
          link: article.link ?? '',
          pubDate: publishedAt,
          isoDate: publishedAt,
          searchProvenance: true,
        });
      })
      .filter((item): item is NewsItem => item !== null);
  } catch (error) {
    console.error(`[newsService] Yahoo search error for ${profile.ticker}:`, error);
    return [];
  }
}

type FinnhubArticle = {
  datetime?: number; // unix seconds
  headline?: string;
  summary?: string;
  source?: string;
  url?: string;
  id?: number;
};

function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Historical company news from Finnhub (https://finnhub.io). Free tier, keyed by
 * FINNHUB_TOKEN, returns up to ~1 year of dated stories per ticker. Without a
 * token this is a no-op, so the rest of the pipeline keeps working on RSS alone.
 */
async function fetchFinnhubNews(
  profile: CompanyProfile,
  range: ResolvedDateRange
): Promise<NewsItem[]> {
  const token = process.env.FINNHUB_TOKEN?.trim() || process.env.FINNHUB_API_KEY?.trim();
  if (!token) {
    return [];
  }

  const now = new Date();
  const to = range.to ?? now;
  // Default to a 90-day window when the caller didn't constrain the range.
  const from = range.from ?? new Date(to.getTime() - 90 * ONE_DAY_MS);
  const cacheKey = `${profile.ticker}|${toYmd(from)}|${toYmd(to)}`;

  return finnhubCache.getOrSet(cacheKey, async () => {
    try {
      const response = await axios.get<FinnhubArticle[]>(FINNHUB_COMPANY_NEWS_URL, {
        params: { symbol: profile.ticker, from: toYmd(from), to: toYmd(to), token },
        timeout: 12000,
      });

      const articles = Array.isArray(response.data) ? response.data : [];
      return articles
        .map((article): NewsItem | null => {
          if (!article.datetime) return null;
          const publishedAt = new Date(article.datetime * 1000).toISOString();

          return buildScoredItem({
            profile,
            sourceName: `Finnhub${article.source ? ` · ${article.source}` : ''}`,
            language: 'en',
            title: article.headline ?? '',
            summary: article.summary?.trim() ?? '',
            link: article.url ?? '',
            pubDate: publishedAt,
            isoDate: publishedAt,
            searchProvenance: true,
          });
        })
        .filter((item): item is NewsItem => item !== null);
    } catch (error) {
      console.error(`[newsService] Finnhub error for ${profile.ticker}:`, error);
      return [];
    }
  });
}

// Ranges shorter than this are covered by the live feeds; no backfill needed.
const HISTORY_MIN_DAYS = 14;
// Bound the number of date windows per edition so a cold 1Y request stays fast.
const HISTORY_MAX_WINDOWS = 4;

/**
 * Historical Google News coverage: split the requested range into a few date
 * windows and query each with `after:`/`before:`. Keyless, and each window
 * returns up to ~100 stories dated INSIDE the window, so long chart ranges get
 * markers spread across their real publish dates. Windows are cached 12h.
 */
async function fetchHistoricalGoogleNews(
  profile: CompanyProfile,
  range: ResolvedDateRange
): Promise<NewsItem[]> {
  const { from } = range;
  const to = range.to ?? new Date();
  if (!from) return [];

  const totalDays = (to.getTime() - from.getTime()) / ONE_DAY_MS;
  if (totalDays <= HISTORY_MIN_DAYS) return [];

  const windowCount = Math.min(HISTORY_MAX_WINDOWS, Math.ceil(totalDays / 45));
  const windowMs = (to.getTime() - from.getTime()) / windowCount;

  const jobs: Promise<NewsItem[]>[] = [];
  for (let i = 0; i < windowCount; i++) {
    const windowFrom = new Date(from.getTime() + i * windowMs);
    const windowTo = new Date(from.getTime() + (i + 1) * windowMs);

    for (const edition of GOOGLE_EDITIONS) {
      const cacheKey = `${profile.ticker}|${edition.language}|${toYmd(windowFrom)}|${toYmd(windowTo)}`;
      jobs.push(
        googleHistoryCache.getOrSet(cacheKey, async () => {
          try {
            const url = googleNewsHistoricalUrl(profile, edition, toYmd(windowFrom), toYmd(windowTo));
            const feed = await parser.parseURL(url);
            return mapFeedItems(feed.items ?? [], profile, edition.name, edition.language, true);
          } catch (error) {
            console.error(
              `[newsService] Google history error (${edition.language} ${toYmd(windowFrom)}..${toYmd(windowTo)}) for ${profile.ticker}:`,
              error
            );
            return [];
          }
        })
      );
    }
  }

  return (await Promise.all(jobs)).flat();
}

/**
 * Pick up to `limit` items SPREAD across the requested date range instead of
 * just the newest ones. Without this, historical coverage gets crowded out on
 * long timeframes and the chart markers all cluster on the most recent days.
 * Buckets the range, takes the best-scored story per bucket round-robin, and
 * returns the selection newest-first.
 */
function selectSpreadAcrossRange(
  items: NewsItem[],
  range: ResolvedDateRange,
  limit: number
): NewsItem[] {
  const byDateDesc = (a: NewsItem, b: NewsItem): number => {
    const dateA = toTimestamp(a.isoDate ?? a.pubDate);
    const dateB = toTimestamp(b.isoDate ?? b.pubDate);
    if (dateB !== dateA) return dateB - dateA;
    return b.score - a.score;
  };

  const { from } = range;
  const to = range.to ?? new Date();
  const totalDays = from ? (to.getTime() - from.getTime()) / ONE_DAY_MS : 0;

  if (!from || totalDays <= HISTORY_MIN_DAYS || items.length <= limit) {
    return [...items].sort(byDateDesc).slice(0, limit);
  }

  const bucketCount = Math.min(limit, Math.ceil(totalDays));
  const bucketMs = (to.getTime() - from.getTime()) / bucketCount;

  const buckets = new Map<number, NewsItem[]>();
  for (const item of items) {
    const ts = toTimestamp(item.isoDate ?? item.pubDate);
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((ts - from.getTime()) / bucketMs)));
    const bucket = buckets.get(index) ?? [];
    bucket.push(item);
    buckets.set(index, bucket);
  }
  // Best story first within each bucket (score, then recency).
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.score - a.score || byDateDesc(a, b));
  }

  const ordered = [...buckets.entries()].sort(([a], [b]) => a - b).map(([, bucket]) => bucket);
  const selected: NewsItem[] = [];
  for (let round = 0; selected.length < limit; round++) {
    let took = false;
    for (const bucket of ordered) {
      if (round < bucket.length && selected.length < limit) {
        selected.push(bucket[round]);
        took = true;
      }
    }
    if (!took) break;
  }

  return selected.sort(byDateDesc);
}

export async function fetchNewsForTicker(
  ticker: string,
  options: FetchNewsOptions = {}
): Promise<NewsItem[]> {
  // minScore 3 drops items that only earned the base "search provenance" credit
  // (no keyword match at all) — e.g. legal bulletins that merely list the ticker.
  // requireFinancial drops brand-only mentions (sports/sponsorship/CSR).
  const { companyName, limit = 20, minScore = 3, requireFinancial = true, enrich = false } = options;

  const profile = await resolveCompanyProfile(ticker, companyName);
  const dateRange = resolveDateRange(options);

  // Recent coverage (RSS + Yahoo search) and dated historical coverage
  // (Google News date windows + Finnhub), all fetched in parallel.
  const [rssNews, yahooNews, googleHistory, finnhubNews] = await Promise.all([
    newsCache.getOrSet(`rss|${profile.ticker}|${profile.companyName}`, () =>
      fetchFromQuerySources(profile)
    ),
    newsCache.getOrSet(`yahoo|${profile.ticker}`, () => fetchYahooSearchNews(profile)),
    fetchHistoricalGoogleNews(profile, dateRange),
    fetchFinnhubNews(profile, dateRange),
  ]);

  const filtered = [...rssNews, ...yahooNews, ...googleHistory, ...finnhubNews].filter(
    (item) =>
      item.link &&
      item.title &&
      item.score >= minScore &&
      (!requireFinancial || item.isFinancial) &&
      isWithinDateRange(item, dateRange)
  );

  const deduped = dedupeNews(filtered);
  const top = selectSpreadAcrossRange(deduped, dateRange, limit);

  if (enrich) {
    // Enrich the freshest slice with AI; return the rest unchanged so longer
    // timeframes still get a full spread of (neutral) dated markers.
    const enriched = await enrichNewsItems(top.slice(0, MAX_ENRICH_PER_REQUEST));
    return [...enriched, ...top.slice(MAX_ENRICH_PER_REQUEST)];
  }

  return top;
}
