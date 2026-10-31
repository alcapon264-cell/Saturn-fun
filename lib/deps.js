// Production wiring. Secrets come ONLY from environment variables (never committed).
// firebase-admin is imported lazily so unit tests need no credentials.

import { createApp } from './app.js';

// The Firestore-backed store. Exported so the exact same code can be exercised
// in tests with a Firestore-shaped fake.
export function makeStore(fs) {
  return {
    async get(p) {
      const s = await fs.doc(p).get();
      return s.exists ? s.data() : null;
    },

    async set(p, d, merge) {
      await fs.doc(p).set(d, { merge: !!merge });
    },

    async create(p, d) {
      try {
        await fs.doc(p).create(d);
        return true;
      } catch (e) {
        if (e.code === 6) return false;
        throw e;
      }
    },

    async getUsername(username) {
      const s = await fs.doc('usernames/' + username).get();
      return s.exists ? s.data() : null;
    },

    // Atomic: both documents are read and created inside ONE Firestore transaction.
    async createPair(pa, da, pb, db) {
      return fs.runTransaction(async t => {
        const ra = fs.doc(pa);
        const rb = fs.doc(pb);

        const [a, b] = await Promise.all([
          t.get(ra),
          t.get(rb),
        ]);

        if (a.exists || b.exists) {
          return {
            created: false,
            a: a.exists ? a.data() : null,
            b: b.exists ? b.data() : null,
          };
        }

        t.create(ra, da);
        t.create(rb, db);

        return { created: true };
      });
    },

    async list(c, { limit, orderBy = 'recordedAt' }) {
      return (
        await fs
          .collection(c)
          .orderBy(orderBy, 'desc')
          .limit(limit)
          .get()
      ).docs.map(d => d.data());
    },

    // ---- profile registry
    async profileUpsert(rec) {
      return fs.runTransaction(async t => {
        const pr = fs.doc('profiles/' + rec.wallet);
        const prevS = await t.get(pr);
        const prev = prevS.exists ? prevS.data() : null;

        const ur = rec.username
          ? fs.doc('usernames/' + rec.username)
          : null;

        const us = ur ? await t.get(ur) : null;

        if (
          us &&
          us.exists &&
          us.data().wallet !== rec.wallet
        ) {
          return { conflict: 'username' };
        }

        if (
          prev &&
          prev.username &&
          prev.username !== rec.username
        ) {
          t.delete(fs.doc('usernames/' + prev.username));
        }

        if (ur) {
          t.set(ur, {
            wallet: rec.wallet,
            uid: rec.uid,
            claimedAt: rec.updatedAt,
          });
        }

        const stored = {
          ...rec,
          createdAt: prev
            ? prev.createdAt
            : rec.updatedAt,
        };

        t.set(pr, stored);

        return {
          ok: true,
          profile: stored,
        };
      });
    },

    async profileRemove(wallet) {
      return fs.runTransaction(async t => {
        const pr = fs.doc('profiles/' + wallet);
        const s = await t.get(pr);

        if (!s.exists) return;

        const u = s.data().username;

        t.delete(pr);

        if (u) {
          t.delete(fs.doc('usernames/' + u));
        }
      });
    },

    // Prefix range query on one indexed field.
    async prefix(c, field, q, n) {
      return (
        await fs
          .collection(c)
          .where(field, '>=', q)
          .where(field, '<', q + '\uf8ff')
          .limit(n)
          .get()
      ).docs.map(d => d.data());
    },

    // ---------------------------------------------------------
    // FOLLOW SYSTEM
    // ---------------------------------------------------------

    async followSet(follower, following, shouldFollow) {
      const ref = fs
        .collection('follows')
        .doc(`${follower}_${following}`);

      return fs.runTransaction(async t => {
        const snap = await t.get(ref);

        if (shouldFollow) {
          if (snap.exists) {
            return { changed: false };
          }

          t.create(ref, {
            follower,
            following,
            createdAt: Date.now(),
          });

          return { changed: true };
        }

        if (!snap.exists) {
          return { changed: false };
        }

        t.delete(ref);

        return { changed: true };
      });
    },

    async followList(field, wallet, limit = 500) {
      const other =
        field === 'follower'
          ? 'following'
          : 'follower';

      const snap = await fs
        .collection('follows')
        .where(field, '==', wallet)
        .limit(limit)
        .get();

      const rows = snap.docs.map(d => d.data());

      rows.sort(
        (a, b) =>
          (b.createdAt || 0) -
          (a.createdAt || 0)
      );

      return rows
        .map(row => row[other])
        .filter(
          wallet =>
            typeof wallet === 'string'
        );
    },

    async followCount(field, wallet) {
      const query = fs
        .collection('follows')
        .where(field, '==', wallet);

      if (typeof query.count === 'function') {
        const snap = await query.count().get();
        return snap.data().count;
      }

      const snap = await query.get();

      return snap.size;
    },
  };
}

let cached;

export async function getApp() {
  if (cached) return cached;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const rpcUrl = process.env.SOLANA_RPC_URL;

  if (!raw || !rpcUrl) {
    throw new Error(
      'Backend not configured (FIREBASE_SERVICE_ACCOUNT_JSON / SOLANA_RPC_URL).'
    );
  }

  const {
    initializeApp,
    cert,
    getApps,
  } = await import('firebase-admin/app');

  const { getAuth } =
    await import('firebase-admin/auth');

  const { getFirestore } =
    await import('firebase-admin/firestore');

  if (!getApps().length) {
    initializeApp({
      credential: cert(JSON.parse(raw)),
    });
  }

  const fs = getFirestore();
  const store = makeStore(fs);

  const rpc = {
  async forward(payload) {
  const forwarded = { ...payload };

  // Saturn's fee pre-check needs the actual inner token transfer.
  // Some Solana RPCs return stale/incomplete account post-state
  // when simulateTransaction.accounts is requested.
  if (
    forwarded.method === 'simulateTransaction' &&
    Array.isArray(forwarded.params)
  ) {
    const p = [...forwarded.params];

    if (
      p[1] &&
      typeof p[1] === 'object' &&
      p[1].accounts
    ) {
      p[1] = { ...p[1] };
      delete p[1].accounts;
      p[1].innerInstructions = true;
    }

    forwarded.params = p;
  }

  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(forwarded),
  });

  return await r.json();
},  
    async getTransaction(sig) {
      const r = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            sig,
            {
              encoding: 'jsonParsed',
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            },
          ],
        }),
      });

      const j = await r.json();

      if (j.error) {
        throw new Error('rpc');
      }

      return j.result;
    },
  };

  cached = createApp({
    auth: getAuth(),
    store,
    rpc,
   env: process.env,
   db: fs,
  });

  return cached;
}
