import admin from "firebase-admin";
import { isSafeDocumentId } from "../../middleware/validation";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth = admin.auth();

/**
 * Assert that a value is safe to use as a Firestore document id.
 *
 * `db.collection(c).doc(value)` treats "/" as a path separator, so an id like
 * `A/B/C` silently writes to a different depth of the tree than the call site
 * suggests. Routes already validate their inputs; this is the backstop for
 * every other caller — the scheduler, the digest, and any future code path —
 * because the Admin SDK bypasses Firestore security rules entirely, making this
 * layer the last place a malformed id can be caught.
 *
 * Throwing (rather than sanitising) is deliberate: a bad id here means a bug or
 * an attack upstream, and quietly rewriting it would hide both.
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
    .doc(uid)
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

/* -------------------------------------------------------------------------- */
/* Device tokens (FCM)                                                        */
/* -------------------------------------------------------------------------- */

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

  // An FCM token identifies one browser/app installation, not one account.
  // Reassign it when a shared browser changes accounts so the previous user
  // cannot keep receiving alerts on this device. The frontend also unregisters
  // on logout; this server-side cleanup covers crashes and missed logouts.
  //
  // Keep a direct owner record instead of querying collectionGroup("devices"):
  // that query needs a separately deployed collection-group index, and a
  // missing index made every first-time browser registration fail with HTTP
  // 500. The transaction also closes the account-switch race.
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
      // from registering. Overwriting it below self-heals the canonical owner.
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

/* -------------------------------------------------------------------------- */
/* Alert preferences                                                          */
/* -------------------------------------------------------------------------- */

/** Which alert channels a user opted into (onboarding step 3). */
export type AlertPrefs = {
  /** Push when a watched ticker moves more than ±3% in a day. */
  priceMoves: boolean;
  /** Push high-impact (MUY_IMPORTANTE) news as soon as the tracker stores it. */
  highImpact: boolean;
  /** Include the user in the daily 9am digest. */
  dailyDigest: boolean;
};

// Users who never saved preferences keep today's behavior: everything on.
export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  priceMoves: true,
  highImpact: true,
  dailyDigest: true,
};

function coerceAlertPrefs(raw: unknown): AlertPrefs {
  const data = (raw ?? {}) as Partial<Record<keyof AlertPrefs, unknown>>;
  return {
    priceMoves: typeof data.priceMoves === "boolean" ? data.priceMoves : DEFAULT_ALERT_PREFS.priceMoves,
    highImpact: typeof data.highImpact === "boolean" ? data.highImpact : DEFAULT_ALERT_PREFS.highImpact,
    dailyDigest: typeof data.dailyDigest === "boolean" ? data.dailyDigest : DEFAULT_ALERT_PREFS.dailyDigest,
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

export type StoredNewsRecord = StoredNews & {
  createdAt?: FirebaseFirestore.Timestamp;
};

export type PushTestNews = {
  story: StoredNewsRecord;
  companyName?: string;
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

const PUSH_IMPORTANCE_RANK: Record<string, number> = {
  MUY_IMPORTANTE: 4,
  IMPORTANTE: 3,
  NEUTRO: 2,
  POCO_RELEVANTE: 1,
};

const COMPANY_SUFFIXES =
  /\b(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|sa|s\.a\.|ag|nv|n\.v\.|holdings?|group|the)\b/gi;

function normalizeCompanyText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reject a cached ticker assignment when the source never names that company. */
function directlyNamesCompany(story: StoredNewsRecord, companyName?: string): boolean {
  if (!companyName) return true;

  const text = normalizeCompanyText(`${story.title} ${story.summary ?? ""}`);
  const cleanName = normalizeCompanyText(companyName.replace(COMPANY_SUFFIXES, " "));
  if (cleanName.length >= 4 && text.includes(cleanName)) return true;

  // This catches headlines that use a shortened trading name ("Apple" rather
  // than "Apple Inc.", "Disney" rather than "The Walt Disney Company").
  const textWords = new Set(text.split(" "));
  return cleanName
    .split(" ")
    .some((namePart) => namePart.length >= 5 && textWords.has(namePart));
}

function pushStoryQuality(story: StoredNewsRecord, recencyIndex: number): number {
  const rawSummaryLength = String(story.summary ?? "").trim().length;
  const importance = PUSH_IMPORTANCE_RANK[String(story.importance ?? "")] ?? 0;
  const relevance = Number.isFinite(story.score) ? story.score : 0;

  // Importance and source substance dominate. Recency only breaks close ties;
  // the newest row is not automatically the strongest notification demo.
  return importance * 10_000 + Math.min(rawSummaryLength, 2_000) + relevance * 10 - recencyIndex;
}

/**
 * Pick a showcase-quality real story for the authenticated user's push test.
 * A candidate must contain a substantive source snippet, because terse legacy
 * AI summaries cannot support a credible investor takeaway. Stories from the
 * user's watchlist are preferred and must directly name the watched company,
 * which prevents a weak ticker match from becoming a misleading notification.
 *
 * One bounded recent window avoids a composite-index dependency. Within that
 * window we rank impact, source substance, relevance and recency locally.
 */
export async function getPushTestNews(uid: string): Promise<PushTestNews | null> {
  const watchlist = await getUserWatchlist(assertDocumentId(uid, "uid"));
  const watchedCompanies = new Map(
    watchlist
      .filter((item) => item.notificationsEnabled !== false)
      .map((item) => [
        String(item.ticker ?? "").trim().toUpperCase(),
        String(item.companyName ?? "").trim() || undefined,
      ] as const)
      .filter(([ticker]) => isSafeDocumentId(ticker))
  );

  const recent = await db.collection("news").orderBy("createdAt", "desc").limit(250).get();
  const stories = recent.docs.map(
    (doc) => ({ id: doc.id, ...doc.data() }) as StoredNewsRecord
  );
  if (stories.length === 0) return null;

  const candidates = stories
    .map((story, recencyIndex) => {
      const ticker = String(story.ticker ?? "").trim().toUpperCase();
      const watched = watchedCompanies.has(ticker);
      const companyName = watchedCompanies.get(ticker);
      const hasSourceMaterial = String(story.summary ?? "").trim().length >= 120;
      const validWatchedMatch = !watched || directlyNamesCompany(story, companyName);
      return {
        story,
        companyName,
        watched,
        eligible: hasSourceMaterial && validWatchedMatch,
        quality: pushStoryQuality(story, recencyIndex),
      };
    })
    .filter((candidate) => candidate.eligible);

  const pool = candidates.some((candidate) => candidate.watched)
    ? candidates.filter((candidate) => candidate.watched)
    : candidates;
  const selected = pool.sort((a, b) => b.quality - a.quality)[0];
  return selected ? { story: selected.story, companyName: selected.companyName } : null;
}

export async function saveNewsItem(item: StoredNews): Promise<void> {
  const { id, ...rest } = item;
  try {
    // create() (not set/merge): the doc id is the dedup key, so a concurrent
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
