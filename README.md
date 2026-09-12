# NewsTracker — Backend

Serverless API and background pipeline behind **NewsTracker**, a financial news tracker that
watches a user's portfolio, pulls company news from public feeds, classifies it with an LLM
(sentiment + importance, EN/ES), stores it, and pushes only what matters — high-impact stories,
>3% price moves, and one daily digest.

Firebase Cloud Functions v2 · TypeScript · Express · Firestore · Cloud Messaging · Cloud Scheduler.

> The Angular client lives in a separate repository:
> [newsTracker-frontend](https://github.com/rafaelhernandezperez/newsTracker-frontend).

---

## Contents

- [How it works](#how-it-works)
- [API reference](#api-reference)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Data model](#data-model)
- [Security model](#security-model)
- [Project layout](#project-layout)
- [License](#license)

---

## How it works

```
                       ┌──────────────────────────────────────────┐
  Angular client ──────►  api  (Express on Cloud Functions v2)    │
  Firebase ID token    │  CORS · rate limits · auth · validation  │
                       └───┬──────────────────────────────┬───────┘
                           │                              │
                  ┌────────▼────────┐            ┌────────▼────────┐
                  │  newsService    │            │  marketService  │
                  │  Google News    │            │  yahoo-finance2 │
                  │  Yahoo RSS      │            │  quotes/history │
                  │  Finnhub (opt.) │            └─────────────────┘
                  └────────┬────────┘
                           │  relevance filter (finance vs. noise terms)
                  ┌────────▼────────┐
                  │  aiService      │  Qwen3.5-4B via Hugging Face
                  │  summary        │  Inference Providers (Featherless)
                  │  sentiment      │  POSITIVO / NEGATIVO / NEUTRO
                  │  importance     │  MUY_IMPORTANTE … POCO_RELEVANTE
                  └────────┬────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │  Firestore: /news, /users/*          │
        └──────────────────┬───────────────────┘
                           │
  ┌────────────────────────▼─────────────────────────┐
  │  Cloud Scheduler                                 │
  │  trackNews    every 15 min → enrich + FCM push   │
  │  dailyDigest  09:00 Europe/Madrid → one push     │
  └──────────────────────────────────────────────────┘
```

**The news pipeline.** `trackNews` collects every ticker any user watches, fetches the last 3 days
of headlines, drops items already stored, scores the rest for financial relevance (a term list that
deliberately excludes sponsorship/sports/CSR brand mentions), and enriches at most 5 new items per
ticker per run to bound LLM cost. Routine items are stored but not pushed — the digest covers them.
Only `MUY_IMPORTANTE` stories notify, and only users who enabled *High-impact news*.

**Price alerts.** The same cycle compares each watched ticker's daily change against a 3% threshold
and fires at most one alert per ticker per day, claimed through a Firestore dedup ledger so
overlapping runs cannot double-notify.

**Caching.** Quotes are cached 30s, history 5min, and AI enrichment is keyed by a stable hash of the
article so a re-view never re-pays for the same summary.

---

## API reference

Base URL: `https://<project>.web.app/api` (Firebase Hosting rewrite) or the function URL directly.

**Every endpoint requires** `Authorization: Bearer <Firebase ID token>`. There is no public route —
`/news` spends real LLM budget, so nothing is left open.

| Method   | Path                        | Description |
| -------- | --------------------------- | ----------- |
| `GET`    | `/news/:ticker`             | Live news for a ticker. Query: `limit` (1–100), `range` (`1D`…`1Y`), `from`/`to` (ISO-8601), `daysBack` (0–365), `lang` (`en`\|`es`), `companyName`, `rssOnly`, `enrich=false` |
| `GET`    | `/news/:ticker/stored`      | AI-enriched news persisted by the tracker. Query: `limit` (1–100) |
| `GET`    | `/market/:ticker`           | Quote and history. Query: `days` (1–3650, default 30) |
| `GET`    | `/tickers/search`           | Symbol lookup. Query: `q` (≤64 chars) |
| `GET`    | `/watchlist`                | The caller's watchlist |
| `POST`   | `/watchlist`                | Add a ticker. Body: `{ ticker, companyName? }` |
| `DELETE` | `/watchlist/:ticker`        | Remove a ticker |
| `GET`    | `/preferences/alerts`       | Alert preferences |
| `PUT`    | `/preferences/alerts`       | Body: `{ priceMoves?, highImpact?, dailyDigest? }` (booleans) |
| `POST`   | `/devices`                  | Register an FCM token. Body: `{ token, platform? }` |
| `DELETE` | `/devices/:token`           | Unregister an FCM token |

User-scoped routes take the uid **from the verified token**, never from the path or body — a caller
cannot address another user's data.

### Rate limits

Fixed-window, per authenticated uid (per IP before auth), advertised via `RateLimit-*` headers:

| Tier     | Limit        | Applies to |
| -------- | ------------ | ---------- |
| `global` | 120 / min    | every request, before auth |
| `ai`     | 20 / min     | `/news` (LLM spend) |
| `lookup` | 60 / min     | `/market`, `/tickers` |
| `write`  | 40 / min     | `/watchlist`, `/devices`, `/preferences` |

Counters are per-instance and `maxInstances` is 5, so a single caller can reach at most 5x a limit.
That is a deliberate trade: the goal is capping runaway cost and scripted abuse, not metering.

---

## Getting started

**Prerequisites**

- Node.js 22 (the functions runtime — match it locally)
- A Firebase project on the Blaze plan (Functions v2 + Cloud Scheduler require it)
- `npx firebase-tools login`
- A [Hugging Face token](https://huggingface.co/settings/tokens) with *Make calls to Inference Providers*

```bash
git clone https://github.com/rafaelhernandezperez/newsTracker-backend.git
cd newsTracker-backend/functions
npm install
cp .env.example .env      # then fill in HF_TOKEN
npm run build
```

Point the project at your own Firebase project by editing `.firebaserc`, then enable
**Authentication → Email/Password**, **Firestore**, and **Cloud Messaging** in the console.

---

## Configuration

`functions/.env` (never committed — see [`.env.example`](functions/.env.example)):

| Variable           | Required | Purpose |
| ------------------ | -------- | ------- |
| `HF_TOKEN`         | yes      | Hugging Face Inference Providers token for summary/sentiment/importance |
| `HF_MODEL`         | no       | Model override. Default `Qwen/Qwen3.5-4B:featherless-ai` |
| `FINNHUB_TOKEN`    | no       | Enables dated historical company news for the chart markers |
| `ALLOWED_ORIGINS`  | no       | Comma-separated browser origins allowed by CORS. Defaults to the project's Hosting domains plus `localhost:4200` |
| `TRUST_PROXY_HOPS` | no       | Trusted `X-Forwarded-For` hops used to derive the client IP for rate limiting. `1` is correct on Cloud Functions v2 |
| `APP_CHECK_ENFORCED` | no     | `true` rejects requests without a valid App Check token. Unset = verify and log only. See [App Check](#app-check) |

In production `HF_TOKEN` is a **Firebase secret** (Secret Manager), declared in
[`functions/src/config/secrets.ts`](functions/src/config/secrets.ts) and bound to every function
that needs it:

```bash
npx firebase-tools functions:secrets:set HF_TOKEN
```

---

## Local development

```bash
cd functions
npm run dev        # tsc && node dev-server.js → http://127.0.0.1:8080
```

`dev-server.js` runs the *same* Express app on a plain HTTP port so the Angular dev server can proxy
to it without the emulator suite. It **binds to loopback only**: it exposes unauthenticated
`/dev/track` and `/dev/digest` triggers that run a real cycle with this machine's credentials, which
must never be reachable from the network.

For Firestore- and Auth-backed routes, drop a service-account key at `functions/serviceAccount.json`
(gitignored) and it is picked up automatically.

```bash
curl -X POST http://127.0.0.1:8080/dev/track    # one tracking cycle on demand
curl -X POST http://127.0.0.1:8080/dev/digest   # one digest cycle on demand
```

Other scripts: `npm run build`, `npm run build:watch`, `npm run serve` (emulators), `npm run logs`.

---

## Deployment

```bash
npx firebase-tools deploy --only functions            # api + trackNews + dailyDigest
npx firebase-tools deploy --only firestore:rules      # security rules
npx firebase-tools deploy --only hosting              # rewrite + security headers
```

Functions deploy to `europe-west1` with `maxInstances: 5` — a deliberate ceiling on scale-out and,
with it, on external API and LLM spend. `npm run build` runs automatically as a predeploy step.

---

## Data model

```
/news/{newsId}                     AI-enriched articles (backend writes only, clients read)
/priceAlerts/{alertId}             dedup ledger for the once-a-day price alert (backend only)
/users/{uid}
  ├── alertPrefs                   { priceMoves, highImpact, dailyDigest }
  ├── watchlist/{ticker}           { ticker, companyName?, notificationsEnabled?, createdAt }
  └── devices/{fcmToken}           { token, platform, updatedAt }
```

---

## Security model

Defence is layered so that no single mistake opens the API:

- **Attestation** — App Check verifies the request came from the deployed Angular app before
  identity is even checked. Sign-up is open, so a valid ID token proves nothing about the *caller*;
  this is what stands between a scripted account and the LLM budget. See below.
- **Authentication** — every route verifies the Firebase ID token, and re-checks revocation against
  Identity Toolkit (cached 5 min per uid) so a disabled or revoked account loses access in minutes
  rather than when its 1h token expires. Failures are indistinguishable by design: bad signature,
  expiry, revocation and disabled accounts all return the same 401.
- **Authorization** — the uid always comes from the token. Firestore rules independently enforce
  ownership, cap document size and validate field shapes, because a browser talking straight to
  Firestore bypasses the API's validation entirely.
- **Input validation** — [`middleware/validation.ts`](functions/src/middleware/validation.ts)
  bounds every value crossing the boundary and guarantees anything used as a Firestore document id
  is a single path segment (`db.collection(c).doc(v)` splits `v` on `/`).
- **Prompt injection** — feed content is untrusted third-party text. It is passed between explicit
  SOURCE TEXT markers with a system prompt instructing the model to treat it as data, and every
  model response is parsed against a closed enum before use.
- **CORS** — an explicit origin allowlist. A bare `cors()` answers preflights with `*`, which would
  let any page on the internet script the API with a stolen token.
- **Response hardening** — `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  a JSON-only CSP, and no `X-Powered-By`. Errors never echo `err.message` or a stack trace.
- **Body size** — JSON capped at 16kb; every endpoint takes a small object.
- **Logging** — rate-limit warnings record the *kind* of identity (uid vs. IP), never the identity
  itself: logs outlive every rate window.

### App Check

[`middleware/appCheck.ts`](functions/src/middleware/appCheck.ts) verifies the `X-Firebase-AppCheck`
header on every request. Setup is three steps:

1. **Firebase console → App Check → Apps** — register the web app with the **reCAPTCHA v3**
   provider and copy the *site* key.
2. Paste it into `appCheckSiteKey` in the frontend's `src/app/core/firebase/firebase.config.ts`.
   Leaving it empty keeps App Check off, so a fresh clone still runs.
3. Watch **App Check → Metrics** until verified requests are effectively all of your traffic, then
   set `APP_CHECK_ENFORCED=true` and redeploy.

The two phases matter. Attestation fails for reasons that have nothing to do with abuse — a stale
cached bundle, a privacy extension, a domain not yet registered — so enforcing it before you can see
the metrics is a reliable way to lock out your own users. Until the flag is set, failures are logged
(throttled to one line per 10s) and allowed through.

**Also worth doing in the console**, since neither can be expressed in this repo: set
**Authentication → Settings → sign-up quota** so one script cannot mint thousands of accounts, and
restrict the browser API key to your Hosting domains under
**Google Cloud → APIs & Services → Credentials**.

### Known dependency findings

`npm audit --omit=dev` reports moderate `uuid` advisories reached only through `firebase-admin`'s
own dependency chain. The only available "fix" is `npm audit fix --force`, which downgrades
`firebase-admin` to 10.3.0 — an older release with strictly more known issues. They are left in
place deliberately; `express`/`qs` is pinned forward via an `overrides` entry in
[`functions/package.json`](functions/package.json).

Found something? Please open a security advisory rather than a public issue.

---

## Project layout

```
functions/src/
├── index.ts                   Express app: proxy trust, CORS, headers, limits, routers
├── config/secrets.ts          Firebase secret declarations
├── middleware/
│   ├── appCheck.ts            App Check attestation (monitor -> enforce)
│   ├── auth.ts                ID-token verification + revocation cache
│   ├── rateLimit.ts           fixed-window limiter, uid- or IP-keyed
│   ├── security.ts            CORS allowlist + response headers
│   └── validation.ts          all boundary validation
├── routes/                    news · market · tickers · watchlist · devices · preferences
├── scheduler/index.ts         trackNews (15 min) · dailyDigest (09:00 Europe/Madrid)
└── services/
    ├── newsService/           feed sources, normalizers, relevance, TTL cache
    ├── aiService/             LLM enrichment (summary, sentiment, importance)
    ├── marketService/         quotes and history
    ├── trackerService/        the 15-minute cycle + price alerts
    ├── digestService/         the daily digest
    ├── notificationService/   FCM fan-out with stale-token pruning
    └── firebaseService/       Firestore access (Admin SDK)

firestore.rules                ownership + shape validation for direct SDK access
firebase.json                  functions, hosting rewrite, security headers
scripts/                       one-shot project setup helpers (auth, push)
```

---

## License

MIT — see [LICENSE](LICENSE).

Built as a Master's thesis project. News content belongs to its respective publishers; this project
stores headlines, links and derived classifications only.
