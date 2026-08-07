//GET /news/:ticker
import { Router, type Request, type Response } from 'express';
import { fetchNewsForTicker } from '../services/newsService/newsService';
import { getStoredNews } from '../services/firebaseService/firebaseService';

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

// GET /news/:ticker/stored - AI-enriched news persisted by the tracker pipeline
router.get('/:ticker/stored', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const rawLimit = getQueryString(req.query.limit);
    const parsedLimit = rawLimit ? Number(rawLimit) : undefined;
    const limit =
      typeof parsedLimit === 'number' && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), 100)
        : 30;

    const items = await getStoredNews(ticker, limit);
    return res.json({ ok: true, ticker: ticker.toUpperCase(), count: items.length, items });
  } catch (error) {
    console.error('[routes/news] stored error:', error);
    return res.status(500).json({ ok: false, message: 'Error fetching stored news' });
  }
});

router.get('/:ticker', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const companyName = getQueryString(req.query.companyName);

    const rawLimit = getQueryString(req.query.limit);
    const parsedLimit = rawLimit ? Number(rawLimit) : undefined;
    const limit =
      typeof parsedLimit === 'number' && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), 100)
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
    const rssOnly = getQueryString(req.query.rssOnly)?.toLowerCase() === 'true';
    const enrich = getQueryString(req.query.enrich)?.toLowerCase() !== 'false';
    const requestedLanguage =
      getQueryString(req.query.lang) ?? getQueryString(req.query.language) ?? 'en';
    if (requestedLanguage !== 'en' && requestedLanguage !== 'es') {
      return res.status(400).json({
        ok: false,
        message: 'Language must be "en" or "es"',
      });
    }
    const requestedSourceLanguage = getQueryString(req.query.sourceLanguage);
    if (
      requestedSourceLanguage &&
      requestedSourceLanguage !== 'en' &&
      requestedSourceLanguage !== 'es'
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Source language must be "en" or "es"',
      });
    }
    const sourceLanguage: 'en' | 'es' | undefined =
      requestedSourceLanguage === 'en' || requestedSourceLanguage === 'es'
        ? requestedSourceLanguage
        : undefined;

    const news = await fetchNewsForTicker(ticker, {
      companyName,
      limit,
      range,
      from,
      to,
      daysBack,
      rssOnly,
      // Attach AI importance + sentiment so the frontend chart can size/color
      // its news markers. Cached per item, so repeat requests stay cheap.
      enrich,
      language: requestedLanguage,
      sourceLanguage,
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
