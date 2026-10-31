
// Shared token-community messages (Pulse / token page).
// Firestore: communityRooms/{room}/messages/{id}
// Browsers can read; only the backend writes.
// Identity is resolved from the verified account and its linked wallet profile.

import { createHash } from 'node:crypto';

export const ROOM_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const IMG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const PROFILE_PHOTO_MAX = 20000;

export const LIMITS = {
  text: 280,
  by: 24,
  img: 240000,
  minGapMs: 1000
};

const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

export const cleanText = (v, n) =>
  typeof v === 'string'
    ? v.replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
    : '';

export const messageId = (uid, cid) =>
  createHash('sha256').update(uid + ':' + cid).digest('hex').slice(0, 32);

const bad = (status, error) => ({
  status,
  body: { ok: false, error }
});

export function createCommunity({
  db,
  verify,
  linkedWallets,
  now = () => Date.now()
}) {
  if (!db || typeof verify !== 'function') {
    throw new Error('community: db and verify are required');
  }

  const msgs = room =>
    db.collection('communityRooms').doc(room).collection('messages');

  async function post(req, body) {
    const who = await verify(req).catch(() => null);

    if (
      !who ||
      typeof who.uid !== 'string' ||
      !who.uid ||
      who.uid.length > 128
    ) {
      return bad(401, 'Sign in required');
    }

    const uid = who.uid;
    body = body && typeof body === 'object' && !Array.isArray(body)
      ? body
      : {};

    if (typeof body.room !== 'string' || !ROOM_RE.test(body.room)) {
      return bad(400, 'Invalid community');
    }

    if (typeof body.cid !== 'string' || !CID_RE.test(body.cid)) {
      return bad(400, 'Invalid message id');
    }

    const text = cleanText(body.text, LIMITS.text);
    let img = '';

    if (body.img !== undefined && body.img !== null && body.img !== '') {
      if (
        typeof body.img !== 'string' ||
        body.img.length > LIMITS.img ||
        !IMG_RE.test(body.img)
      ) {
        return bad(400, 'Invalid image');
      }

      img = body.img;
    }

    if (!text && !img) return bad(400, 'Empty message');

    if (
      typeof body.text === 'string' &&
      body.text.length > LIMITS.text * 4
    ) {
      return bad(400, 'Message too long');
    }

    // Resolve identity only from a wallet linked to this verified account.
    let wallet = '';
    let by = 'Trader';
    let ph = '';

    if (body.wallet) {
      if (
        typeof body.wallet !== 'string' ||
        !MINT_RE.test(body.wallet) ||
        typeof linkedWallets !== 'function'
      ) {
        return bad(403, 'Invalid linked wallet');
      }

      let wallets = [];

      try {
        wallets = await linkedWallets(uid) || [];
      } catch {
        return bad(500, 'Could not verify linked wallet');
      }

      if (!wallets.includes(body.wallet)) {
        return bad(403, 'This wallet is not linked to your account');
      }

      wallet = body.wallet;

      try {
        const profileSnap = await db
          .collection('profiles')
          .doc(wallet)
          .get();

        if (profileSnap.exists) {
          const profile = profileSnap.data() || {};

          // Profile ownership must match the verified account.
          if (profile.uid !== uid) {
            return bad(403, 'Profile does not belong to this account');
          }

          by =
            cleanText(profile.displayName, LIMITS.by) ||
            cleanText(profile.username, LIMITS.by) ||
            'Trader';

          // Only store the small JPEG data URL supported by the frontend.
          if (
            typeof profile.avatar === 'string' &&
            profile.avatar.length <= PROFILE_PHOTO_MAX &&
            IMG_RE.test(profile.avatar)
          ) {
            ph = profile.avatar;
          }
        }
      } catch {
        return bad(500, 'Could not load account profile');
      }
    }

    const id = messageId(uid, body.cid);
    const t = now();

    const rl = db.collection('communityUsers').doc(uid.replace(/\//g, '_'));

    try {
      await db.runTransaction(async tx => {
        const s = await tx.get(rl);
        const last = s.exists ? Number(s.data().lastAt) || 0 : 0;

        const messageRef = msgs(body.room).doc(id);
        const existing = await tx.get(messageRef);

        if (existing.exists) return;

        if (t - last < LIMITS.minGapMs) {
          const e = new Error('rate');
          e.rate = true;
          throw e;
        }

        tx.set(rl, { lastAt: t });

        tx.create(messageRef, {
          uid,
          by,
          ...(ph ? { ph } : {}),
          text,
          ...(img ? { img } : {}),
          ...(wallet ? { wallet } : {}),
          t,
          cid: body.cid
        });
      });
    } catch (e) {
      if (e && e.rate) {
        return bad(429, 'You’re sending too fast');
      }

      return bad(500, 'Could not save the message');
    }

    return {
      status: 200,
      body: { ok: true, id, t, uid, by, ...(ph ? { ph } : {}) }
    };
  }

  async function remove(req, body) {
    const who = await verify(req).catch(() => null);

    if (!who || typeof who.uid !== 'string' || !who.uid) {
      return bad(401, 'Sign in required');
    }

    body = body && typeof body === 'object' && !Array.isArray(body)
      ? body
      : {};

    if (typeof body.room !== 'string' || !ROOM_RE.test(body.room)) {
      return bad(400, 'Invalid community');
    }

    if (
      typeof body.id !== 'string' ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(body.id)
    ) {
      return bad(400, 'Invalid message id');
    }

    const ref = msgs(body.room).doc(body.id);

    try {
      const s = await ref.get();

      if (!s.exists) return bad(404, 'Message not found');

      if (s.data().uid !== who.uid) {
        return bad(403, 'You can only delete your own messages');
      }

      await ref.delete();
    } catch {
      return bad(500, 'Could not delete the message');
    }

    return {
      status: 200,
      body: { ok: true }
    };
  }

  return { post, remove };
          }
