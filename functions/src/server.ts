import { onRequest } from 'firebase-functions/v2/https';
import app from './index.js';

export const api = onRequest(
  {
    region: 'europe-west1',
  },
  app
);