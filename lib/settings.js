// Saturn account settings: preferences, server-side sessions, blocked traders, problem reports and account deletion.
// ESM, no side effects at import time. All I/O is injected (store = lib/deps.js makeStore, db = Firestore Admin handle,
// auth = Firebase Admin Auth) so everything here is testable with Firestore-shaped fakes. No secrets are held or logged.
//
// Collections (written ONLY through the Admin SDK; firestore.rules deny every client read/write):
//   userSettings/{uid}              preferences (allow-listed keys only)
//   sessions/{sha256(sessionId)}    uid, label, country, createdAt, lastSeen, revokedAt   (the raw session id is never stored)
//   blocks/{blockerUid}__{blockedUid}   blocker, blocked, wallet, createdAt
//   reports/{id}                    uid, category, message, contact, wallet, createdAt, status
//   reportUsers/{uid}               lastAt (rate limit)
//   deletionProofs/{sha256(sig)}    one-time re-authentication proofs for account deletion
//   deletedAccounts/{sha256(uid)}   tombstone: deletedAt only (no personal data)
import crypto from 'node:crypto';

export const SETTING_DEFAULTS = Object.freeze({
  profileVisibility: 'public',
  showBalance: true,
  showPnl: true,
  displayCurrency: 'USD',
  priorityFee: 'medium',
  confirmBeforeSigning: true
});
const VIS = ['public', 'private'], CCY = ['USD', 'SOL'], FEE = ['low', 'medium', 'high'];
export const REPORT_CATEGORIES = ['bug', 'trading', 'wallet', 'account', 'abuse', 'other'];
export const LIMITS = {
  sessionTtlMs: 60 * 24 * 3600 * 1000, maxSessions: 20, touchMs: 5 * 60 * 1000,
  maxBlocks: 200, reportMin: 10, reportMax: 2000, contactMax: 120, reportGapMs: 30000,
  reauthMs: 5 * 60 * 1000, deletePage: 100, deleteMaxPages: 20
};
export const SESSION_HEADER = 'x-saturn-session';
const SID_RE = /^[A-Za-z0-9_-]{20,64}$/;
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

const bad = (status, error, extra = {}) => ({ status, body: { ok: false, error, ...extra } });
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

export function normalizeSettings(c) {
  c = c || {};
  return {
    profileVisibility: c.profileVisibility === 'private' ? 'private' : 'public',
    showBalance: c.showBalance !== false,
    showPnl: c.showPnl !== false,
    displayCurrency: CCY.includes(c.displayCurrency) ? c.displayCurrency : 'USD', // legacy NGN (or anything else) falls back to USD
    priorityFee: FEE.includes(c.priorityFee) ? c.priorityFee : 'medium',
    confirmBeforeSigning: c.confirmBeforeSigning !== false
  };
}

// -> null when valid, else an error code. Unknown keys and wrong types are refused; nothing is coerced.
export function patchError(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'invalid_settings_request';
  const keys = Object.keys(patch);
  if (!keys.length) return 'invalid_settings_request';
  if (keys.some(k => !(k in SETTING_DEFAULTS))) return 'unsupported_setting';
  if (patch.profileVisibility !== undefined && !VIS.includes(patch.profileVisibility)) return 'invalid_profile_visibility';
  if (patch.showBalance !== undefined && typeof patch.showBalance !== 'boolean') return 'invalid_show_balance';
  if (patch.showPnl !== undefined && typeof patch.showPnl !== 'boolean') return 'invalid_show_pnl';
  if (patch.displayCurrency !== undefined && !CCY.includes(patch.displayCurrency)) return 'invalid_display_currency';
  if (patch.priorityFee !== undefined && !FEE.includes(patch.priorityFee)) return 'invalid_priority_fee';
  if (patch.confirmBeforeSigning !== undefined && typeof patch.confirmBeforeSigning !== 'boolean') return 'invalid_confirm_before_signing';
  return null;
}

export function deviceLabel(ua) {
  ua = String(ua || '').slice(0, 300);
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const br = /EdgA?\/|Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return br + ' on ' + os;
}

export const deletionMessage = (uid, wallet, issued) => `Saturn account deletion\nuid:${uid}\nwallet:${wallet}\nissued:${issued}`;

