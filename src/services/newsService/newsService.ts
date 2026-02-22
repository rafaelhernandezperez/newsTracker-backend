// WebScrapping
import Parser from 'rss-parser';

const parser = new Parser();
const FEEDS = [
  'https://feeds.finance.yahoo.com/rss/2.0/headline',
  'https://www.marketwatch.com/rss/topstories',
];

export async function fetchNewsForTicker(ticker: string) {
  const allItems = [];
  for (const feedUrl of FEEDS) {
    const feed = await parser.parseURL(feedUrl);
    const relevant = feed.items.filter(item =>
      item.title?.toLowerCase().includes(ticker.toLowerCase())
    );
    allItems.push(...relevant);
  }
  return allItems;
}