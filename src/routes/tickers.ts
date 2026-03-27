import { Router, Request, Response } from 'express';

const router = Router();

// Ejemplo de endpoint simple para solicitar tickers de seguimiento
router.get('/', (req: Request, res: Response) => {
  const symbols = typeof req.query.symbols === 'string' ? req.query.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [];

  if (symbols.length === 0) {
    return res.json({ ok: true, tickers: ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'AMZN'] });
  }

  return res.json({ ok: true, tickers: symbols });
});

router.post('/', (req: Request, res: Response) => {
  const payload = req.body;
  if (!payload || !payload.ticker) {
    return res.status(400).json({ ok: false, message: 'ticker is required in body' });
  }

  return res.json({ ok: true, ticker: String(payload.ticker).toUpperCase(), message: 'Ticker registered (in-memory placeholder)' });
});

export default router;