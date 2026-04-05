import { getQuote, getHistory } from './marketService';

async function test() {
  try {
    const quote = await getQuote('AAPL');
    console.log('QUOTE:', quote);

    const history = await getHistory('AAPL', 7);
    console.log('HISTORY:', history);
  } catch (error) {
    console.error('Error:', error);
  }
}

test();