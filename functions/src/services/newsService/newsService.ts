import Parser from 'rss-parser';
import axios from 'axios';
import YahooFinance from 'yahoo-finance2';
import { GOOGLE_EDITIONS, googleNewsHistoricalUrl, QUERY_SOURCES } from './sources';
import { resolveCompanyProfile } from './companyResolver';
import { calculateRelevanceScore, financialSignal } from './relevance';
import { stableNewsKey, dedupeNews, normalizeText, toTimestamp } from './normalizers';
import { TtlCache } from './cache';
import { enrichNewsBatch } from '../aiService/aiService';
import type { CompanyProfile, NewsItem } from './types';

const parser = new Parser({
  // One stalled feed must not hold an interactive request for 12 seconds; the
  // other sources still provide coverage when this bounded call times out.
  timeout: 7000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (compatible; financial-news-tracker/2.0; +https://example.com/bot)',
  },
});

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// Per-ticker results, cached briefly so the on-demand API and the scheduler
// don't hammer the same feeds.
const newsCache = new TtlCache<NewsItem[]>(5 * 60 * 1000);

// Finnhub carries OLD-dated stories, so the chart can spread its markers across
// real publish dates instead of clustering on "today".
const finnhubCache = new TtlCache<NewsItem[]>(30 * 60 * 1000);
const FINNHUB_COMPANY_NEWS_URL = 'https://finnhub.io/api/v1/company-news';

// Historical Google News windows are immutable once past, so they can be cached
// far longer than the live feeds.
const googleHistoryCache = new TtlCache<NewsItem[]>(12 * 60 * 60 * 1000);

// AI classification of a story is stable, so it is cached by stable id well
// beyond the feed results. This bounds LLM calls across repeated requests.
const enrichmentCache = new TtlCache<{
  importance: NonNullable<NewsItem['importance']>;
  sentiment: NonNullable<NewsItem['sentiment']>;
  localizedTitle?: string;
  aiSummary?: string;
}>(6 * 60 * 60 * 1000);

// Coalesce overlapping requests (dashboard/detail, language refreshes, two
// clients on one story) instead of paying for duplicate model calls.
const enrichmentPending = new Map<string, Promise<void>>();

// Bump when localization prompting/validation changes, so a hot process cannot
// reuse an earlier wrong-language enrichment under the same lang key.
const LOCALIZATION_CACHE_VERSION = 'v2';

type FetchNewsOptions = {
  companyName?: string;
  limit?: number;
  minScore?: number;
  from?: string;
  to?: string;
  range?: string;
  daysBack?: number;
  requireFinancial?: boolean;
  /** Restrict results to the configured RSS feeds (no search APIs/backfill). */
  rssOnly?: boolean;
  /** When true, attach AI importance + sentiment to the returned items. */
  enrich?: boolean;
  /** Language used for every AI summary returned to the interface. */
  language?: 'en' | 'es';
  /** Optional fast-path filter for articles already written in this language. */
  sourceLanguage?: 'en' | 'es';
};

/**
 * Attach AI importance + sentiment and localize the display title/summary,
 * cached per item id and language. On failure, same-language source items stay
 * usable; cross-language items are dropped so untranslated text can't reach UI.
 */
