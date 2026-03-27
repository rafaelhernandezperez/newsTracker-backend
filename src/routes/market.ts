import { Router, type Request, type Response } from 'express';
import { getQuote, getHistory } from '../services/marketService/marketService.js';

const router = Router();

router.get('/:ticker', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const days = Number(req.query.days) || 30;

    const [quote, history] = await Promise.all([
      getQuote(ticker),
      getHistory(ticker, days),
    ]);

    return res.json({ ok: true, ticker: ticker.toUpperCase(), quote, history });
  } catch (error) {
    console.error('[routes/market] Error:', error);
    return res.status(500).json({ ok: false, message: 'Error fetching market data' });
  }
});

export default router;