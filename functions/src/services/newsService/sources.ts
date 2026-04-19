import type { FeedSource } from './types.ts';

export const FEED_SOURCES: FeedSource[] = [
  // Broad financial and business coverage
  {
    name: 'Investing All News',
    url: 'https://www.investing.com/rss/news.rss',
    language: 'en',
    category: 'financial',
  },
  {
    name: 'Investing Company News',
    url: 'https://www.investing.com/rss/news_285.rss',
    language: 'en',
    category: 'company',
  },
  {
    name: 'Yahoo Finance',
    url: 'https://finance.yahoo.com/news/rssindex',
    language: 'en',
    category: 'financial',
  },
  {
    name: 'CNBC Top News',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    language: 'en',
    category: 'financial',
  },
  {
    name: 'CNBC Finance',
    url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html',
    language: 'en',
    category: 'financial',
  },
  {
    name: 'MarketWatch MarketPulse',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',
    language: 'en',
    category: 'markets',
  },
  {
    name: 'Seeking Alpha Market Currents',
    url: 'https://seekingalpha.com/market_currents.xml',
    language: 'en',
    category: 'markets',
  },
  {
    name: 'NPR Business',
    url: 'https://feeds.npr.org/1006/rss.xml',
    language: 'en',
    category: 'financial',
  },

  // Official policy and regulatory sources
  {
    name: 'Federal Reserve Press Releases',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    language: 'en',
    category: 'policy',
  },
  {
    name: 'SEC Press Releases',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    language: 'en',
    category: 'regulation',
  },

  // Spanish-language coverage
  {
    name: 'Benzinga Espana',
    url: 'https://es.benzinga.com/feed/',
    language: 'es',
    category: 'financial',
  },
  {
    name: 'Expansion Empresas',
    url: 'https://e00-expansion.uecdn.es/rss/empresas.xml',
    language: 'es',
    category: 'company',
  },
  {
    name: 'Expansion Mercados',
    url: 'https://e00-expansion.uecdn.es/rss/mercados.xml',
    language: 'es',
    category: 'markets',
  },
];
