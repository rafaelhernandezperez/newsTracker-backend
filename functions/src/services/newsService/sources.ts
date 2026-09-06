import type { CompanyProfile } from './types';

/**
 * Per-ticker query sources. These are SEARCH feeds parameterised by the company
 * query, so every source returns news already about that company — generic
 * market feeds rarely name a specific one, which wrecked recall.
 */
type QuerySource = {
  name: string;
  language: string;
  /**
   * 'search' = a literal per-company search, so provenance alone is evidence of
   * relevance. 'feed' = a per-ticker feed that may pad with general market
   * stories, so it must earn relevance via keyword matching.
   */
  kind: 'search' | 'feed';
  /** Build the feed URL for a given resolved company profile. */
  build: (profile: CompanyProfile) => string;
};

export type GoogleEdition = { name: string; language: string; hl: string; gl: string; ceid: string };

/** Keyless, enormous coverage (thousands of outlets), per-language editions. */
function googleNewsUrl(query: string, hl: string, gl: string, ceid: string): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

export const GOOGLE_EDITIONS: GoogleEdition[] = [
  { name: 'Google News', language: 'en', hl: 'en-US', gl: 'US', ceid: 'US:en' },
  { name: 'Google News', language: 'es', hl: 'es-419', gl: 'ES', ceid: 'ES:es' },
];

/**
 * Google News search constrained to a date window via the `after:`/`before:`
 * operators. This is what lets the chart show news at their real historical
 * publish dates (keyless; up to ~100 dated items per window).
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
 * Prefer the resolved company name (quoted, so it stays a phrase) but always
 * anchor with the ticker, which keeps matches finance-relevant.
 */
function buildSearchQuery(profile: CompanyProfile): string {
  const name = profile.companyName?.trim();
  if (name) {
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
    build: (profile) => googleNewsUrl(buildSearchQuery(profile), 'en-US', 'US', 'US:en'),
  },
  {
    name: 'Google News (ES)',
    language: 'es',
    kind: 'search',
    build: (profile) => googleNewsUrl(buildSearchQuery(profile), 'es-419', 'ES', 'ES:es'),
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
