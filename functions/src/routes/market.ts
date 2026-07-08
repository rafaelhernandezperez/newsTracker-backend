import { Router, type Request, type Response } from 'express';
import { getQuote, getHistory } from '../services/marketService/marketService.js';

const router = Router();

router.get('/:ticker', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const requestedDays = Number(req.query.days);
    // Cap at ~10 years so absurd values can't produce runaway date math.
    const days =
      Number.isFinite(requestedDays) && requestedDays > 0
        ? Math.min(Math.floor(requestedDays), 3650)
        : 30;

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
      ticker: ticker.toUpperCase(),
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
