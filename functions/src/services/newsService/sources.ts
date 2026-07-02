import type { CompanyProfile, FeedSource } from './types';

/**
 * Per-ticker query sources.
 *
 * The previous implementation pulled a fixed set of GENERIC market feeds
 * (CNBC top news, Investing all news, ...) and then filtered them down to the
 * ticker. Generic feeds rarely name a specific company, so recall was terrible.
 *
 * Instead we now build SEARCH feeds that take the company query as a parameter,
 * so every source returns news that is already about that company. This is the
 * single biggest lever on "not enough news".
 */

type QuerySource = {
  name: string;
  language: string;
  /**
   * 'search' = the feed is a literal per-company search (every item is about
   * the company, so provenance alone is evidence of relevance).
   * 'feed' = a per-ticker feed that may pad with general market stories, so it
   * must earn relevance via keyword matching.
   */
  kind: 'search' | 'feed';
  /** Build the feed URL for a given resolved company profile. */
  build: (profile: CompanyProfile) => string;
};

/**
 * Google News search RSS. Keyless, enormous coverage (thousands of outlets),
 * supports per-language editions. We run one EN edition and one ES edition.
 */
function googleNewsUrl(query: string, hl: string, gl: string, ceid: string): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

export type GoogleEdition = { name: string; language: string; hl: string; gl: string; ceid: string };

export const GOOGLE_EDITIONS: GoogleEdition[] = [
  { name: 'Google News (EN)', language: 'en', hl: 'en-US', gl: 'US', ceid: 'US:en' },
  { name: 'Google News (ES)', language: 'es', hl: 'es-419', gl: 'ES', ceid: 'ES:es' },
];

/**
 * Google News search RSS constrained to a date window via the `after:`/`before:`
 * query operators. This is what lets the chart show news at their REAL historical
 * publish dates (keyless; returns up to ~100 dated items per window).
 */
export function googleNewsHistoricalUrl(
  profile: CompanyProfile,
  edition: GoogleEdition,
  fromYmd: string,
  toYmd: string
): string {
  const query = `${buildSearchQuery(profile)} after:${fromYmd} before:${toYmd}`;
  return googleNewsUrl(query, edition.hl, edition.gl, edition.ceid);
}

/**
 * Build a focused search query from a company profile.
 * Prefers the resolved company name, falls back to the ticker, and always
 * anchors with the ticker so we keep finance-relevant matches.
 */
export function buildSearchQuery(profile: CompanyProfile): string {
  const name = profile.companyName?.trim();
  if (name) {
    // "Apple Inc" OR AAPL  -> name in quotes keeps it as a phrase
    return `"${name}" OR ${profile.ticker}`;
  }
  // No resolved name: search the ticker as a stock to avoid generic word hits.
  return `${profile.ticker} stock`;
}

export const QUERY_SOURCES: QuerySource[] = [
  {
    name: 'Google News (EN)',
    language: 'en',
    kind: 'search',
    build: (profile) =>
      googleNewsUrl(buildSearchQuery(profile), 'en-US', 'US', 'US:en'),
  },
  {
    name: 'Google News (ES)',
    language: 'es',
    kind: 'search',
    build: (profile) =>
      googleNewsUrl(buildSearchQuery(profile), 'es-419', 'ES', 'ES:es'),
  },
  {
    name: 'Yahoo Finance Headlines',
    language: 'en',
    kind: 'feed',
    build: (profile) =>
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(
        profile.ticker
      )}&region=US&lang=en-US`,
  },
];

/**
 * Broad market feeds, kept for a general (non-ticker) market overview endpoint.
 * NOT used for per-ticker retrieval anymore.
 */
export const MARKET_FEED_SOURCES: FeedSource[] = [
  {
    name: 'Yahoo Finance',
    url: 'https://finance.yahoo.com/news/rssindex',
    language: 'en',
    category: 'financial',
  },
  {
    name: 'CNBC Top News',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    language: 'en',
    category: 'financial',
  },
  {
    name: 'MarketWatch MarketPulse',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',
    language: 'en',
    category: 'markets',
  },
  {
    name: 'Expansion Mercados',
    url: 'https://e00-expansion.uecdn.es/rss/mercados.xml',
    language: 'es',
    category: 'markets',
  },
];
