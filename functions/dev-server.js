/**
 * Local dev server for frontend integration.
 *
 * Runs the same Express app used in production (lib/index.js) on a plain HTTP
 * port, so the Angular app (http://localhost:4200) can hit it without the
 * Firebase emulator suite.
 *
 *   npm run dev                 # build + start on http://localhost:8080
 *
 * Credentials:
 *   - GET /news/:ticker (live news) needs NO credentials.
 *   - Auth + Firestore routes (/watchlist, /devices, /news/:ticker/stored) and
 *     the tracker need Firebase Admin credentials. Drop a service-account key at
 *     functions/serviceAccount.json (gitignored) and it is picked up automatically.
 *
 * Dev-only helper:
 *   POST /dev/track   -> runs ONE tracking cycle on demand (needs credentials),
 *                        so you can verify news enrichment + FCM push end-to-end
 *                        without waiting for the 15-minute schedule.
 */
const fs = require('fs');
const path = require('path');

process.env.GOOGLE_CLOUD_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT || 'financialnewstracker';

// Auto-load a local service-account key if present (so Firestore/Auth work).
const keyPath = path.join(__dirname, 'serviceAccount.json');
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(keyPath)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
  console.log('[dev-server] using service account at functions/serviceAccount.json');
}
const hasCreds = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

// Load HF_TOKEN from the repo-root .env (used by AI enrichment in the tracker).
const rootEnv = path.join(__dirname, '..', '.env');
if (fs.existsSync(rootEnv)) {
  for (const line of fs.readFileSync(rootEnv, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const app = require('./lib/index.js').default;

// Dev-only manual tracker trigger.
app.post('/dev/track', async (_req, res) => {
  try {
    const { runTrackingCycle } = require('./lib/services/trackerService/trackerService.js');
    const summary = await runTrackingCycle();
    return res.json({ ok: true, summary });
  } catch (error) {
    console.error('[dev-server] /dev/track failed:', error);
    return res.status(500).json({ ok: false, message: String(error) });
  }
});

// Dev-only manual daily-digest trigger (runs ONE digest cycle on demand).
app.post('/dev/digest', async (_req, res) => {
  try {
    const { runDailyDigestCycle } = require('./lib/services/digestService/digestService.js');
    const summary = await runDailyDigestCycle();
    return res.json({ ok: true, summary });
  } catch (error) {
    console.error('[dev-server] /dev/digest failed:', error);
    return res.status(500).json({ ok: false, message: String(error) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[dev-server] listening on http://localhost:${PORT}`);
  console.log(`[dev-server] credentials: ${hasCreds ? 'loaded' : 'NONE (only /news/:ticker works)'}`);
  console.log(`[dev-server] live news:   GET  http://localhost:${PORT}/news/AAPL?limit=10`);
  console.log(`[dev-server] run tracker: POST http://localhost:${PORT}/dev/track`);
});
