import type { FeedSource } from './types.ts';

export const FEED_SOURCES: FeedSource[] = [
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
    name: 'Benzinga Latest',
    url: 'https://www.benzinga.com/latest?feed=rss&page=1',
    language: 'en',
    category: 'financial',
  },
  {
    name: 'Benzinga España',
    url: 'https://es.benzinga.com/feed/',
    language: 'es',
    category: 'financial',
  },
];