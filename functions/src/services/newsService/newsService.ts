import Parser from 'rss-parser';
import axios from 'axios';
import { QUERY_SOURCES } from './sources';
import { resolveCompanyProfile } from './companyResolver';
import { calculateRelevanceScore, financialSignal } from './relevance';
import { createNewsId, dedupeNews } from './normalizers';
import { TtlCache } from './cache';
import { enrichNews } from '../aiService/aiService';
import type { CompanyProfile, NewsItem } from './types';

const parser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (compatible; financial-news-tracker/2.0; +https://example.com/bot)',
  },
});

// Per-ticker results are cached briefly so the on-demand API and the scheduler
// don't hammer the same feeds repeatedly.
const newsCache = new TtlCache<NewsItem[]>(5 * 60 * 1000);

// Historical company news (Finnhub), cached per ticker + date window. This is the
// source that actually carries OLD-dated stories, so the frontend can spread its
// chart markers across real publish dates instead of clustering on "today".
const historicalCache = new TtlCache<NewsItem[]>(30 * 60 * 1000);
const FINNHUB_COMPANY_NEWS_URL = 'https://finnhub.io/api/v1/company-news';

// AI classification of a given story is stable, so it's cached far longer than
// the feed results and keyed by the item's stable id. This keeps repeated
// on-demand requests cheap and bounds Hugging Face calls.
const enrichmentCache = new TtlCache<{
  importance: NonNullable<NewsItem['importance']>;
  sentiment: NonNullable<NewsItem['sentiment']>;
}>(6 * 60 * 60 * 1000);

// Bound how many items we send to the LLM per request so the on-demand endpoint
// stays responsive even when a feed returns a large batch.
const MAX_ENRICH_PER_REQUEST = 25;

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
 * Attach AI importance + sentiment to each item, in parallel and cached by id.
 * On any failure the item is returned unchanged (markers then fall back to a
 * neutral size/color on the frontend).
 */
export async function enrichNewsItems(items: NewsItem[]): Promise<NewsItem[]> {
  return Promise.all(
    items.map(async (item) => {
      try {
        const enrichment = await enrichmentCache.getOrSet(item.id, async () => {
          const result = await enrichNews(
            `${item.title}. ${item.summary ?? ''}`,
            item.summary ?? ''
          );
          return { importance: result.importance, sentiment: result.sentiment };
        });
        return { ...item, ...enrichment };
      } catch (error) {
        console.warn(`[newsService] enrichment failed for ${item.id}:`, error);
        return item;
      }
    })
  );
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

async function fetchFromQuerySources(profile: CompanyProfile): Promise<NewsItem[]> {
  const results = await Promise.all(
    QUERY_SOURCES.map(async (source) => {
      const url = source.build(profile);
      try {
        const feed = await parser.parseURL(url);
        return (feed.items ?? []).map((item: FeedItem): NewsItem => {
          const title = cleanTitle(item.title?.trim() ?? '');
          const summary = item.contentSnippet?.trim() || item.content?.trim() || '';
          const link = item.link?.trim() ?? '';

          const keywordScore = calculateRelevanceScore(
            title,
            summary,
            profile.aliases,
            profile.ticker
          );
          // 'search' sources are a literal per-company query, so provenance alone
          // is evidence of relevance (base credit). 'feed' sources may pad with
          // general market stories, so they must earn it via keyword matching.
          const base = source.kind === 'search' ? keywordScore + 2 : keywordScore;
          // Bias toward financial coverage and away from sponsorship/sports/CSR
          // brand mentions that merely carry the company name.
          const signal = financialSignal(title, summary);
          const score = base + signal.delta;

          return {
            id: createNewsId(source.name, link, title),
            title,
            link,
            source: source.name,
            summary,
            pubDate: item.pubDate,
            isoDate: item.isoDate,
            language: source.language,
            matchedTickers: [profile.ticker],
            score,
            isFinancial: signal.isFinancial,
          };
        });
      } catch (error) {
        console.error(`[newsService] Feed error (${source.name}) for ${profile.ticker}:`, error);
        return [] as NewsItem[];
      }
    })
  );

  return results.flat();
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

  return historicalCache.getOrSet(cacheKey, async () => {
    try {
      const response = await axios.get<FinnhubArticle[]>(FINNHUB_COMPANY_NEWS_URL, {
        params: { symbol: profile.ticker, from: toYmd(from), to: toYmd(to), token },
        timeout: 12000,
      });

      const articles = Array.isArray(response.data) ? response.data : [];
      return articles
        .map((article): NewsItem | null => {
          const title = article.headline?.trim() ?? '';
          const link = article.url?.trim() ?? '';
          if (!title || !link || !article.datetime) {
            return null;
          }

          const summary = article.summary?.trim() ?? '';
          const publishedAt = new Date(article.datetime * 1000).toISOString();
          const sourceName = `Finnhub${article.source ? ` · ${article.source}` : ''}`;

          // Finnhub company-news is already ticker-scoped (like a 'search'
          // source), so provenance earns base credit just like Google search.
          const keywordScore = calculateRelevanceScore(
            title,
            summary,
            profile.aliases,
            profile.ticker
          );
          const signal = financialSignal(title, summary);

          return {
            id: createNewsId('Finnhub', link, title),
            title,
            link,
            source: sourceName,
            summary,
            pubDate: publishedAt,
            isoDate: publishedAt,
            language: 'en',
            matchedTickers: [profile.ticker],
            score: keywordScore + 2 + signal.delta,
            isFinancial: signal.isFinancial,
          };
        })
        .filter((item): item is NewsItem => item !== null);
    } catch (error) {
      console.error(`[newsService] Finnhub error for ${profile.ticker}:`, error);
      return [];
    }
  });
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

  const cacheKey = `${profile.ticker}|${profile.companyName}`;
  // Recent RSS coverage + dated historical coverage, fetched in parallel.
  const [rssNews, historicalNews] = await Promise.all([
    newsCache.getOrSet(cacheKey, () => fetchFromQuerySources(profile)),
    fetchFinnhubNews(profile, dateRange),
  ]);

  const filtered = [...rssNews, ...historicalNews].filter(
    (item) =>
      item.link &&
      item.title &&
      item.score >= minScore &&
      (!requireFinancial || item.isFinancial) &&
      isWithinDateRange(item, dateRange)
  );

  const deduped = dedupeNews(filtered);

  const sorted = deduped.sort((a, b) => {
    const dateA = toTimestamp(a.isoDate ?? a.pubDate);
    const dateB = toTimestamp(b.isoDate ?? b.pubDate);
    if (dateB !== dateA) return dateB - dateA;
    return b.score - a.score;
  });

  const top = sorted.slice(0, limit);

  if (enrich) {
    // Enrich the freshest slice with AI; return the rest unchanged so longer
    // timeframes still get a full spread of (neutral) dated markers.
    const enriched = await enrichNewsItems(top.slice(0, MAX_ENRICH_PER_REQUEST));
    return [...enriched, ...top.slice(MAX_ENRICH_PER_REQUEST)];
  }

  return top;
}
