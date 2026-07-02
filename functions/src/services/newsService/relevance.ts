import { normalizeText } from './normalizers';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Terms that mark a story as genuinely financial / market-relevant (EN + ES).
 * Deliberately excludes generic words inherent to a company's description
 * (e.g. "bank"/"banco") so a bank's name alone doesn't read as financial news.
 */
const FINANCE_TERMS = [
  // English
  'stock', 'stocks', 'share', 'shares', 'shareholder', 'earnings', 'revenue',
  'profit', 'loss', 'dividend', 'buyback', 'guidance', 'forecast', 'outlook',
  'analyst', 'rating', 'upgrade', 'downgrade', 'price target', 'valuation',
  'market cap', 'acquisition', 'merger', 'takeover', 'ipo', 'bond', 'bonds',
  'quarterly', 'earnings call', 'sec filing', 'regulator', 'lawsuit',
  'investor', 'investors', 'investment', 'trading', 'nasdaq', 'nyse',
  'ceo', 'cfo', 'debt', 'equity',
  // Spanish
  'accion', 'acciones', 'accionista', 'bolsa', 'cotiza', 'cotizacion',
  'dividendo', 'dividendos', 'beneficio', 'beneficios', 'perdidas', 'resultados',
  'ingresos', 'facturacion', 'fusion', 'adquisicion', 'opa', 'analista',
  'analistas', 'calificacion', 'inversion', 'inversores', 'inversor', 'deuda',
  'bono', 'bonos', 'trimestre', 'trimestral', 'capitalizacion', 'valoracion',
  'rentabilidad', 'sancion', 'multa', 'bce', 'ganancias', 'cotizada',
];

/** Terms that mark sponsorship / sports / CSR brand mentions, not company news. */
const NOISE_TERMS = [
  'stadium', 'estadio', 'liga', 'futbol', 'football', 'soccer', 'partido',
  'gol', 'deporte', 'deportivo', 'torneo', 'sponsor', 'sponsorship',
  'patrocinio', 'patrocina', 'donacion', 'donaciones', 'charity', 'solidario',
  'solidaria', 'voluntariado', 'beca', 'becas', 'concierto', 'festival',
];

export type FinancialSignal = {
  /** Net contribution to the relevance score (finance terms minus noise). */
  delta: number;
  /** True if at least one financial term is present. */
  isFinancial: boolean;
};

/**
 * Measure how "financial" a story is. Finance terms add to the score (weighted
 * by where they appear); sponsorship/sports/CSR terms subtract. `isFinancial`
 * is the gate the news service uses to keep only market-relevant coverage.
 */
export function financialSignal(title: string, summary: string): FinancialSignal {
  const normalizedTitle = normalizeText(title);
  const normalizedSummary = normalizeText(summary);

  let finance = 0;
  let financeHits = 0;
  let noise = 0;

  const has = (text: string, term: string): boolean =>
    term.includes(' ')
      ? text.includes(term)
      : new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(text);

  for (const term of FINANCE_TERMS) {
    if (has(normalizedTitle, term)) {
      finance += 3;
      financeHits += 1;
    } else if (has(normalizedSummary, term)) {
      finance += 1;
      financeHits += 1;
    }
  }

  for (const term of NOISE_TERMS) {
    if (has(normalizedTitle, term)) {
      noise += 4;
    } else if (has(normalizedSummary, term)) {
      noise += 2;
    }
  }

  const delta = finance - noise;
  // Require a real finance term AND a net-positive signal, so a sports/sponsorship
  // penalty vetoes a weak/incidental finance match.
  return { delta, isFinancial: financeHits > 0 && delta > 0 };
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