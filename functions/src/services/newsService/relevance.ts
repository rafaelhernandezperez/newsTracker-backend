import { normalizeText } from './normalizers';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countMatches(text: string, aliases: string[]): string[] {
  const normalized = normalizeText(text);
  const matches: string[] = [];

  for (const alias of aliases) {
    const cleanAlias = normalizeText(alias);
    if (!cleanAlias) continue;

    const regex = new RegExp(`\\b${escapeRegExp(cleanAlias)}\\b`, 'i');
    if (regex.test(normalized)) {
      matches.push(alias);
    }
  }

  return matches;
}

export function calculateRelevanceScore(
  title: string,
  summary: string,
  aliases: string[],
  ticker: string
): number {
  const normalizedTitle = normalizeText(title);
  const normalizedSummary = normalizeText(summary);

  let score = 0;

  for (const alias of aliases) {
    const cleanAlias = normalizeText(alias);
    if (!cleanAlias) continue;

    const regex = new RegExp(`\\b${escapeRegExp(cleanAlias)}\\b`, 'i');

    if (regex.test(normalizedTitle)) {
      score += cleanAlias === ticker.toLowerCase() ? 6 : 4;
    }

    if (regex.test(normalizedSummary)) {
      score += cleanAlias === ticker.toLowerCase() ? 3 : 2;
    }
  }

  return score;
}