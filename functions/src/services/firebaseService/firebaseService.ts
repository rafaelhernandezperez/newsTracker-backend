import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth = admin.auth();

export async function addTickerToWatchlist(
  uid: string,
  ticker: string,
  companyName?: string
): Promise<void> {
  await db
    .collection("users")
    .doc(uid)
    .collection("watchlist")
    .doc(ticker.toUpperCase())
    .set(
      {
        ticker: ticker.toUpperCase(),
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
    .doc(uid)
    .collection("watchlist")
    .get();

  return snap.docs.map((doc) => doc.data());
}

export async function removeTickerFromWatchlist(uid: string, ticker: string): Promise<void> {
  await db
    .collection("users")
    .doc(uid)
    .collection("watchlist")
    .doc(ticker.toUpperCase())
    .delete();
}

/* -------------------------------------------------------------------------- */
/* Device tokens (FCM)                                                        */
/* -------------------------------------------------------------------------- */

export async function registerDeviceToken(
  uid: string,
  token: string,
  platform?: string
): Promise<void> {
  // Doc id = token so re-registering the same device is idempotent.
  await db
    .collection("users")
    .doc(uid)
    .collection("devices")
    .doc(token)
    .set(
      {
        token,
        platform: platform ?? "unknown",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

export async function removeDeviceToken(uid: string, token: string): Promise<void> {
  await db.collection("users").doc(uid).collection("devices").doc(token).delete();
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
  const snaps = await Promise.all(
    tokens.map((token) =>
      db.collectionGroup("devices").where("token", "==", token).get()
    )
  );
  // Firestore batches are limited to 500 operations.
  const docs = snaps.flatMap((snap) => snap.docs);
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

/* -------------------------------------------------------------------------- */
/* Watchlist fan-out (cross-user)                                             */
/* -------------------------------------------------------------------------- */

export type WatchedTicker = {
  ticker: string;
  companyName?: string;
  /** uids subscribed to notifications for this ticker. */
  subscribers: string[];
};

/**
 * Collect every watched ticker across ALL users (collectionGroup), grouped so
 * the scheduler fetches news once per ticker and fans out to subscribers.
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
 * Collect every user's watched tickers, grouped per user, for the per-user daily
 * digest. Only tickers with notifications enabled are included, so a user who
 * muted a ticker is never considered for it.
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
 * A small ring of the most recent news ids sent to a user in digests, so
 * yesterday's runner-up can't be pushed today as if it were fresh (a single
 * "last id" only guarded against exact repeats of the top story).
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

/* -------------------------------------------------------------------------- */
/* News persistence + dedup                                                   */
/* -------------------------------------------------------------------------- */

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
    // create() (not set/merge): the doc id is the dedup key, so a concurrent
    // scheduler run that stored it first must not clobber createdAt (which
    // orders the /stored feed) or re-write the enrichment.
    await db
      .collection("news")
      .doc(id)
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
