import express from 'express';
import cors from 'cors';
import newsRouter from './routes/news.js';
import marketRouter from './routes/market.js';
import tickersRouter from './routes/tickers.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'newsTracker-backend is running' });
});

app.use('/news', newsRouter);
app.use('/market', marketRouter);
app.use('/tickers', tickersRouter);

app.use((err, req, res, next) => {
  console.error('[Express Error]', err);
  res.status(500).json({ ok: false, message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 newsTracker-backend listening on http://localhost:${PORT}`);
});
