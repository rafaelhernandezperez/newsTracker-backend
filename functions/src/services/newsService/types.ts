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
};