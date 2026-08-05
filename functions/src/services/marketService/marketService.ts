// yahooFinance data
import YahooFinance from 'yahoo-finance2';
import { TtlCache } from '../newsService/cache';

const yf = new YahooFinance();
const quoteCache = new TtlCache<MarketQuote>(30 * 1000, 250);
const historyCache = new TtlCache<MarketHistoryPoint[]>(5 * 60 * 1000, 500);

export type MarketQuote = {
  symbol?: string;
  currency?: string | null;
  price: number | null;
  change: number | null;
  volume: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
};

export type MarketHistoryPoint = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
};

export async function getQuote(ticker: string) {
  const key = ticker.trim().toUpperCase();
  return quoteCache.getOrSet(key, async () => {
    const quote = await yf.quote(key);
    const result: MarketQuote = {
      symbol: quote.symbol,
      currency: quote.currency ?? null,
      price: quote.regularMarketPrice ?? null,
      change: quote.regularMarketChangePercent ?? null,
      volume: quote.regularMarketVolume ?? null,
      marketCap: quote.marketCap ?? null,
      trailingPE: quote.trailingPE ?? null,
      open: quote.regularMarketOpen ?? null,
      dayHigh: quote.regularMarketDayHigh ?? null,
      dayLow: quote.regularMarketDayLow ?? null,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: quote.fiftyTwoWeekLow ?? null,
    };

    return result;
  });
}

export async function getHistory(ticker: string, days: number = 30) {
<<<<<<< HEAD
  const symbol = ticker.trim().toUpperCase();
  const key = `${symbol}|${days}`;
  return historyCache.getOrSet(key, async () => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    // chart() replaces historical(), which is deprecated in yahoo-finance2 v3
    // (Yahoo shut down the underlying endpoint).
    const result = await yf.chart(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });

    return (result.quotes ?? [])
      .filter((entry) => entry.date instanceof Date)
      .map((entry): MarketHistoryPoint => ({
        date: entry.date.toISOString().slice(0, 10),
        open: entry.open ?? null,
        high: entry.high ?? null,
        low: entry.low ?? null,
        close: entry.close ?? null,
        volume: entry.volume ?? null,
      }));
  });
=======
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  // chart() replaces historical(), which is deprecated in yahoo-finance2 v3
  // (Yahoo shut down the underlying endpoint).
  const result = await yf.chart(ticker, {
    period1: startDate,
    period2: endDate,
    interval: '1d',
  });

  return (result.quotes ?? [])
    .filter((entry) => entry.date instanceof Date)
    .map((entry): MarketHistoryPoint => ({
      date: entry.date.toISOString().slice(0, 10),
      open: entry.open ?? null,
      high: entry.high ?? null,
      low: entry.low ?? null,
      close: entry.close ?? null,
      volume: entry.volume ?? null,
    }));
>>>>>>> 2cd3cbecae98bdd06938813ab28209f983779eaf
}