async function enrichNewsItems(
  items: NewsItem[],
  language: 'en' | 'es' = 'en'
): Promise<NewsItem[]> {
  const cacheKey = (item: NewsItem): string =>
    `${LOCALIZATION_CACHE_VERSION}|${item.id}|${language}`;
  const uncached = items.filter((item) => {
    const key = cacheKey(item);
    return !enrichmentCache.get(key) && !enrichmentPending.has(key);
  });

  if (uncached.length > 0) {
    const work = (async (): Promise<void> => {
      try {
        const enrichments = await enrichNewsBatch(
          uncached.map((item) => ({
            text: `${item.title}. ${item.summary ?? ''}`,
            targetLanguage: language,
            // Never fall back to a source-language snippet: that would make the
            // interface mix English and Spanish.
            fallbackSummary: item.language === language ? item.summary ?? '' : '',
          }))
        );
        enrichments.forEach((enrichment, i) => {
          // null = enrichment failed; leave it uncached so a later request
          // retries instead of freezing a fake NEUTRO for 6 hours.
          if (!enrichment) return;
          enrichmentCache.set(cacheKey(uncached[i]), {
            importance: enrichment.importance,
            sentiment: enrichment.sentiment,
            localizedTitle: enrichment.localizedTitle || undefined,
            aiSummary: enrichment.summary || undefined,
          });
        });
      } catch (error) {
        console.warn('[newsService] batch enrichment failed:', error);
      }
    })();

    for (const item of uncached) {
      enrichmentPending.set(cacheKey(item), work);
    }

    void work.finally(() => {
      for (const item of uncached) {
        const key = cacheKey(item);
        if (enrichmentPending.get(key) === work) {
          enrichmentPending.delete(key);
        }
      }
    });
  }

  // Wait for the work started above AND for matching work started by another
  // request. Set removes duplicates when several items share a batch.
  await Promise.all([
    ...new Set(
      items
        .map((item) => enrichmentPending.get(cacheKey(item)))
        .filter((promise): promise is Promise<void> => promise !== undefined)
    ),
  ]);

  return items.flatMap((item) => {
    const enrichment = enrichmentCache.get(cacheKey(item));
    if (!enrichment) {
      // Never leak an untranslated item into an interface using the other
      // language. Failures aren't cached, so a later request retries.
      return item.language === language ? [item] : [];
    }

    const localizedTitle = enrichment.localizedTitle?.trim();
    const localizedSummary = enrichment.aiSummary?.trim();

    return [{
      ...item,
      ...enrichment,
      // `title` and `summary` are what news cards render: returning translations
      // only in auxiliary fields left those cards in the source language.
      title: localizedTitle || item.title,
      summary:
        localizedSummary || (item.language === language ? item.summary : undefined),
      language,
      sourceLanguage: item.language,
      originalTitle: item.title,
      originalSummary: item.summary,
    }];
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

const RANGE_DAYS: Record<string, number> = {
  '1D': 1,
  '5D': 5,
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '6M': 182,
  '1Y': 365,
};

function parseDateInput(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function normalizeDaysBack(daysBack?: number, range?: string): number | undefined {
  if (typeof daysBack === 'number' && Number.isFinite(daysBack) && daysBack > 0) {
    return Math.min(Math.floor(daysBack), MAX_LOOKBACK_DAYS);
  }
  const fromRange = range ? RANGE_DAYS[range.trim().toUpperCase()] : undefined;
  return typeof fromRange === 'number' ? Math.min(fromRange, MAX_LOOKBACK_DAYS) : undefined;
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

/** Publisher names can contain hyphens ("ad-hoc-news.de"), so cut at the LAST " - ". */
function cleanTitle(title: string): string {
  // Publishers often append exchange annotations such as "(NYSE:IBM)". They are
  // metadata, not part of the readable headline.
  const trimmed = title
    .replace(
      /\s*\((?:(?:NYSE|NASDAQ|AMEX|OTC|LSE|TSX|FWB|BCS)\s*:[^)]+|[^():]+\s*:(?:NYSE|NASDAQ|AMEX|OTC|LSE|TSX|FWB|BCS))\)/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
  const idx = trimmed.lastIndexOf(' - ');
  if (idx <= 0) return trimmed;
  return trimmed.slice(0, idx).trim() || trimmed;
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

  // Google News "summaries" are usually the headline + publisher again; keep one
  // only when it adds text, so cards and push bodies don't repeat themselves.
  // Scoring below still sees the raw text.
  const summary = normalizeText(input.summary).startsWith(normalizeText(title))
    ? ''
    : input.summary;

  const keywordScore = calculateRelevanceScore(
    title,
    input.summary,
    input.profile.aliases,
    input.profile.ticker
  );
  const base = input.searchProvenance ? keywordScore + 2 : keywordScore;
  // Bias toward financial coverage and away from sponsorship/sports/CSR
  // mentions that merely carry the company name.
  const signal = financialSignal(title, input.summary);

  return {
    id: stableNewsKey(link, title),
    title,
    link,
    source: input.sourceName,
    summary,
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
      try {
        const feed = await parser.parseURL(source.build(profile));
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
 * Yahoo Finance ticker search news: keyless, ticker-scoped, dated and
 * publisher-attributed — a solid complement to the RSS feeds.
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
  /** Unix seconds. */
  datetime?: number;
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
 * Historical company news from Finnhub: free tier, up to ~1 year of dated
 * stories per ticker. Without FINNHUB_TOKEN this is a no-op, so the rest of the
 * pipeline keeps working on RSS alone.
 */
async function fetchFinnhubNews(
  profile: CompanyProfile,
  range: ResolvedDateRange
): Promise<NewsItem[]> {
  // A single accepted name, so a rotation has exactly one place to change and
  // no stale alias can silently keep working.
  const token = process.env.FINNHUB_TOKEN?.trim();
  if (!token) {
    return [];
  }

  const to = range.to ?? new Date();
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

// Live feeds tend to return only today's stories, which collapse into a single
// chart marker, so backfill is skipped only for genuinely short (1D/2D) requests.
const HISTORY_MIN_DAYS = 2;
// Bound the windows per edition so a cold 1Y request stays fast.
const HISTORY_MAX_WINDOWS = 4;

/**
 * Split the requested range into a few date windows and query each with
 * `after:`/`before:`. Keyless, and each window returns up to ~100 stories dated
 * INSIDE it, so long chart ranges get markers across real publish dates.
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
      const cacheKey =
        `${profile.ticker}|${edition.language}|${toYmd(windowFrom)}|${toYmd(windowTo)}`;
      jobs.push(
        googleHistoryCache.getOrSet(cacheKey, async () => {
          try {
            const url = googleNewsHistoricalUrl(
              profile,
              edition,
              toYmd(windowFrom),
              toYmd(windowTo)
            );
            const feed = await parser.parseURL(url);
            return mapFeedItems(feed.items ?? [], profile, edition.name, edition.language, true);
          } catch (error) {
            console.error(
              `[newsService] Google history error (${edition.language} ` +
                `${toYmd(windowFrom)}..${toYmd(windowTo)}) for ${profile.ticker}:`,
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

const byDateDesc = (a: NewsItem, b: NewsItem): number => {
  const dateA = toTimestamp(a.isoDate ?? a.pubDate);
  const dateB = toTimestamp(b.isoDate ?? b.pubDate);
  return dateB !== dateA ? dateB - dateA : b.score - a.score;
};

/**
 * In a compact (<= 7 day) view the chart shows one marker per date, so return
 * one article per publication date — the strongest-scoring one — keeping the
 * Related News list aligned with the markers.
 */
function selectOnePerDay(items: NewsItem[], totalDays: number, limit: number): NewsItem[] {
  const bestByDay = new Map<string, NewsItem>();

  for (const item of items) {
    const timestamp = toTimestamp(item.isoDate ?? item.pubDate);
    if (!timestamp) continue;

    const day = toYmd(new Date(timestamp));
    const current = bestByDay.get(day);
    if (
      !current ||
      item.score > current.score ||
      (item.score === current.score && timestamp > toTimestamp(current.isoDate ?? current.pubDate))
    ) {
      bestByDay.set(day, item);
    }
  }

  // `now - 5 days` is inclusive at both ends and can span six calendar dates.
  // Keep only the newest representatives so an older weekend story does not
  // collide with Monday's chart point.
  const dailyLimit = Math.min(limit, Math.max(1, Math.ceil(totalDays)));
  return [...bestByDay.values()].sort(byDateDesc).slice(0, dailyLimit);
}

/**
 * Pick up to `limit` items SPREAD across the requested range rather than just
 * the newest: otherwise historical coverage gets crowded out on long timeframes
 * and every chart marker clusters on the most recent days.
 */
function selectSpreadAcrossRange(
  items: NewsItem[],
  range: ResolvedDateRange,
  limit: number
): NewsItem[] {
  const { from } = range;
  const to = range.to ?? new Date();
  const totalDays = from ? (to.getTime() - from.getTime()) / ONE_DAY_MS : 0;

  if (from && totalDays <= 7) {
    return selectOnePerDay(items, totalDays, limit);
  }

  if (!from || totalDays <= HISTORY_MIN_DAYS || items.length <= limit) {
    return [...items].sort(byDateDesc).slice(0, limit);
  }

  const bucketCount = Math.min(limit, Math.ceil(totalDays));
  const bucketMs = (to.getTime() - from.getTime()) / bucketCount;

  const buckets = new Map<number, NewsItem[]>();
  for (const item of items) {
    const ts = toTimestamp(item.isoDate ?? item.pubDate);
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((ts - from.getTime()) / bucketMs))
    );
    const bucket = buckets.get(index) ?? [];
    bucket.push(item);
    buckets.set(index, bucket);
  }
  // Best story first within each bucket (score, then recency).
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.score - a.score || byDateDesc(a, b));
  }

  // Round-robin across buckets, oldest bucket first, so the selection stays
  // spread instead of draining the densest window.
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
  // with no keyword match — e.g. legal bulletins that merely list the ticker.
  // requireFinancial drops brand-only mentions (sports/sponsorship/CSR).
  const {
    companyName,
    limit = 20,
    minScore = 3,
    requireFinancial = true,
    rssOnly = false,
    enrich = false,
    language = 'en',
    sourceLanguage,
  } = options;

  const profile = await resolveCompanyProfile(ticker, companyName);
  const dateRange = resolveDateRange(options);

  // Recent coverage (RSS + Yahoo search) and dated historical coverage (Google
  // News date windows + Finnhub), all fetched in parallel.
  const [rssNews, yahooNews, googleHistory, finnhubNews] = await Promise.all([
    newsCache.getOrSet(`rss|${profile.ticker}|${profile.companyName}`, () =>
      fetchFromQuerySources(profile)
    ),
    rssOnly
      ? Promise.resolve([])
      : newsCache.getOrSet(`yahoo|${profile.ticker}`, () => fetchYahooSearchNews(profile)),
    rssOnly ? Promise.resolve([]) : fetchHistoricalGoogleNews(profile, dateRange),
    rssOnly ? Promise.resolve([]) : fetchFinnhubNews(profile, dateRange),
  ]);

  const filtered = [...rssNews, ...yahooNews, ...googleHistory, ...finnhubNews].filter(
    (item) =>
      item.link &&
      item.title &&
      (!sourceLanguage || item.language === sourceLanguage) &&
      item.score >= minScore &&
      (!requireFinancial || item.isFinancial) &&
      isWithinDateRange(item, dateRange)
  );

  const deduped = dedupeNews(filtered);
  // The live RSS panel shows every qualifying article from today, up to its
  // limit. Daily collapsing is only for historical chart-marker data.
  const top = rssOnly
    ? [...deduped].sort(byDateDesc).slice(0, limit)
    : selectSpreadAcrossRange(deduped, dateRange, limit);

  // Every returned item must be localized, not just the freshest few, or older
  // Spanish-source stories leak Spanish text into an English interface.
  return enrich ? enrichNewsItems(top, language) : top;
}
