import { Router, Request, Response } from 'express';
import YahooFinance from 'yahoo-finance2';
import { TtlCache } from '../services/newsService/cache';

const router = Router();
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export type TickerSearchResult = {
  symbol: string;
  name: string;
  exchange?: string;
  sector?: string;
};

// Search results for a query barely change; cache aggressively.
const searchCache = new TtlCache<TickerSearchResult[]>(24 * 60 * 60 * 1000);

type YahooSearchQuote = {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  sectorDisp?: string;
  quoteType?: string;
  isYahooFinance?: boolean;
};

/**
 * GET /tickers/search?q=apple — resolve free-text (company name or symbol) to
 * real listed equities via Yahoo Finance, so users can follow ANY company, not
 * just a hardcoded catalogue.
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 2) {
      return res.json({ ok: true, query, items: [] });
    }

    const items = await searchCache.getOrSet(query.toLowerCase(), async () => {
      // validateResult:false loosens the return type; cast to the fields we read.
      const result = (await yf.search(
        query,
        { quotesCount: 10, newsCount: 0 },
        { validateResult: false }
      )) as { quotes?: YahooSearchQuote[] };
      const quotes: YahooSearchQuote[] = Array.isArray(result?.quotes) ? result.quotes : [];

      return quotes
        .filter((quote) => quote.quoteType === 'EQUITY' && quote.symbol && quote.isYahooFinance !== false)
        .map((quote): TickerSearchResult => ({
          symbol: String(quote.symbol).toUpperCase(),
          name: quote.longname?.trim() || quote.shortname?.trim() || String(quote.symbol),
          exchange: quote.exchDisp,
          sector: quote.sectorDisp,
        }))
        .slice(0, 8);
    });

    return res.json({ ok: true, query, items });
  } catch (error) {
    console.error('[routes/tickers] search error:', error);
    return res.status(500).json({ ok: false, message: 'Error searching tickers' });
  }
});

export default router;
