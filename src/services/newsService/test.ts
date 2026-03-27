import { fetchNewsForTicker } from './newsService';

async function test() {
  const news = await fetchNewsForTicker('AAPL', {
    companyName: 'Apple',
    limit: 10,
    minScore: 1,
  });

  console.log('TOTAL NEWS:', news.length);
  console.log(JSON.stringify(news.slice(0, 5), null, 2));
}

test().catch(console.error);