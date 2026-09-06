import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  clampInt,
  requireValidTicker,
  validateCompanyName,
  validateDateInput,
  validateLanguage,
} from '../middleware/validation';
import { fetchNewsForTicker } from '../services/newsService/newsService';
import { getStoredNews } from '../services/firebaseService/firebaseService';

const router = Router();

router.use(requireAuth);

/** Express parses repeated query params into arrays; take the first string. */
function getQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string');
  }
  return undefined;
}

/** Only these windows are accepted; anything else is a client bug, not a range. */
const ALLOWED_RANGES = new Set(['1D', '5D', '1W', '1M', '3M', '6M', '1Y']);

// GET /news/:ticker/stored — AI-enriched news persisted by the tracker pipeline.
router.get('/:ticker/stored', requireValidTicker, async (req: Request, res: Response) => {
  try {
    const ticker = res.locals.ticker as string;
    const limit = clampInt(getQueryString(req.query.limit), { min: 1, max: 100, fallback: 30 });

    const items = await getStoredNews(ticker, limit);
    return res.json({ ok: true, ticker, count: items.length, items });
  } catch (error) {
    console.error('[routes/news] stored error:', error);
    return res.status(500).json({ ok: false, message: 'Error fetching stored news' });
  }
});

// GET /news/:ticker — live news, optionally AI-enriched for the chart markers.
router.get('/:ticker', requireValidTicker, async (req: Request, res: Response) => {
  try {
    const ticker = res.locals.ticker as string;

    const companyName = validateCompanyName(getQueryString(req.query.companyName));
    if (!companyName.ok) {
      return res.status(400).json({ ok: false, message: companyName.message });
    }

    const limit = clampInt(getQueryString(req.query.limit), { min: 1, max: 100, fallback: 20 });

    const rawRange =
      getQueryString(req.query.range) ??
      getQueryString(req.query.period) ??
      getQueryString(req.query.timeframe) ??
      getQueryString(req.query.window);
    const range = rawRange?.trim().toUpperCase();
    if (range && !ALLOWED_RANGES.has(range)) {
      return res.status(400).json({
        ok: false,
        message: `range must be one of: ${[...ALLOWED_RANGES].join(', ')}`,
      });
    }

    const from = validateDateInput(getQueryString(req.query.from));
    if (!from.ok) return res.status(400).json({ ok: false, message: `from: ${from.message}` });
    const to = validateDateInput(getQueryString(req.query.to));
    if (!to.ok) return res.status(400).json({ ok: false, message: `to: ${to.message}` });

    // 0 means "unset"; daysBack is separately capped inside the news service.
    const daysBack =
      clampInt(getQueryString(req.query.daysBack), { min: 0, max: 365, fallback: 0 }) || undefined;

    const rssOnly = getQueryString(req.query.rssOnly)?.toLowerCase() === 'true';
    const enrich = getQueryString(req.query.enrich)?.toLowerCase() !== 'false';

    const language = validateLanguage(
      getQueryString(req.query.lang) ?? getQueryString(req.query.language),
      'en'
    );
    if (!language.ok) {
      return res.status(400).json({ ok: false, message: language.message });
    }

    const rawSourceLanguage = getQueryString(req.query.sourceLanguage);
    const sourceLanguage = validateLanguage(rawSourceLanguage, 'en');
    if (!sourceLanguage.ok) {
      return res.status(400).json({ ok: false, message: `source ${sourceLanguage.message}` });
    }

    const news = await fetchNewsForTicker(ticker, {
      companyName: companyName.value,
      limit,
      range,
      from: from.value,
      to: to.value,
      daysBack,
      rssOnly,
      enrich,
      language: language.value,
      // Absent sourceLanguage means "no source-language filter", which is not
      // the same as defaulting it to English.
      sourceLanguage: rawSourceLanguage ? sourceLanguage.value : undefined,
    });

    return res.json({ ok: true, ticker, count: news.length, items: news });
  } catch (error) {
    console.error('[routes/news] Error:', error);
    return res.status(500).json({ ok: false, message: 'Error fetching news' });
  }
});

export default router;
