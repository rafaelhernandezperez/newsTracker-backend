import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth = admin.auth();

export async function createUserProfile(uid: string, email: string): Promise<void> {
  await db.collection("users").doc(uid).set(
    {
      email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

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
