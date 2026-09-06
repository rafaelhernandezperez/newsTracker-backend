import crypto from 'node:crypto';
import type { NewsItem } from './types';

export function normalizeText(value?: string): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Epoch ms for a feed date, or 0 when it is absent or unparseable. */
export function toTimestamp(value?: string): number {
  const ts = new Date(value ?? '').getTime();
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

/**
 * Canonical form identifying one story across feeds. Keyed on the TITLE first:
 * the same story carries different URLs on Google News (redirect links), Yahoo
 * and Finnhub, so links cannot identify it. Falls back to the link.
 */
function canonicalize(link?: string, title?: string): string {
  return normalizeText(title?.trim() || link || '');
}

/**
 * Stable, source-independent article id — the enrichment cache key AND the
 * Firestore doc id, so a story is never enriched or stored twice.
 */
export function stableNewsKey(link?: string, title?: string): string {
  return crypto.createHash('sha256').update(canonicalize(link, title)).digest('hex').slice(0, 32);
}

export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const map = new Map<string, NewsItem>();

  for (const item of items) {
    const key = canonicalize(item.link, item.title);
    if (!key) continue;

    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }

    // Keep the better-scored duplicate; recency only breaks ties.
    const isBetter =
      item.score > existing.score ||
      (item.score === existing.score &&
        toTimestamp(item.isoDate ?? item.pubDate) >
          toTimestamp(existing.isoDate ?? existing.pubDate));
    if (isBetter) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
}
