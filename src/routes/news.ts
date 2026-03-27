//GET /news/:ticker
import { Router, type Request, type Response } from 'express';
import { fetchNewsForTicker } from '../services/newsService/newsService';

const router = Router();

router.get('/:ticker', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const companyName =
      typeof req.query.companyName === 'string'
        ? req.query.companyName
        : undefined;

    const limit =
      typeof req.query.limit === 'string'
        ? Number(req.query.limit)
        : 20;

    const news = await fetchNewsForTicker(ticker, {
      companyName,
      limit,
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