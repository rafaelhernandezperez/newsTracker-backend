export type FeedSource = {
  name: string;
  url: string;
  language?: string;
  category?: string;
};

export type CompanyProfile = {
  ticker: string ;
  companyName?: string;
  aliases: string[];
};

export type NewsItem = {
  id: string;
  title: string;
  link: string;
  source: string;
  summary?: string | undefined;
  pubDate?: string | undefined;
  isoDate?: string | undefined;
  language?: string | undefined;
  matchedTickers: string[];
  score: number;
  /** True if the story contains genuine financial/market terms (not brand-only mentions). */
  isFinancial?: boolean;
  /** AI-classified market impact. Drives the chart marker SIZE on the frontend. */
  importance?: 'MUY_IMPORTANTE' | 'IMPORTANTE' | 'NEUTRO' | 'POCO_RELEVANTE';
  /** AI-classified tone. Drives the chart marker COLOR on the frontend. */
  sentiment?: 'POSITIVO' | 'NEGATIVO' | 'NEUTRO';
};