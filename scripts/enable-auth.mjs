#!/usr/bin/env node
/**
 * One-shot script to switch NewsTracker from the AUTH_DISABLED dev bypass to
 * real Firebase Authentication.
 *
 * Prerequisite: `npx firebase-tools login` (needs a browser once).
 *
 * What it does, idempotently:
 *   1. Reads the Firebase CLI OAuth token from its configstore.
 *   2. Enables the Identity Toolkit API on the project.
 *   3. Ensures a Firebase *web app* exists (creates one if missing).
 *   4. Fetches the web app SDK config (apiKey / senderId / appId).
 *   5. Enables the Email/Password sign-in provider.
 *   6. Writes the real keys into:
 *        - frontend src/app/core/firebase/firebase.config.ts (+ AUTH_DISABLED=false)
 *        - frontend public/firebase-messaging-sw.js
 *      and flips AUTH_DISABLED=false in functions/.env.
 *
 * It does NOT deploy. Redeploy functions afterwards so the backend stops
 * accepting unauthenticated requests: `npx firebase-tools deploy --only functions`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT_ID = "financialnewstracker";
const BACKEND = join(import.meta.dirname, "..");
const FRONTEND = join(BACKEND, "..", "newsTracker-frontend");

const FRONTEND_CONFIG = join(FRONTEND, "src/app/core/firebase/firebase.config.ts");
const SW_FILE = join(FRONTEND, "public/firebase-messaging-sw.js");
const FUNCTIONS_ENV = join(BACKEND, "functions/.env");

// Public OAuth client of the Firebase CLI (not a secret — shipped in the
// open-source firebase-tools package). Used only to refresh an expired token.
const CLI_CLIENT_ID =
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLI_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

async function getAccessToken() {
  const configstore = join(homedir(), ".config/configstore/firebase-tools.json");
  let store;
  try {
    store = JSON.parse(readFileSync(configstore, "utf8"));
  } catch {
    fail("Firebase CLI configstore not found. Run: npx firebase-tools login");
  }
  const tokens = store.tokens;
  if (!tokens?.refresh_token) {
    fail("Not logged in. Run: npx firebase-tools login");
  }
  if (tokens.access_token && tokens.expires_at && tokens.expires_at > Date.now() + 60_000) {
    return tokens.access_token;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLI_CLIENT_ID,
      client_secret: CLI_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    fail(`Token refresh failed (${res.status}). Run: npx firebase-tools login --reauth`);
  }
  return (await res.json()).access_token;
}

async function api(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

async function enableIdentityToolkit(token) {
  const r = await api(
    token,
    "POST",
    `https://serviceusage.googleapis.com/v1/projects/${PROJECT_ID}/services/identitytoolkit.googleapis.com:enable`
  );
  if (!r.ok && r.status !== 400) {
    console.warn(`  (could not enable identitytoolkit API: ${r.status} — continuing)`);
  }
}

async function ensureWebApp(token) {
  const base = `https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}`;
  const list = await api(token, "GET", `${base}/webApps`);
  if (!list.ok) fail(`Listing web apps failed: ${list.status} ${JSON.stringify(list.json)}`);
  const existing = list.json.apps?.[0];
  if (existing) return existing.appId;

  console.log("  no web app registered — creating one…");
  const create = await api(token, "POST", `${base}/webApps`, {
    displayName: "NewsTracker Web",
  });
  if (!create.ok) fail(`Creating web app failed: ${create.status} ${JSON.stringify(create.json)}`);
  // Long-running operation: poll until done.
  const opName = create.json.name;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const op = await api(token, "GET", `https://firebase.googleapis.com/v1beta1/${opName}`);
    if (op.json.done) {
      if (op.json.error) fail(`Web app creation failed: ${JSON.stringify(op.json.error)}`);
      return op.json.response.appId;
    }
  }
  fail("Timed out waiting for web app creation.");
}

async function getWebConfig(token, appId) {
  const r = await api(
    token,
    "GET",
    `https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}/webApps/${appId}/config`
  );
  if (!r.ok) fail(`Fetching web config failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json; // { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId, ... }
}

async function enableEmailPassword(token) {
  const cfgUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config`;
  let r = await api(token, "PATCH", `${cfgUrl}?updateMask=signIn.email`, {
    signIn: { email: { enabled: true, passwordRequired: true } },
  });
  if (r.status === 404) {
    // Auth not initialized on the project yet (console "Get started" never clicked).
    console.log("  Firebase Auth not initialized — initializing…");
    const init = await api(
      token,
      "POST",
      `https://identitytoolkit.googleapis.com/v2/projects/${PROJECT_ID}/identityPlatform:initializeAuth`,
      {}
    );
    if (!init.ok && init.status !== 409) {
      fail(
        `Could not initialize Firebase Auth (${init.status}). ` +
          `Open https://console.firebase.google.com/project/${PROJECT_ID}/authentication, ` +
          `click "Get started", then rerun this script.`
      );
    }
    r = await api(token, "PATCH", `${cfgUrl}?updateMask=signIn.email`, {
      signIn: { email: { enabled: true, passwordRequired: true } },
    });
  }
  if (!r.ok) fail(`Enabling Email/Password failed: ${r.status} ${JSON.stringify(r.json)}`);
}

function replaceOrFail(file, content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    // Already replaced on a previous run is fine if the replacement is present.
    if (content.includes(replacement)) return content;
    fail(`Could not find ${label} in ${file} — file changed shape; update it manually.`);
  }
  return content.replace(pattern, replacement);
}

function patchFiles(cfg) {
  // frontend firebase.config.ts
  let ts = readFileSync(FRONTEND_CONFIG, "utf8");
  ts = replaceOrFail(FRONTEND_CONFIG, ts, /export const AUTH_DISABLED = true;/, "export const AUTH_DISABLED = false;", "AUTH_DISABLED flag");
  ts = ts
    .replace(/apiKey: '[^']*'/, `apiKey: '${cfg.apiKey}'`)
    .replace(/messagingSenderId: '[^']*'/, `messagingSenderId: '${cfg.messagingSenderId}'`)
    .replace(/appId: '[^']*'/, `appId: '${cfg.appId}'`)
    .replace(/storageBucket: '[^']*'/, `storageBucket: '${cfg.storageBucket}'`);
  writeFileSync(FRONTEND_CONFIG, ts);
  console.log(`  ✔ ${FRONTEND_CONFIG}`);

  // service worker
  let sw = readFileSync(SW_FILE, "utf8");
  sw = sw
    .replace(/apiKey: '[^']*'/, `apiKey: '${cfg.apiKey}'`)
    .replace(/messagingSenderId: '[^']*'/, `messagingSenderId: '${cfg.messagingSenderId}'`)
    .replace(/appId: '[^']*'/, `appId: '${cfg.appId}'`)
    .replace(/storageBucket: '[^']*'/, `storageBucket: '${cfg.storageBucket}'`);
  writeFileSync(SW_FILE, sw);
  console.log(`  ✔ ${SW_FILE}`);

  // functions/.env
  let env = readFileSync(FUNCTIONS_ENV, "utf8");
  if (/^AUTH_DISABLED=/m.test(env)) {
    env = env.replace(/^AUTH_DISABLED=.*$/m, "AUTH_DISABLED=false");
  } else {
    env += "\nAUTH_DISABLED=false\n";
  }
  writeFileSync(FUNCTIONS_ENV, env);
  console.log(`  ✔ ${FUNCTIONS_ENV}`);
}

console.log("→ Getting Firebase CLI access token…");
const token = await getAccessToken();

console.log("→ Enabling Identity Toolkit API…");
await enableIdentityToolkit(token);

console.log("→ Ensuring a Firebase web app exists…");
const appId = await ensureWebApp(token);
console.log(`  appId: ${appId}`);

console.log("→ Fetching web SDK config…");
const cfg = await getWebConfig(token, appId);

console.log("→ Enabling Email/Password sign-in provider…");
await enableEmailPassword(token);

console.log("→ Patching config files…");
patchFiles(cfg);

console.log(`
✅ Real auth is configured.
   Next steps:
     1. Redeploy the backend so it starts verifying tokens:
          npx firebase-tools deploy --only functions,firestore:rules
     2. Restart the frontend dev server and register a user on the login page.
   Note: Web Push (VAPID key) is still unset — push notifications stay off
   until you create a Web Push certificate in the console and update
   firebaseVapidKey in firebase.config.ts and keep sw.js in sync.
`);
