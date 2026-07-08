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

/**
 * Stable, source-independent id for an article, so the SAME story collapses to
 * one document across feeds and across scheduler runs (used as the enrichment
 * cache key AND the Firestore doc id — one scheme, so a story is never enriched
 * twice or stored twice under different ids).
 *
 * Keyed on the normalized TITLE first: the same story carries different URLs on
 * Google News (redirect links), Yahoo and Finnhub, so links can't identify it
 * across sources. Falls back to the link when there is no title.
 */
export function stableNewsKey(link?: string, title?: string): string {
  const canonical = normalizeText(title?.trim() || link || '');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const map = new Map<string, NewsItem>();

  const toTimestamp = (value?: string): number => {
    const ts = new Date(value ?? '').getTime();
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  };

  for (const item of items) {
    const key = normalizeText(item.title?.trim() || item.link || '');

    if (!key) {
      continue;
    }

    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }

    const existingDate = toTimestamp(existing.isoDate ?? existing.pubDate);
    const currentDate = toTimestamp(item.isoDate ?? item.pubDate);

    // Keep the better-scored duplicate; recency only breaks ties.
    if (
      item.score > existing.score ||
      (item.score === existing.score && currentDate > existingDate)
    ) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
}
