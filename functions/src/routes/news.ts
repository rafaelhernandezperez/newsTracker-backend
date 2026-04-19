//GET /news/:ticker
import { Router, type Request, type Response } from 'express';
import { fetchNewsForTicker } from '../services/newsService/newsService';

const router = Router();

function getQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string');
  }

  return undefined;
}

router.get('/:ticker', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const companyName = getQueryString(req.query.companyName);

    const rawLimit = getQueryString(req.query.limit);
    const parsedLimit = rawLimit ? Number(rawLimit) : undefined;
    const limit =
      typeof parsedLimit === 'number' && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.floor(parsedLimit)
        : 20;

    const range =
      getQueryString(req.query.range) ??
      getQueryString(req.query.period) ??
      getQueryString(req.query.timeframe) ??
      getQueryString(req.query.window);

    const from = getQueryString(req.query.from);
    const to = getQueryString(req.query.to);
    const rawDaysBack = getQueryString(req.query.daysBack);
    const parsedDaysBack = rawDaysBack ? Number(rawDaysBack) : undefined;
    const daysBack =
      typeof parsedDaysBack === 'number' && Number.isFinite(parsedDaysBack) && parsedDaysBack > 0
        ? parsedDaysBack
        : undefined;

    const news = await fetchNewsForTicker(ticker, {
      companyName,
      limit,
      range,
      from,
      to,
      daysBack,
    });

    return res.json({
      ok: true,
      ticker: ticker.toUpperCase(),
      count: news.length,
      items: news,
    });
  } catch (error) {
    console.error('[routes/news] Error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Error fetching news',
    });
  }
});

export default router;