export function createSettings({ store, db = null, auth = null, now = () => Date.now(), verifyWalletSig }) {
  const col = n => { if (!db) throw Object.assign(new Error('db_unavailable'), { unavailable: true }); return db.collection(n); };
  const unavailable = () => bad(503, 'settings_unavailable');

  // ---------- preferences
  const getSettings = async uid => normalizeSettings(await store.get('userSettings/' + uid));
  async function getRoute(user) { return { status: 200, body: { ok: true, settings: await getSettings(user.uid) } }; }
  async function saveRoute(user, b) {
    const e = patchError(b.settings); if (e) return bad(400, e);
    const cur = (await store.get('userSettings/' + user.uid)) || {};
    const next = { ...cur, ...b.settings, uid: user.uid, updatedAt: now() };
    await store.set('userSettings/' + user.uid, next, false);
    return { status: 200, body: { ok: true, settings: normalizeSettings(next) } };
  }

  // ---------- sessions
  // The browser holds the raw session id; the server stores only its SHA-256. A revoked/unknown/foreign/expired id is refused on
  // EVERY authenticated request (see createApp.authenticate). Once an account has registered a session, requests without a valid
  // session id are refused too, so a revoked device cannot recover access by simply omitting the header.
  async function gate(req, user) {
    const h = req.headers && req.headers[SESSION_HEADER];
    const sid = typeof h === 'string' && SID_RE.test(h) ? h : null;
    if (sid) {
      const id = sha(sid), rec = await store.get('sessions/' + id);
      if (!rec || rec.uid !== user.uid) return { ok: false, code: 'session_invalid' };
      if (rec.revokedAt) return { ok: false, code: 'session_revoked' };
      if (now() - (rec.lastSeen || rec.createdAt || 0) > LIMITS.sessionTtlMs) return { ok: false, code: 'session_expired' };
      if (now() - (rec.lastSeen || 0) > LIMITS.touchMs) { try { await store.set('sessions/' + id, { lastSeen: now() }, true); } catch { /* best effort */ } }
      return { ok: true, sessionId: id };
    }
    const acct = await store.get('users/' + user.uid);
    if (acct && acct.sessionsEnforced) return { ok: false, code: 'session_required' };
    return { ok: true, sessionId: null };
  }

  async function activeSessions(uid) {
    const snap = await col('sessions').where('uid', '==', uid).limit(100).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !s.revokedAt && now() - (s.lastSeen || s.createdAt || 0) <= LIMITS.sessionTtlMs);
  }
  const pub = (s, cur) => ({ id: s.id, label: s.label || 'Browser', country: s.country || '', createdAt: s.createdAt || 0, lastSeen: s.lastSeen || s.createdAt || 0, current: s.id === cur });

  async function register(req, user) {
    const list = await activeSessions(user.uid);
    if (list.length >= LIMITS.maxSessions) { // prune the least recently used so a user can never be locked out by stale devices
      list.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
      for (const s of list.slice(0, list.length - LIMITS.maxSessions + 1)) await store.set('sessions/' + s.id, { revokedAt: now(), revokedReason: 'pruned' }, true);
    }
    const sid = crypto.randomBytes(24).toString('base64url'), id = sha(sid), t = now();
    const c = req.headers && typeof req.headers['x-vercel-ip-country'] === 'string' && /^[A-Za-z]{2}$/.test(req.headers['x-vercel-ip-country']) ? req.headers['x-vercel-ip-country'].toUpperCase() : '';
    const rec = { uid: user.uid, label: deviceLabel(req.headers && req.headers['user-agent']), country: c, createdAt: t, lastSeen: t };
    await store.create('sessions/' + id, rec);
    await store.set('users/' + user.uid, { uid: user.uid, sessionsEnforced: true, updatedAt: t }, true);
    return { status: 200, body: { ok: true, sessionId: sid, session: pub({ id, ...rec }, id) } };
  }
  async function listSessions(user, cur) {
    const list = (await activeSessions(user.uid)).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return { status: 200, body: { ok: true, sessions: list.map(s => pub(s, cur)), currentKnown: !!cur } };
  }
  async function revoke(user, cur, b) {
    if (typeof b.id !== 'string' || !/^[a-f0-9]{64}$/.test(b.id)) return bad(400, 'invalid_session');
    if (b.id === cur) return bad(400, 'cannot_revoke_current_session');
    const rec = await store.get('sessions/' + b.id);
    if (!rec || rec.uid !== user.uid) return bad(404, 'session_not_found'); // same answer for "missing" and "not yours"
    if (!rec.revokedAt) await store.set('sessions/' + b.id, { revokedAt: now(), revokedReason: 'user' }, true);
    return { status: 200, body: { ok: true, revoked: 1 } };
  }
  async function revokeOthers(user, cur) {
    if (!cur) return bad(400, 'current_session_unknown'); // never guess which one is "current"
    let n = 0;
    for (const s of await activeSessions(user.uid)) if (s.id !== cur) { await store.set('sessions/' + s.id, { revokedAt: now(), revokedReason: 'user_others' }, true); n++; }
    return { status: 200, body: { ok: true, revoked: n } };
  }
  async function endCurrent(cur) {
    if (cur) await store.set('sessions/' + cur, { revokedAt: now(), revokedReason: 'sign_out' }, true);
    return { status: 200, body: { ok: true } };
  }
  async function revokeAll(uid) {
    let n = 0;
    for (const s of await activeSessions(uid)) { await store.set('sessions/' + s.id, { revokedAt: now(), revokedReason: 'account_deleted' }, true); n++; }
    return n;
  }

  // ---------- blocks (uid-keyed; enforced server-side everywhere an account interacts with another)
  const blockKey = (a, b) => 'blocks/' + a + '__' + b;
  async function blockedEitherWay(a, b) {
    if (!a || !b || a === b) return false;
    return !!(await store.get(blockKey(a, b))) || !!(await store.get(blockKey(b, a)));
  }
  async function blockedWallets(uid) { // wallets the account has blocked (used by the browser to hide community posts)
    const snap = await col('blocks').where('blocker', '==', uid).limit(LIMITS.maxBlocks).get();
    return snap.docs.map(d => d.data());
  }
  async function listBlocks(user) {
    const rows = (await blockedWallets(user.uid)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const items = [];
    for (const r of rows) {
      const p = r.wallet ? await store.get('profiles/' + r.wallet) : null;
      items.push({ wallet: r.wallet, username: (p && p.username) || '', displayName: (p && p.displayName) || '', avatar: (p && p.avatar) || '', createdAt: r.createdAt || 0 });
    }
    return { status: 200, body: { ok: true, items } };
  }
  async function block(user, b) {
    if (typeof b.wallet !== 'string' || !WALLET_RE.test(b.wallet)) return bad(400, 'invalid_wallet');
    const link = await store.get('walletLinks/' + b.wallet);
    if (!link || typeof link.uid !== 'string' || !link.uid) return bad(404, 'not_a_saturn_user'); // nothing server-side to restrict for a wallet with no account
    if (link.uid === user.uid) return bad(400, 'cannot_block_self');
    if ((await blockedWallets(user.uid)).length >= LIMITS.maxBlocks && !(await store.get(blockKey(user.uid, link.uid)))) return bad(409, 'block_limit_reached');
    const created = await store.create(blockKey(user.uid, link.uid), { blocker: user.uid, blocked: link.uid, wallet: b.wallet, createdAt: now() });
    // A block also dissolves follow edges in both directions between ALL linked wallets of the two accounts.
    const mine = ((await store.get('users/' + user.uid)) || {}).wallets || [], theirs = ((await store.get('users/' + link.uid)) || {}).wallets || [];
    let removed = 0;
    for (const a of mine) for (const t of theirs) for (const [x, y] of [[a, t], [t, a]]) {
      const ref = db.doc('follows/' + x + '_' + y), s = await ref.get();
      if (s && s.exists) { await ref.delete(); removed++; }
    }
    return { status: 200, body: { ok: true, blocked: true, duplicate: !created, followsRemoved: removed } };
  }
  async function unblock(user, b) {
    if (typeof b.wallet !== 'string' || !WALLET_RE.test(b.wallet)) return bad(400, 'invalid_wallet');
    const snap = await col('blocks').where('blocker', '==', user.uid).where('wallet', '==', b.wallet).limit(5).get();
    let n = 0; for (const d of snap.docs) { await d.ref.delete(); n++; }
    return { status: 200, body: { ok: true, blocked: false, removed: n } };
  }

  // ---------- reports
  const clean = (v, max) => typeof v === 'string' ? v.normalize('NFC').replace(CTRL, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '';
  async function report(req, user, b) {
    if (!REPORT_CATEGORIES.includes(b.category)) return bad(400, 'invalid_category');
    if (typeof b.message !== 'string' || b.message.length > LIMITS.reportMax * 4) return bad(400, 'message_too_long');
    const message = clean(b.message, LIMITS.reportMax + 1);
    if (message.length < LIMITS.reportMin) return bad(400, 'message_too_short');
    if (message.length > LIMITS.reportMax) return bad(400, 'message_too_long');
    const contact = b.contact == null || b.contact === '' ? '' : clean(b.contact, LIMITS.contactMax + 1);
    if (contact.length > LIMITS.contactMax) return bad(400, 'contact_too_long');
    let wallet = '';
    if (b.wallet != null && b.wallet !== '') {
      if (typeof b.wallet !== 'string' || !WALLET_RE.test(b.wallet)) return bad(400, 'invalid_wallet');
      wallet = b.wallet;
    }
    const appVersion = clean(b.appVersion, 60);
    const t = now(), id = sha(user.uid + ':' + t + ':' + crypto.randomBytes(8).toString('hex')).slice(0, 24);
    const rl = col('reportUsers').doc(String(user.uid).replace(/\//g, '_'));
    let limited = false;
    await db.runTransaction(async tx => {
      const s = await tx.get(rl), last = s.exists ? Number(s.data().lastAt) || 0 : 0;
      if (t - last < LIMITS.reportGapMs) { limited = true; return; }
      tx.set(rl, { lastAt: t });
      tx.create(col('reports').doc(id), { uid: user.uid, category: b.category, message, contact: contact || null, wallet: wallet || null, appVersion, userAgent: clean(req.headers && req.headers['user-agent'], 200), createdAt: t, status: 'new' });
    });
    if (limited) return bad(429, 'too_fast');
    return { status: 200, body: { ok: true, id } }; // returned only after the document was written
  }

  // ---------- account deletion
  async function reauthOk(user, b) {
    // Accept (a) a Firebase sign-in that happened within the last 5 minutes, or (b) a fresh signature from a wallet linked to this account.
    if (user.provider === 'firebase' && typeof user.auth_time === 'number' && Math.abs(now() / 1000 - user.auth_time) <= LIMITS.reauthMs / 1000) return { ok: true };
    const p = b.proof;
    if (!p || typeof p !== 'object' || typeof p.wallet !== 'string' || typeof p.message !== 'string' || typeof p.signature !== 'string' || !WALLET_RE.test(p.wallet)) return { ok: false };
    const m = /^Saturn account deletion\nuid:(.+)\nwallet:(.+)\nissued:(\d+)$/.exec(p.message);
    if (!m || m[1] !== user.uid || m[2] !== p.wallet || Math.abs(now() - Number(m[3])) > LIMITS.reauthMs) return { ok: false };
    const link = await store.get('walletLinks/' + p.wallet);
    if (!link || link.uid !== user.uid) return { ok: false };
    if (typeof verifyWalletSig !== 'function' || !verifyWalletSig(p.wallet, p.message, p.signature)) return { ok: false };
    return { ok: true, proofId: sha(p.signature) };
  }

  async function purge(query, perDoc) {
    let n = 0;
    for (let i = 0; i < LIMITS.deleteMaxPages; i++) {
      const snap = await query().get();
      if (!snap.docs.length) return n;
      for (const d of snap.docs) { await perDoc(d); n++; }
      if (snap.docs.length < LIMITS.deletePage) return n;
    }
    const more = await query().get();
    if (more.docs.length) throw new Error('too_many_documents');
    return n;
  }

  async function deleteAccount(req, user, b) {
    if (b.confirm !== 'DELETE') return bad(400, 'confirmation_required');
    const re = await reauthOk(user, b);
    if (!re.ok) return bad(401, 'reauth_required');
    if (re.proofId) { if (!(await store.create('deletionProofs/' + re.proofId, { at: now() }))) return bad(401, 'reauth_required'); } // a proof works once
    const uid = user.uid, done = {}, pending = [];
    const step = async (name, fn) => { try { done[name] = await fn(); } catch { pending.push(name); } };
    const acct = (await store.get('users/' + uid)) || {};
    const wallets = new Set(Array.isArray(acct.wallets) ? acct.wallets : []);
    try { (await col('walletLinks').where('uid', '==', uid).limit(100).get()).docs.forEach(d => wallets.add(d.id)); } catch { pending.push('wallet_links_lookup'); }
    const W = [...wallets];
    const del = d => d.ref.delete();

    await step('profiles', async () => { let n = 0; for (const w of W) { if (await store.get('profiles/' + w)) { await store.profileRemove(w); n++; } } return n; });
    await step('follows', async () => { let n = 0; for (const w of W) for (const f of ['follower', 'following']) n += await purge(() => col('follows').where(f, '==', w).limit(LIMITS.deletePage), del); return n; });
    await step('notifications', async () => { let n = await purge(() => col('notifications').where('uid', '==', uid).limit(LIMITS.deletePage), del); for (const w of W) n += await purge(() => col('notifications').where('from', '==', w).limit(LIMITS.deletePage), del); return n; });
    await step('blocks', async () => (await purge(() => col('blocks').where('blocker', '==', uid).limit(LIMITS.deletePage), del)) + (await purge(() => col('blocks').where('blocked', '==', uid).limit(LIMITS.deletePage), del)));
    await step('private_chats', async () => purge(() => col('privateChats').where('members', 'array-contains', uid).limit(LIMITS.deletePage), async d => {
      await purge(() => col('privateChats/' + d.id + '/messages').limit(LIMITS.deletePage), del); await d.ref.delete();
    }));
    await step('community_messages', async () => purge(() => db.collectionGroup('messages').where('uid', '==', uid).limit(LIMITS.deletePage), del));
    await step('events_anonymized', async () => purge(() => col('events').where('uid', '==', uid).limit(LIMITS.deletePage), d => d.ref.set({ uid: null }, { merge: true })));
    await step('reports_anonymized', async () => purge(() => col('reports').where('uid', '==', uid).limit(LIMITS.deletePage), d => d.ref.set({ uid: null, contact: null, wallet: null }, { merge: true })));
    await step('wallet_links', async () => { let n = 0; for (const w of W) { const l = await store.get('walletLinks/' + w); if (l && l.uid === uid) { await db.doc('walletLinks/' + w).delete(); n++; } } return n; });
    await step('identity_links', async () => { let n = 0; for (const p of ['identityLinks/' + uid, 'identityLinks/fb_' + uid]) { const s = await db.doc(p).get(); if (s && s.exists) { const o = s.data() || {}; await db.doc(p).delete(); n++; for (const q of ['identityLinks/' + (o.privy || ''), 'identityLinks/fb_' + (o.firebaseUid || '')]) { if (q.endsWith('/') || q.endsWith('fb_')) continue; const sq = await db.doc(q).get(); if (sq && sq.exists) await db.doc(q).delete(); } } } return n; });
    await step('settings', async () => { await db.doc('userSettings/' + uid).delete(); await db.doc('communityUsers/' + String(uid).replace(/\//g, '_')).delete(); await db.doc('reportUsers/' + String(uid).replace(/\//g, '_')).delete(); return 1; });
    if (pending.length) return bad(500, 'deletion_incomplete', { pending, note: 'Nothing about your sign-in was removed. Fix the listed items (see the delivery notes) or try again.' });

    // Only after every data step succeeded: end every session, delete the account record, then the sign-in record.
    done.sessions_revoked = await revokeAll(uid);
    await db.doc('users/' + uid).delete();
    await store.set('deletedAccounts/' + sha(uid), { deletedAt: now() }, false);
    done.sign_in_record = 'kept';
    if (user.provider === 'firebase' && auth && typeof auth.deleteUser === 'function') { try { await auth.deleteUser(uid); done.sign_in_record = 'deleted'; } catch { done.sign_in_record = 'delete_failed'; } }
    return { status: 200, body: { ok: true, deleted: done, retained: ['wallet_and_assets_on_chain', 'on_chain_trade_history', 'anonymized_trade_records', 'anonymized_reports'], signInRecord: done.sign_in_record } };
  }

  // ---------- dispatcher for POST /api/settings
  async function handle(req, user, b, { limited }) {
    const a = b.action;
    const sens = (name, max) => limited(req, name, max) ? bad(429, 'too_many_requests') : null;
    try {
      switch (a) {
        case 'get': return await getRoute(user);
        case 'save': return await saveRoute(user, b);
        case 'session-register': return sens('settings-session', 20) || await register(req, user);
        case 'session-list': return await listSessions(user, user.sessionId || null);
        case 'session-revoke': return sens('settings-revoke', 30) || await revoke(user, user.sessionId || null, b);
        case 'session-revoke-others': return sens('settings-revoke', 30) || await revokeOthers(user, user.sessionId || null);
        case 'session-end': return await endCurrent(user.sessionId || null);
        case 'blocks-list': return await listBlocks(user);
        case 'block': return sens('settings-block', 30) || await block(user, b);
        case 'unblock': return sens('settings-block', 30) || await unblock(user, b);
        case 'report': return sens('settings-report', 10) || await report(req, user, b);
        case 'delete-account': return sens('settings-delete', 3) || await deleteAccount(req, user, b);
        default: return bad(400, 'invalid_settings_request');
      }
    } catch (e) {
      if (e && e.unavailable) return unavailable();
      return bad(500, 'settings_error');
    }
  }

  return { handle, gate, getSettings, blockedEitherWay, blockedWallets };
}
