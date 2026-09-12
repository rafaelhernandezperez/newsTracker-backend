import admin from "firebase-admin";
import { isSafeDocumentId } from "../../middleware/validation";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth = admin.auth();
export const appCheck = admin.appCheck();

/**
 * Assert a value is safe to use as a Firestore document id. `doc(value)` treats
 * "/" as a path separator, so an id like `A/B/C` silently writes to a different
 * depth of the tree. Routes validate their own inputs; this is the backstop for
 * every other caller, because the Admin SDK bypasses Firestore security rules.
 * Throwing rather than sanitising is deliberate: a bad id means a bug or an
 * attack upstream, and quietly rewriting it would hide both.
 */
function assertDocumentId(value: string, label: string): string {
  if (!isSafeDocumentId(value)) {
    throw new Error(`[firebaseService] unsafe ${label} document id rejected`);
  }
  return value;
}

export async function addTickerToWatchlist(
  uid: string,
  ticker: string,
  companyName?: string
): Promise<void> {
  const docId = assertDocumentId(ticker.toUpperCase(), "ticker");
  await db
    .collection("users")
    .doc(assertDocumentId(uid, "uid"))
    .collection("watchlist")
    .doc(docId)
    .set(
      {
        ticker: docId,
        companyName: companyName ?? null,
        notificationsEnabled: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

export async function getUserWatchlist(uid: string): Promise<FirebaseFirestore.DocumentData[]> {
  const snap = await db
    .collection("users")
    .doc(assertDocumentId(uid, "uid"))
    .collection("watchlist")
    .get();

  return snap.docs.map((doc) => doc.data());
}

export async function removeTickerFromWatchlist(uid: string, ticker: string): Promise<void> {
  await db
    .collection("users")
    .doc(assertDocumentId(uid, "uid"))
    .collection("watchlist")
    .doc(assertDocumentId(ticker.toUpperCase(), "ticker"))
    .delete();
}

/* -- Device tokens (FCM) -- */

export async function registerDeviceToken(
  uid: string,
  token: string,
  platform?: string
): Promise<void> {
  const safeUid = assertDocumentId(uid, "uid");
  const safeToken = assertDocumentId(token, "device token");
  const ownerRef = db.collection("deviceTokenOwners").doc(safeToken);
  const currentRef = db
    .collection("users")
    .doc(safeUid)
    .collection("devices")
    .doc(safeToken);

  // An FCM token identifies one browser installation, not one account, so it is
  // reassigned when a shared browser switches accounts — otherwise the previous
  // user keeps receiving alerts on this device.
  //
  // The owner record is kept directly instead of querying collectionGroup
  // ("devices"): that needs a separately deployed collection-group index, and a
  // missing one made every first-time registration fail with a 500.
  await db.runTransaction(async (transaction) => {
    const owner = await transaction.get(ownerRef);
    const previousUid = owner.get("uid");

    if (
      typeof previousUid === "string" &&
      isSafeDocumentId(previousUid) &&
      previousUid !== safeUid
    ) {
      transaction.delete(
        db
          .collection("users")
          .doc(previousUid)
          .collection("devices")
          .doc(safeToken)
      );
    } else if (previousUid !== undefined && previousUid !== safeUid) {
      // A corrupt owner record must not permanently block a legitimate browser
      // from registering; overwriting it below self-heals the canonical owner.
      console.warn("[firebaseService] ignoring malformed device owner uid");
    }

    const updatedAt = admin.firestore.FieldValue.serverTimestamp();
    transaction.set(
      currentRef,
      {
        token: safeToken,
        platform: platform ?? "unknown",
        updatedAt,
      },
      { merge: true }
    );
    transaction.set(ownerRef, { uid: safeUid, updatedAt });
  });
}

export async function removeDeviceToken(uid: string, token: string): Promise<void> {
  const safeUid = assertDocumentId(uid, "uid");
  const safeToken = assertDocumentId(token, "device token");
  const deviceRef = db
    .collection("users")
    .doc(safeUid)
    .collection("devices")
    .doc(safeToken);
  const ownerRef = db.collection("deviceTokenOwners").doc(safeToken);

  await db.runTransaction(async (transaction) => {
    const owner = await transaction.get(ownerRef);
    transaction.delete(deviceRef);
    if (owner.get("uid") === safeUid) {
      transaction.delete(ownerRef);
    }
  });
}

export async function getDeviceTokensForUsers(uids: string[]): Promise<string[]> {
  const unique = Array.from(new Set(uids));
  const tokenLists = await Promise.all(
    unique.map(async (uid) => {
      const snap = await db.collection("users").doc(uid).collection("devices").get();
      return snap.docs.map((doc) => doc.get("token") as string).filter(Boolean);
    })
  );
  return Array.from(new Set(tokenLists.flat()));
}

/** Remove tokens that FCM reported as invalid/unregistered, across all users. */
export async function pruneInvalidTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await Promise.all(
    Array.from(new Set(tokens)).map(async (token) => {
      if (!isSafeDocumentId(token)) {
        console.warn("[firebaseService] refusing to prune malformed device token");
        return;
      }
      const ownerRef = db.collection("deviceTokenOwners").doc(token);
      await db.runTransaction(async (transaction) => {
        const owner = await transaction.get(ownerRef);
        const ownerUid = owner.get("uid");
        if (typeof ownerUid === "string" && isSafeDocumentId(ownerUid)) {
          transaction.delete(
            db.collection("users").doc(ownerUid).collection("devices").doc(token)
          );
        }
        transaction.delete(ownerRef);
      });
    })
  );
}

/* -- Alert preferences -- */

/** Which alert channels a user opted into (onboarding step 3). */
export type AlertPrefs = {
  /** Push when a watched ticker moves more than ±3% in a day. */
  priceMoves: boolean;
  /** Push high-impact (MUY_IMPORTANTE) news as soon as the tracker stores it. */
  highImpact: boolean;
  /** Include the user in the daily 9am digest. */
  dailyDigest: boolean;
};

/** Users who never saved preferences keep today's behavior: everything on. */
export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  priceMoves: true,
  highImpact: true,
  dailyDigest: true,
};

/**
 * Read prefs from untrusted/partial data. Missing or malformed fields fall back
 * to the defaults, so a partial write can't silently disable a channel.
 */
export function coerceAlertPrefs(raw: unknown): AlertPrefs {
  const data = (raw ?? {}) as Partial<Record<keyof AlertPrefs, unknown>>;
  return {
    priceMoves:
      typeof data.priceMoves === "boolean" ? data.priceMoves : DEFAULT_ALERT_PREFS.priceMoves,
    highImpact:
      typeof data.highImpact === "boolean" ? data.highImpact : DEFAULT_ALERT_PREFS.highImpact,
    dailyDigest:
      typeof data.dailyDigest === "boolean" ? data.dailyDigest : DEFAULT_ALERT_PREFS.dailyDigest,
  };
}

export async function getAlertPrefs(uid: string): Promise<AlertPrefs> {
  const snap = await db.collection("users").doc(uid).get();
  return coerceAlertPrefs(snap.get("alertPrefs"));
}

export async function setAlertPrefs(uid: string, prefs: AlertPrefs): Promise<void> {
  await db.collection("users").doc(uid).set(
    {
      alertPrefs: coerceAlertPrefs(prefs),
      alertPrefsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Batch-read alert prefs so scheduler fan-out costs one getAll, not N gets. */
export async function getAlertPrefsForUsers(uids: string[]): Promise<Map<string, AlertPrefs>> {
  const unique = Array.from(new Set(uids));
  const prefs = new Map<string, AlertPrefs>();
  if (unique.length === 0) return prefs;

  const refs = unique.map((uid) => db.collection("users").doc(uid));
  const snaps = await db.getAll(...refs);
  snaps.forEach((snap, index) => {
    prefs.set(unique[index], coerceAlertPrefs(snap.get("alertPrefs")));
  });
  return prefs;
}

/**
 * Atomically claim "the >3% price alert for this ticker was sent on this date".
 * `create()` fails if the doc exists, so concurrent cycles can't double-send.
 * Returns false when the alert already went out today.
 */
export async function claimPriceAlert(ticker: string, dateKey: string): Promise<boolean> {
  try {
    const symbol = assertDocumentId(ticker.toUpperCase(), "ticker");
    await db.collection("priceAlerts").doc(`${symbol}_${dateKey}`).create({
      ticker: symbol,
      date: dateKey,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch {
    return false;
  }
}

/* -- Watchlist fan-out (cross-user) -- */

export type WatchedTicker = {
  ticker: string;
  companyName?: string;
  /** uids subscribed to notifications for this ticker. */
  subscribers: string[];
};

/**
 * Every watched ticker across ALL users, grouped so the scheduler fetches news
 * once per ticker and fans out to its subscribers.
 */
export async function getAllWatchedTickers(): Promise<WatchedTicker[]> {
  const snap = await db.collectionGroup("watchlist").get();
  const map = new Map<string, WatchedTicker>();

  for (const doc of snap.docs) {
    const data = doc.data();
    const ticker = String(data.ticker ?? doc.id).toUpperCase();
    if (!ticker) continue;

    // Parent path: users/{uid}/watchlist/{ticker}
    const uid = doc.ref.parent.parent?.id;
    const entry: WatchedTicker =
      map.get(ticker) ?? { ticker, companyName: data.companyName ?? undefined, subscribers: [] };
    if (!entry.companyName && data.companyName) {
      entry.companyName = data.companyName;
    }
    if (uid && data.notificationsEnabled !== false) {
      entry.subscribers.push(uid);
    }
    map.set(ticker, entry);
  }

  return Array.from(map.values());
}

export type UserWatchlist = {
  uid: string;
  tickers: { ticker: string; companyName?: string }[];
};

/**
 * Every user's watched tickers, grouped per user, for the daily digest. Muted
 * tickers are excluded, so a user is never considered for one.
 */
export async function getUsersWithWatchlists(): Promise<UserWatchlist[]> {
  const snap = await db.collectionGroup("watchlist").get();
  const byUser = new Map<string, UserWatchlist>();

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.notificationsEnabled === false) continue;

    const uid = doc.ref.parent.parent?.id;
    if (!uid) continue;

    const ticker = String(data.ticker ?? doc.id).toUpperCase();
    if (!ticker) continue;

    const entry = byUser.get(uid) ?? { uid, tickers: [] };
    entry.tickers.push({ ticker, companyName: data.companyName ?? undefined });
    byUser.set(uid, entry);
  }

  return Array.from(byUser.values());
}

/**
 * A small ring of the most recent news ids sent to a user, so yesterday's
 * runner-up can't be pushed today as if it were fresh.
 */
const DIGEST_HISTORY_SIZE = 10;

export async function getRecentDigestNewsIds(uid: string): Promise<string[]> {
  const snap = await db.collection("users").doc(uid).get();
  const ring = snap.get("recentDigestNewsIds");
  if (Array.isArray(ring)) {
    return ring.filter((value): value is string => typeof value === "string");
  }
  // Legacy field from before the ring existed.
  const legacy = snap.get("lastDigestNewsId");
  return typeof legacy === "string" ? [legacy] : [];
}

export async function recordDigestNewsId(uid: string, newsId: string): Promise<void> {
  const recent = await getRecentDigestNewsIds(uid);
  const ring = [newsId, ...recent.filter((id) => id !== newsId)].slice(0, DIGEST_HISTORY_SIZE);
  await db.collection("users").doc(uid).set(
    {
      lastDigestNewsId: newsId,
      recentDigestNewsIds: ring,
      lastDigestAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/* -- News persistence + dedup -- */

export type StoredNews = {
  id: string;
  ticker: string;
  title: string;
  link: string;
  source: string;
  summary?: string;
  aiSummary?: string;
  sentiment?: string;
  importance?: string;
  language?: string;
  pubDate?: string;
  isoDate?: string;
  score: number;
};

/** Return the subset of ids that are NOT already stored (i.e. genuinely new). */
export async function filterNewNewsIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const refs = ids.map((id) => db.collection("news").doc(id));
  const docs = await db.getAll(...refs);
  const newIds = new Set<string>();
  docs.forEach((doc, i) => {
    if (!doc.exists) newIds.add(ids[i]);
  });
  return newIds;
}

/** Read the latest stored (AI-enriched) news for a ticker. */
export async function getStoredNews(
  ticker: string,
  limit = 30
): Promise<FirebaseFirestore.DocumentData[]> {
  const snap = await db
    .collection("news")
    .where("ticker", "==", ticker.toUpperCase())
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function saveNewsItem(item: StoredNews): Promise<void> {
  const { id, ...rest } = item;
  try {
    // create(), not set/merge: the doc id is the dedup key, so a concurrent
    // scheduler run that stored it first must not clobber createdAt (which
    // orders the /stored feed) or re-write the enrichment.
    await db
      .collection("news")
      .doc(assertDocumentId(id, "news"))
      .create({
        ...rest,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (error) {
    if ((error as { code?: number }).code === 6 /* ALREADY_EXISTS */) {
      return;
    }
    throw error;
  }
}
