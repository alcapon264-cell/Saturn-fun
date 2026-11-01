// Saturn private one-to-one chat. ESM, no side effects at import time.
//
// Storage (Admin SDK only; firestore.rules deny every client read/write):
//   privateChats/{conversationId}                 members, lastMessage, lastAt, unread, lastSent
//   privateChats/{conversationId}/messages/{id}   from (uid), text, t (server time), cid
//
// The conversation id is derived from the two ACCOUNT uids (not wallets), so a user with several
// linked wallets can never end up with two conversations with the same person.
// Authorization rule, enforced on every send/open: the two accounts must follow each other
// (some wallet of A follows some wallet of B AND some wallet of B follows some wallet of A).
// Reading history only needs membership, so history survives an unfollow (sending does not).
import { createHash } from 'node:crypto';

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CONV_RE = /^[a-f0-9]{32}$/;
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;
export const CHAT_LIMITS = { text: 1000, minGapMs: 700, page: 30, maxPage: 50, wallets: 5 };

const bad = (status, error) => ({ status, body: { ok: false, error } });
export const conversationId = (a, b) => createHash('sha256').update([a, b].sort().join('|')).digest('hex').slice(0, 32);
export const messageId = (uid, conv, cid) => createHash('sha256').update(uid + ':' + conv + ':' + cid).digest('hex').slice(0, 32);
export const cleanMessage = v => (typeof v === 'string' ? v.replace(CTRL, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : '');

export function createChat({ db, verify, linkedWallets, walletOwner, isBlocked = async () => false, now = () => Date.now() }) {
  if (!db || typeof verify !== 'function') throw new Error('chat: db and verify are required');
  const convs = () => db.collection('privateChats');

  async function whoAmI(req) {
    const u = await verify(req).catch(() => null);
    return u && typeof u.uid === 'string' && u.uid && u.uid.length <= 128 ? u.uid : null;
  }
  const wallets = async uid => ((await linkedWallets(uid)) || []).filter(w => typeof w === 'string' && WALLET_RE.test(w)).slice(0, CHAT_LIMITS.wallets);
  async function edge(a, b) { const s = await db.collection('follows').doc(a + '_' + b).get(); return !!(s && s.exists); }
  async function accountFollows(wa, wb) { for (const a of wa) for (const b of wb) if (a !== b && await edge(a, b)) return true; return false; }

  // Resolve the OTHER account from a public wallet address, server-side.
  async function resolvePeer(me, wallet) {
    if (typeof wallet !== 'string' || !WALLET_RE.test(wallet)) return { err: bad(400, 'invalid_wallet') };
    const uid = await walletOwner(wallet);
    if (!uid) return { err: bad(404, 'user_not_found') };
    if (uid === me) return { err: bad(400, 'cannot_message_self') };
    // A block in EITHER direction hides the other account entirely (same answer as "no such user").
    if (await isBlocked(me, uid)) return { err: bad(404, 'user_not_found') };
    return { uid };
  }
  async function eligibility(me, peerUid) {
    const [mine, theirs] = [await wallets(me), await wallets(peerUid)];
    const iFollow = await accountFollows(mine, theirs), theyFollow = await accountFollows(theirs, mine);
    return { iFollow, theyFollow, mutual: iFollow && theyFollow, mine, theirs };
  }
  async function identity(uid, ws) {
    for (const w of ws) { try { const s = await db.collection('profiles').doc(w).get(); if (s && s.exists) { const p = s.data() || {}; return { wallet: w, username: p.username || '', displayName: p.displayName || '', avatar: p.avatar || '' }; } } catch { } }
    return { wallet: ws[0] || '', username: '', displayName: '', avatar: '' };
  }

  async function eligibilityRoute(req, b) {
    const me = await whoAmI(req); if (!me) return bad(401, 'sign_in_required');
    const p = await resolvePeer(me, b.wallet); if (p.err) return p.err;
    const e = await eligibility(me, p.uid);
    return { status: 200, body: { ok: true, mutual: e.mutual, iFollow: e.iFollow, theyFollow: e.theyFollow, conversation: conversationId(me, p.uid) } };
  }

  // Creates the conversation document if needed (mutual follow required), or returns the existing one.
  async function open(req, b) {
    const me = await whoAmI(req); if (!me) return bad(401, 'sign_in_required');
    const p = await resolvePeer(me, b.wallet); if (p.err) return p.err;
    const id = conversationId(me, p.uid), ref = convs().doc(id);
    const existing = await ref.get();
    if (existing && existing.exists) return { status: 200, body: { ok: true, conversation: id, created: false } };
    const e = await eligibility(me, p.uid);
    if (!e.mutual) return bad(403, 'mutual_follow_required');
    await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists) tx.set(ref, { members: [me, p.uid].sort(), createdAt: now(), lastAt: 0, lastMessage: null, unread: { [me]: 0, [p.uid]: 0 }, lastSent: {} });
    });
    return { status: 200, body: { ok: true, conversation: id, created: true } };
  }

  async function member(me, id) {
    if (typeof id !== 'string' || !CONV_RE.test(id)) return { err: bad(400, 'invalid_conversation') };
    const s = await convs().doc(id).get();
    // Same answer for "missing" and "not yours": never confirm that someone else's conversation exists.
    if (!s || !s.exists) return { err: bad(404, 'conversation_not_found') };
    const c = s.data();
    if (!c || !Array.isArray(c.members) || !c.members.includes(me)) return { err: bad(404, 'conversation_not_found') };
    const peer = c.members.find(x => x !== me);
    if (await isBlocked(me, peer)) return { err: bad(404, 'conversation_not_found') }; // blocked either way: the conversation is hidden and cannot be used
    return { c, peer };
  }

  async function send(req, b) {
    const me = await whoAmI(req); if (!me) return bad(401, 'sign_in_required');
    if (typeof b.cid !== 'string' || !CID_RE.test(b.cid)) return bad(400, 'invalid_message_id');
    if (typeof b.text !== 'string' || b.text.length > CHAT_LIMITS.text * 4) return bad(400, 'message_too_long');
    const text = cleanMessage(b.text);
    if (!text) return bad(400, 'empty_message');
    if ([...text].length > CHAT_LIMITS.text) return bad(400, 'message_too_long');
    const m = await member(me, b.conversation); if (m.err) return m.err;
    const id = b.conversation, mid = messageId(me, id, b.cid);
    // Mutual follow is re-checked on EVERY send, not only when the conversation was created.
    const e = await eligibility(me, m.peer);
    if (!e.mutual) return bad(403, 'mutual_follow_required');
    const cref = convs().doc(id), mref = cref.collection('messages').doc(mid);
    let result = null;
    await db.runTransaction(async tx => {
      const [cs, ms] = [await tx.get(cref), await tx.get(mref)];
      if (ms.exists) { const d = ms.data(); result = { status: 200, body: { ok: true, id: mid, t: d.t, duplicate: true } }; return; }
      const c = cs.data(), t = now(), last = (c.lastSent || {})[me] || 0;
      if (t - last < CHAT_LIMITS.minGapMs) { result = bad(429, 'too_fast'); return; }
      tx.set(mref, { from: me, text, t, cid: b.cid });
      tx.set(cref, { ...c, lastAt: t, lastMessage: { from: me, text: text.slice(0, 140), t }, lastSent: { ...(c.lastSent || {}), [me]: t }, unread: { ...(c.unread || {}), [m.peer]: ((c.unread || {})[m.peer] || 0) + 1 } });
      result = { status: 200, body: { ok: true, id: mid, t, duplicate: false } };
    });
    return result;
  }

  async function history(req, b) {
    const me = await whoAmI(req); if (!me) return bad(401, 'sign_in_required');
    const m = await member(me, b.conversation); if (m.err) return m.err;
    const limit = Math.min(CHAT_LIMITS.maxPage, Math.max(1, Number.isInteger(b.limit) ? b.limit : CHAT_LIMITS.page));
    let q = convs().doc(b.conversation).collection('messages');
    if (b.before !== undefined && b.before !== null) { if (!Number.isFinite(b.before) || b.before <= 0) return bad(400, 'invalid_cursor'); q = q.where('t', '<', b.before); }
    const snap = await q.orderBy('t', 'desc').limit(limit + 1).get();
    const rows = []; snap.docs.forEach(d => { const v = d.data(); rows.push({ id: d.id, mine: v.from === me, text: v.text, t: v.t }); });
    const more = rows.length > limit; if (more) rows.length = limit;
    const e = await eligibility(me, m.peer);
    // Opening history marks the conversation read for the caller only.
    if (((m.c.unread || {})[me] || 0) > 0) await db.runTransaction(async tx => { const s = await tx.get(convs().doc(b.conversation)); const c = s.data(); tx.set(convs().doc(b.conversation), { ...c, unread: { ...(c.unread || {}), [me]: 0 } }); });
    const peer = { ...(await identity(m.peer, await wallets(m.peer))) };
    return { status: 200, body: { ok: true, messages: rows.reverse(), next: more ? rows[0].t : null, canSend: e.mutual, peer } };
  }

  async function list(req) {
    const me = await whoAmI(req); if (!me) return bad(401, 'sign_in_required');
    const snap = await convs().where('members', 'array-contains', me).limit(50).get();
    const items = [];
    for (const d of snap.docs) {
      const c = d.data(); if (!c || !c.lastMessage) continue; // empty (never-used) conversations are not listed
      const peer = c.members.find(x => x !== me);
      if (await isBlocked(me, peer)) continue;
      items.push({ conversation: d.id, peer: await identity(peer, await wallets(peer)), last: { mine: c.lastMessage.from === me, text: c.lastMessage.text, t: c.lastMessage.t }, unread: (c.unread || {})[me] || 0, lastAt: c.lastAt || 0 });
    }
    items.sort((a, b) => b.lastAt - a.lastAt);
    return { status: 200, body: { ok: true, items } };
  }
  return { eligibility: eligibilityRoute, open, send, history, list };
}
