// Shared token-community messages (Pulse / token page).  ESM, no side effects at import time.
//
// Storage : Firestore  communityRooms/{room}/messages/{id}
// Reads   : browsers listen directly (public read, list limited to 100 by firestore.rules)
// Writes  : ONLY here, with the Admin SDK.  Browsers cannot write.
// Identity: verify(req) must return the uid proven by the sign-in token.
import { createHash } from 'node:crypto';

export const ROOM_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const IMG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
export const LIMITS = { text: 280, by: 24, img: 240000, minGapMs: 1000 };
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

export const cleanText = (v, n) => (typeof v === 'string' ? v.replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
export const messageId = (uid, cid) => createHash('sha256').update(uid + ':' + cid).digest('hex').slice(0, 32);

const bad = (status, error) => ({ status, body: { ok: false, error } });

export function createCommunity({ db, verify, linkedWallets, now = () => Date.now() }) {
  if (!db || typeof verify !== 'function') throw new Error('community: db and verify are required');
  const msgs = (room) => db.collection('communityRooms').doc(room).collection('messages');

  async function post(req, body) {
    const who = await verify(req).catch(() => null);
    if (!who || typeof who.uid !== 'string' || !who.uid || who.uid.length > 128) return bad(401, 'Sign in required');
    const uid = who.uid;
    body = body && typeof body === 'object' ? body : {};
    if (typeof body.room !== 'string' || !ROOM_RE.test(body.room)) return bad(400, 'Invalid community');
    if (typeof body.cid !== 'string' || !CID_RE.test(body.cid)) return bad(400, 'Invalid message id');
    const text = cleanText(body.text, LIMITS.text);
    let img = '';
    if (body.img !== undefined && body.img !== null && body.img !== '') {
      if (typeof body.img !== 'string' || body.img.length > LIMITS.img || !IMG_RE.test(body.img)) return bad(400, 'Invalid image');
      img = body.img;
    }
    if (!text && !img) return bad(400, 'Empty message');
    if (typeof body.text === 'string' && body.text.length > LIMITS.text * 4) return bad(400, 'Message too long');

    let wallet = '';
    if (typeof body.wallet === 'string' && MINT_RE.test(body.wallet) && typeof linkedWallets === 'function') {
      try { if ((await linkedWallets(uid) || []).includes(body.wallet)) wallet = body.wallet; } catch { }
    }
    const by = cleanText(body.by, LIMITS.by) || 'Trader';
    const id = messageId(uid, body.cid), t = now();

    const rl = db.collection('communityUsers').doc(uid.replace(/\//g, '_'));
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(rl);
        const last = s.exists ? Number(s.data().lastAt) || 0 : 0;
        const existing = await tx.get(msgs(body.room).doc(id));
        if (existing.exists) return;
        if (t - last < LIMITS.minGapMs) { const e = new Error('rate'); e.rate = true; throw e; }
        tx.set(rl, { lastAt: t });
        tx.create(msgs(body.room).doc(id), { uid, by, text, ...(img ? { img } : {}), ...(wallet ? { wallet } : {}), t, cid: body.cid });
      });
    } catch (e) {
      if (e && e.rate) return bad(429, 'You’re sending too fast');
      return bad(500, 'Could not save the message');
    }
    return { status: 200, body: { ok: true, id, t, uid } };
  }

  async function remove(req, body) {
    const who = await verify(req).catch(() => null);
    if (!who || typeof who.uid !== 'string' || !who.uid) return bad(401, 'Sign in required');
    body = body && typeof body === 'object' ? body : {};
    if (typeof body.room !== 'string' || !ROOM_RE.test(body.room)) return bad(400, 'Invalid community');
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.id)) return bad(400, 'Invalid message id');
    const ref = msgs(body.room).doc(body.id);
    try {
      const s = await ref.get();
      if (!s.exists) return bad(404, 'Message not found');
      if (s.data().uid !== who.uid) return bad(403, 'You can only delete your own messages');
      await ref.delete();
    } catch { return bad(500, 'Could not delete the message'); }
    return { status: 200, body: { ok: true } };
  }
  return { post, remove };
}

export function makeVerifier({ firebaseAuth, privyClient } = {}) {
  return async (req) => {
    const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const m = /^Bearer\s+(\S+)$/.exec(h); if (!m) return null; const token = m[1];
    if (firebaseAuth) { try { const d = await firebaseAuth.verifyIdToken(token); if (d && d.uid) return { uid: String(d.uid) }; } catch { } }
    if (privyClient) { try { const c = await privyClient.verifyAuthToken(token); if (c && c.userId) return { uid: String(c.userId) }; } catch { } }
    return null;
  };
      return null;
  };
}      
