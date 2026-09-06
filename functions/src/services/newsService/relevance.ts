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

/**
 * Compiled once at module load: matching a term against every headline used to
 * build a fresh RegExp per term per item.
 */
function compileTerm(term: string): (text: string) => boolean {
  // Multi-word terms match as substrings; single words on word boundaries.
  if (term.includes(' ')) return (text) => text.includes(term);
  const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
  return (text) => pattern.test(text);
}

const FINANCE_MATCHERS = FINANCE_TERMS.map(compileTerm);
const NOISE_MATCHERS = NOISE_TERMS.map(compileTerm);

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

  for (const matches of FINANCE_MATCHERS) {
    if (matches(normalizedTitle)) {
      finance += 3;
      financeHits += 1;
    } else if (matches(normalizedSummary)) {
      finance += 1;
      financeHits += 1;
    }
  }

  for (const matches of NOISE_MATCHERS) {
    if (matches(normalizedTitle)) {
      noise += 4;
    } else if (matches(normalizedSummary)) {
      noise += 2;
    }
  }

  const delta = finance - noise;
  // Require a real finance term AND a net-positive signal, so a sponsorship
  // penalty vetoes a weak or incidental finance match.
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
  const normalizedTicker = ticker.toLowerCase();

  let score = 0;

  for (const alias of aliases) {
    const cleanAlias = normalizeText(alias);
    if (!cleanAlias) continue;

    const regex = new RegExp(`\\b${escapeRegExp(cleanAlias)}\\b`, 'i');
    const isTicker = cleanAlias === normalizedTicker;

    if (regex.test(normalizedTitle)) score += isTicker ? 6 : 4;
    if (regex.test(normalizedSummary)) score += isTicker ? 3 : 2;
  }

  return score;
}
