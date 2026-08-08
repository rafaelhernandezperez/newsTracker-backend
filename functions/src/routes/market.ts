import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { clampInt, requireValidTicker } from '../middleware/validation';
import { getQuote, getHistory } from '../services/marketService/marketService.js';

const router = Router();

router.use(requireAuth);

router.get('/:ticker', requireValidTicker, async (req: Request, res: Response) => {
  try {
    const ticker = res.locals.ticker as string;
    // Cap at ~10 years so absurd values can't produce runaway date math.
    const days = clampInt(req.query.days, { min: 1, max: 3650, fallback: 30 });

    const [quote, history] = await Promise.all([
      getQuote(ticker),
      getHistory(ticker, days),
    ]);

    const chart = history
      .filter((point) => point.close !== null)
      .map((point) => ({
        date: point.date,
        value: point.close,
      }));

    return res.json({
      ok: true,
      ticker,
      range: { days, points: history.length },
      quote,
      chart,
      history,
    });
  } catch (error) {
    console.error('[routes/market] Error:', error);
    return res.status(500).json({ ok: false, message: 'Error fetching market data' });
  }
});

export default router;