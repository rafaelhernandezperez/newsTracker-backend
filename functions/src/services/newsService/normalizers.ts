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

export function createNewsId(source: string, link: string, title: string): string {
  return crypto
    .createHash('sha256')
    .update(`${source}|${link}|${title}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Stable, source-independent id for an article, so the SAME story collapses
 * to one document across feeds and across scheduler runs (used as the Firestore
 * doc id for persistence/dedup). Based on the canonical link, falling back to title.
 */
export function stableNewsKey(link?: string, title?: string): string {
  const canonical = normalizeText(link?.trim() || title || '');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const map = new Map<string, NewsItem>();

  const toTimestamp = (value?: string): number => {
    const ts = new Date(value ?? '').getTime();
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  };

  for (const item of items) {
    const keySource = item.link?.trim() || item.title || '';
    const key = normalizeText(keySource);

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

    if (item.score > existing.score || currentDate > existingDate) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
}