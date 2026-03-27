import type { CompanyProfile } from './types';

/**
 * Versión simple:
 * - siempre usa el ticker
 * - si te pasan companyName, la añade
 * - genera aliases básicos
 */
export function buildCompanyProfile(
  ticker: string,
  companyName?: string
): CompanyProfile {
  const cleanTicker = ticker.trim().toUpperCase();
  const aliases = new Set<string>();

  aliases.add(cleanTicker);
  aliases.add(cleanTicker.toLowerCase());

  if (companyName) {
    const normalizedName = companyName.trim();
    const lower = normalizedName.toLowerCase();

    aliases.add(normalizedName);
    aliases.add(lower);

    // Variantes comunes
    aliases.add(lower.replace(/\binc\.?\b/g, '').trim());
    aliases.add(lower.replace(/\bcorp\.?\b/g, '').trim());
    aliases.add(lower.replace(/\bcorporation\b/g, '').trim());
    aliases.add(lower.replace(/\bltd\.?\b/g, '').trim());
    aliases.add(lower.replace(/\bplc\b/g, '').trim());
    aliases.add(lower.replace(/\bsa\b/g, '').trim());
  }

  return {
    ticker: cleanTicker,
    companyName: companyName ?? '',
    aliases: Array.from(aliases).filter(Boolean),
  };
}