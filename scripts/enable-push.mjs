#!/usr/bin/env node
/**
 * One-shot script to wire FCM Web Push (VAPID) into the frontend, completing
 * the notification pipeline (backend send path already works; this unblocks
 * the receiving end).
 *
 * Prerequisite: `npx firebase-tools login` (same as enable-auth.mjs).
 *
 * Usage:
 *   node scripts/enable-push.mjs
 *       Tries to fetch (or create) the project's Web Push certificate via the
 *       console's API. That API is not officially documented, so if it fails:
 *   node scripts/enable-push.mjs <PUBLIC_KEY>
 *       Paste the key yourself from:
 *       Firebase console → Project settings → Cloud Messaging →
 *       Web configuration → Web Push certificates ("Generate key pair" if empty).
 *
 * What it patches (idempotently):
 *   - frontend src/app/core/firebase/firebase.config.ts → firebaseVapidKey
 *
 * The service worker does NOT need the VAPID key (it only needs the app
 * config, already real), so no other file changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT_ID = "financialnewstracker";
// Project number == messagingSenderId in the web config.
const PROJECT_NUMBER = "122616090189";
const BACKEND = join(import.meta.dirname, "..");
const FRONTEND_CONFIG = join(
  BACKEND,
  "..",
  "newsTracker-frontend/src/app/core/firebase/firebase.config.ts"
);

// Public OAuth client of the Firebase CLI (not a secret — shipped in the
// open-source firebase-tools package). Used only to refresh an expired token.
const CLI_CLIENT_ID =
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLI_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

const CONSOLE_URL = `https://console.firebase.google.com/project/${PROJECT_ID}/settings/cloudmessaging`;

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

/**
 * A VAPID public key is a base64url-encoded uncompressed P-256 point:
 * 65 bytes → 87 chars, always starting with "B" (0x04 lead byte).
 */
function looksLikeVapidKey(key) {
  return /^B[A-Za-z0-9_-]{85,90}$/.test(key ?? "");
}

/**
 * Try the endpoint the Firebase console itself uses for Web Push certificates.
 * NOT part of any published API surface — may 403/404 at any time, in which
 * case we fall back to manual paste. Any failure returns null.
 */
async function tryFetchVapidKey(token) {
  const base = `https://fcmweb.googleapis.com/v1/projects/${PROJECT_NUMBER}/keys`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const extractKey = (json) => {
    const entries = json?.keys ?? (json?.key || json?.publicKey ? [json] : []);
    for (const entry of entries) {
      for (const candidate of [entry?.key, entry?.publicKey]) {
        if (looksLikeVapidKey(candidate)) return candidate;
      }
    }
    return null;
  };

  try {
    const list = await fetch(base, { headers });
    if (list.ok) {
      const found = extractKey(await list.json());
      if (found) return found;
    } else {
      console.warn(`  (list web push certs: HTTP ${list.status})`);
    }

    console.log("  no existing certificate found — trying to create one…");
    const create = await fetch(base, { method: "POST", headers, body: "{}" });
    if (create.ok) {
      const created = extractKey(await create.json());
      if (created) return created;
    } else {
      console.warn(`  (create web push cert: HTTP ${create.status})`);
    }
  } catch (error) {
    console.warn(`  (web push cert API unreachable: ${error?.message ?? error})`);
  }
  return null;
}

function patchFrontendConfig(key) {
  let ts = readFileSync(FRONTEND_CONFIG, "utf8");
  const pattern = /export const firebaseVapidKey = '[^']*';/;
  const replacement = `export const firebaseVapidKey = '${key}';`;
  if (!pattern.test(ts)) {
    if (ts.includes(replacement)) return; // already patched with this exact key
    fail(`Could not find firebaseVapidKey in ${FRONTEND_CONFIG} — update it manually.`);
  }
  writeFileSync(FRONTEND_CONFIG, ts.replace(pattern, replacement));
  console.log(`  ✔ ${FRONTEND_CONFIG}`);
}

const argKey = process.argv[2]?.trim();
let vapidKey;

if (argKey) {
  if (!looksLikeVapidKey(argKey)) {
    fail(
      "That does not look like a VAPID public key (expected ~87 base64url chars starting with 'B').\n" +
        `  Copy the key pair value from: ${CONSOLE_URL}`
    );
  }
  vapidKey = argKey;
} else {
  console.log("→ Getting Firebase CLI access token…");
  const token = await getAccessToken();

  console.log("→ Fetching Web Push certificate (undocumented console API)…");
  vapidKey = await tryFetchVapidKey(token);
  if (!vapidKey) {
    fail(
      "Could not fetch/create the Web Push certificate automatically.\n" +
        `  1. Open ${CONSOLE_URL}\n` +
        '  2. Under "Web configuration" → "Web Push certificates", click "Generate key pair"\n' +
        "     (or copy the existing one).\n" +
        "  3. Rerun: node scripts/enable-push.mjs <PUBLIC_KEY>"
    );
  }
}

console.log("→ Patching frontend config…");
patchFrontendConfig(vapidKey);

console.log(`
✅ Web Push (VAPID) is configured.
   Next steps:
     1. Restart the frontend dev server (ng serve).
     2. Log in — accept the notification permission prompt.
     3. Verify the device registered: Firestore → users/{uid}/devices should
        gain a doc (or watch for POST /api/devices → 201 in the network tab).
     4. Send yourself a test push: with the local dev server running,
          curl -X POST http://127.0.0.1:8080/dev/digest
`);
