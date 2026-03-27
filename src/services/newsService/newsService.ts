// WebScrapping
import Parser from 'rss-parser';
import { FEED_SOURCES } from './sources';
import { buildCompanyProfile } from './companyResolver';
import { calculateRelevanceScore, countMatches } from './relevance';
import { createNewsId, dedupeNews } from './normalizers';
import type { NewsItem } from './types';

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'financial-news-app/1.0',
  },
});

type FetchNewsOptions = {
  companyName?: string;
  limit?: number;
  minScore?: number;
};

export async function fetchNewsForTicker(
  ticker: string,
  options: FetchNewsOptions = {}
): Promise<NewsItem[]> {
  const { companyName, limit = 20, minScore = 4 } = options;

  const profile = buildCompanyProfile(ticker, companyName);

  const allResults = await Promise.all(
    FEED_SOURCES.map(async (source) => {
      try {
        const feed = await parser.parseURL(source.url);

        return (feed.items ?? []).map((item) => {
          const title = item.title?.trim() ?? '';
          const summary =
            item.contentSnippet?.trim() ||
            item.content?.trim() ||
            '';
          const link = item.link?.trim() ?? '';

          const combinedText = `${title} ${summary}`;
          const matches = countMatches(combinedText, profile.aliases);
          const score = calculateRelevanceScore(
            title,
            summary,
            profile.aliases,
            profile.ticker
          );

          const newsItem: NewsItem = {
            id: createNewsId(source.name, link, title),
            title,
            link,
            source: source.name,
            summary,
            pubDate: item.pubDate,
            isoDate: item.isoDate,
            language: source.language,
            matchedTickers: matches.length > 0 ? [profile.ticker] : [],
            score,
          };

          return newsItem;
        });
      } catch (error) {
        console.error(`[newsService] Error con feed ${source.name}:`, error);
        return [];
      }
    })
  );

  const allNews = allResults.flat();

  const filtered = allNews.filter(
    (item) =>
      item.link &&
      item.title &&
      item.matchedTickers.length > 0 &&
      item.score >= minScore
  );

  const deduped = dedupeNews(filtered);

  const toTimestamp = (value?: string): number => {
    const ts = new Date(value ?? '').getTime();
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  };

  const sorted = deduped.sort((a, b) => {
    const dateA = toTimestamp(a.isoDate ?? a.pubDate);
    const dateB = toTimestamp(b.isoDate ?? b.pubDate);

    if (dateB !== dateA) return dateB - dateA;
    return b.score - a.score;
  });

  return sorted.slice(0, limit);
}