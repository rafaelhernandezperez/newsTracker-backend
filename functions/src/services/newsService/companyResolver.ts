import YahooFinance from 'yahoo-finance2';
import { TtlCache } from './cache';
import type { CompanyProfile } from './types';

const yf = new YahooFinance();

// Resolved profiles are stable; cache them for a day.
const profileCache = new TtlCache<CompanyProfile>(24 * 60 * 60 * 1000);

// Strip the company-name noise that hurts headline matching.
const NAME_SUFFIXES =
  /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|sa|s\.a\.|ag|nv|n\.v\.|holding|holdings|group|the)\b/gi;

function buildAliases(ticker: string, companyName?: string): string[] {
  const aliases = new Set<string>([ticker.trim().toUpperCase()]);

  if (companyName) {
    const name = companyName.trim();
    aliases.add(name);

    // "Apple Inc." -> "Apple"
    const stripped = name
      .replace(NAME_SUFFIXES, '')
      .replace(/[.,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped.length >= 2) {
      aliases.add(stripped);
    }

    // First token of the stripped name ("Berkshire" from "Berkshire Hathaway").
    const firstToken = stripped.split(' ')[0];
    if (firstToken && firstToken.length >= 4) {
      aliases.add(firstToken);
    }
  }

  return Array.from(aliases).filter((alias) => alias.length >= 2);
}

/**
 * Resolve a ticker to a company profile, looking up the real company name when
 * the caller didn't supply one. This is what lets "AAPL" match "Apple".
 */
export async function resolveCompanyProfile(
  ticker: string,
  companyName?: string
): Promise<CompanyProfile> {
  const cleanTicker = ticker.trim().toUpperCase();
  const cacheKey = `${cleanTicker}|${companyName ?? ''}`;

  return profileCache.getOrSet(cacheKey, async () => {
    let resolvedName = companyName?.trim();

    if (!resolvedName) {
      try {
        const quote = await yf.quote(cleanTicker);
        resolvedName =
          quote?.longName?.trim() ||
          quote?.shortName?.trim() ||
          quote?.displayName?.trim() ||
          undefined;
      } catch (error) {
        console.warn(`[companyResolver] Could not resolve name for ${cleanTicker}:`, error);
      }
    }

    return {
      ticker: cleanTicker,
      companyName: resolvedName ?? '',
      aliases: buildAliases(cleanTicker, resolvedName),
    };
  });
}
