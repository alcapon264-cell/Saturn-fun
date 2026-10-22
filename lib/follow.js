// Saturn follow backend.
// Firestore collection: follows
// Document ID: {followerWallet}_{followingWallet}

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LIST_LIMIT = 500;

const out = (status, body) => ({ status, body });
const bad = (status, error) => out(status, { ok: false, error });

function docId(follower, following) {
  return `${follower}_${following}`;
}

export function createFollowHandlers({
  db,
  verifyUser,
  linkedWallets,
  publicProfiles,
}) {
  const col = () => db.collection('follows');

  async function followSet(req) {
    const user = await verifyUser(req);

    if (!user || !user.uid) {
      return bad(401, 'sign_in_required');
    }

    const body = (req && req.body) || {};
    const target = body.wallet;

    if (typeof target !== 'string' || !WALLET.test(target)) {
      return bad(400, 'invalid_wallet');
    }

    if (typeof body.follow !== 'boolean') {
      return bad(400, 'invalid_follow');
    }

    const linked = ((await linkedWallets(user.uid)) || [])
      .filter(w => typeof w === 'string' && WALLET.test(w));

    if (!linked.length) {
      return bad(403, 'no_linked_wallet');
    }

    let me;

    if (
      typeof body.from === 'string' &&
      linked.includes(body.from)
    ) {
      me = body.from;
    } else if (linked.length === 1) {
      me = linked[0];
    } else {
      return bad(409, 'wallet_ambiguous');
    }

    if (me === target) {
      return bad(400, 'cannot_follow_self');
    }

    const ref = col().doc(docId(me, target));
    let changed = false;

    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);

      if (body.follow) {
        if (!snap.exists) {
          tx.set(ref, {
            follower: me,
            following: target,
            createdAt: Date.now(),
          });

          changed = true;
        }
      } else {
        if (snap.exists) {
          tx.delete(ref);
          changed = true;
        }
      }
    });

    return out(200, {
      ok: true,
      following: body.follow,
      changed,
    });
  }

  async function wallets(field, wallet) {
    const other =
      field === 'follower'
        ? 'following'
        : 'follower';

    const snap = await col()
      .where(field, '==', wallet)
      .limit(LIST_LIMIT)
      .get();

    const rows = [];

    snap.forEach(doc => {
      const value = doc.data();

      if (
        value &&
        typeof value[other] === 'string'
      ) {
        rows.push(value);
      }
    });

    rows.sort(
      (a, b) =>
        (b.createdAt || 0) -
        (a.createdAt || 0)
    );

    return rows.map(row => row[other]);
  }

  async function followList(req) {
    await verifyUser(req);

    const body = (req && req.body) || {};

    if (
      typeof body.wallet !== 'string' ||
      !WALLET.test(body.wallet)
    ) {
      return bad(400, 'invalid_wallet');
    }

    if (
      body.kind !== 'followers' &&
      body.kind !== 'following'
    ) {
      return bad(400, 'invalid_kind');
    }

    const list = await wallets(
      body.kind === 'followers'
        ? 'following'
        : 'follower',
      body.wallet
    );

    let profiles = [];

    try {
      const result =
        (await publicProfiles(list)) || {};

      const get = wallet =>
        result instanceof Map
          ? result.get(wallet)
          : result[wallet];

      profiles = list
        .map(wallet => {
          const profile = get(wallet);

          if (!profile) {
            return null;
          }

          return {
            wallet,
            username: profile.username || '',
            displayName: profile.displayName || '',
            avatar: profile.avatar || '',
          };
        })
        .filter(Boolean);
    } catch {
      profiles = [];
    }

    return out(200, {
      ok: true,
      kind: body.kind,
      wallets: list,
      profiles,
    });
  }

  async function count(field, wallet) {
    const query = col().where(field, '==', wallet);

    if (typeof query.count === 'function') {
      const snap = await query.count().get();
      return snap.data().count;
    }

    const snap = await query.get();
    return snap.size;
  }

  async function followCounts(req) {
    await verifyUser(req);

    const body = (req && req.body) || {};

    if (
      typeof body.wallet !== 'string' ||
      !WALLET.test(body.wallet)
    ) {
      return bad(400, 'invalid_wallet');
    }

    const [followers, following] = await Promise.all([
      count('following', body.wallet),
      count('follower', body.wallet),
    ]);

    return out(200, {
      ok: true,
      followers,
      following,
    });
  }

  return {
    followSet,
    followList,
    followCounts,
  };
}
