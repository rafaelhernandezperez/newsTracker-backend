// yahooFinance data
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance();

export async function getQuote(ticker: string) {
  const quote = await yf.quote(ticker);
  return {
    symbol: quote.symbol,
    price: quote.regularMarketPrice,
    change: quote.regularMarketChangePercent,
    volume: quote.regularMarketVolume,
  };
}

export async function getHistory(ticker: string, days: number = 30) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  return yf.historical(ticker, { period1: startDate, period2: endDate });
}