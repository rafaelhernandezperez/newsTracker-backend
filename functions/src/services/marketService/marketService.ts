// yahooFinance data
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance();

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
  const quote = await yf.quote(ticker);
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
}

export async function getHistory(ticker: string, days: number = 30) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const history = await yf.historical(ticker, { period1: startDate, period2: endDate });

  return history
    .filter((entry) => entry.date instanceof Date)
    .map((entry): MarketHistoryPoint => ({
      date: entry.date.toISOString().slice(0, 10),
      open: entry.open ?? null,
      high: entry.high ?? null,
      low: entry.low ?? null,
      close: entry.close ?? null,
      volume: entry.volume ?? null,
    }));
}
