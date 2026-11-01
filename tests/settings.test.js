// Settings backend tests. Handlers run through the REAL makeStore() (lib/deps.js) over a Firestore-SHAPED fake
// (tests/fake-firestore.js). This proves Saturn's logic, NOT the behaviour of real Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp, linkMessage } from '../lib/app.js';
import { makeStore } from '../lib/deps.js';
import { deletionMessage, normalizeSettings } from '../lib/settings.js';
import { fakeFirestore } from './fake-firestore.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc = b => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } for (const x of b) { if (x === 0) o = '1' + o; else break; } return o; };
const newWallet = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { address: enc(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')), sign: m => crypto.sign(null, Buffer.from(m), privateKey).toString('base64') }; };
const NOW = 1_700_000_000_000, ORIGIN = 'https://site.test';
const FRESH = NOW / 1000 - 10, STALE = NOW / 1000 - 3600;
const TOK = { t1: { uid: 'U1', auth_time: STALE }, t1fresh: { uid: 'U1', auth_time: FRESH }, t2: { uid: 'U2', auth_time: STALE }, t3: { uid: 'U3', auth_time: STALE } };
let ip = 0;

function setup() {
  const fs = fakeFirestore(), store = makeStore(fs), deleted = []; let clock = NOW;
  const app = createApp({ auth: { async verifyIdToken(t) { if (!TOK[t]) throw new Error('bad'); return { ...TOK[t] }; }, async deleteUser(u) { deleted.push(u); } }, store, rpc: {}, db: fs, now: () => clock, env: { SATURN_ALLOWED_ORIGINS: ORIGIN } });
  const call = async (h, token, body = {}, { sid, ua, fixedIp, origin = ORIGIN } = {}) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
    await h({ method: 'POST', url: '/x', headers: { origin, 'x-forwarded-for': fixedIp || '9.9.' + (++ip >> 8) + '.' + (ip & 255), ...(ua ? { 'user-agent': ua } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(sid ? { 'x-saturn-session': sid } : {}) }, body, query: {} }, res); return res; };
  const st = (token, body, o) => call(app.settings, token, body, o);
  const link = async (token, uid, w = newWallet()) => { const m = linkMessage(uid, w.address, clock); assert.equal((await call(app.linkWallet, token, { wallet: w.address, message: m, signature: w.sign(m) })).statusCode, 200); return w; };
  const profile = (token, w, username) => call(app.profileSave, token, { wallet: w.address, username, displayName: username });
  const follow = (a, b) => fs.docs.set('follows/' + a + '_' + b, { follower: a, following: b, createdAt: 1 });
  return { app, fs, store, st, call, link, profile, follow, deleted, tick: ms => { clock += ms; } };
}

// ---------------------------------------------------------------- preferences
test('settings: unauthenticated, forged-token and wrong-origin requests are refused', async () => {
  const s = setup();
  assert.equal((await s.st(null, { action: 'get' })).statusCode, 401);
  assert.equal((await s.st('forged', { action: 'get' })).statusCode, 401);
  assert.equal((await s.st('t1', { action: 'get' }, { origin: 'https://evil.test' })).statusCode, 403);
  for (const a of ['save', 'session-list', 'blocks-list', 'block', 'report', 'delete-account']) assert.equal((await s.st(null, { action: a })).statusCode, 401, a);
});
test('settings: defaults, saving every preference, and persistence across a brand-new app instance', async () => {
  const s = setup(); const d = await s.st('t1', { action: 'get' });
  assert.deepEqual(d.body.settings, { profileVisibility: 'public', showBalance: true, showPnl: true, displayCurrency: 'USD', priorityFee: 'medium', confirmBeforeSigning: true });
  for (const patch of [{ profileVisibility: 'private' }, { showBalance: false }, { showPnl: false }, { displayCurrency: 'SOL' }, { priorityFee: 'high' }, { priorityFee: 'low' }, { confirmBeforeSigning: false }]) {
    const r = await s.st('t1', { action: 'save', settings: patch }); assert.equal(r.statusCode, 200, JSON.stringify(patch)); assert.equal(r.body.ok, true);
    for (const [k, v] of Object.entries(patch)) assert.equal(r.body.settings[k], v);
  }
  const store2 = makeStore(s.fs), app2 = createApp({ auth: { async verifyIdToken(t) { return { ...TOK[t] }; } }, store: store2, rpc: {}, db: s.fs, now: () => NOW, env: { SATURN_ALLOWED_ORIGINS: ORIGIN } });
  const again = await s.call(app2.settings, 't1', { action: 'get' });
  assert.deepEqual(again.body.settings, { profileVisibility: 'private', showBalance: false, showPnl: false, displayCurrency: 'SOL', priorityFee: 'low', confirmBeforeSigning: false });
});
test('settings: NGN is gone (rejected on save, legacy stored NGN reads back as USD) and invalid input never changes stored data', async () => {
  const s = setup();
  assert.equal((await s.st('t1', { action: 'save', settings: { displayCurrency: 'NGN' } })).body.error, 'invalid_display_currency');
  for (const bad of [{ admin: true }, { showBalance: 'false' }, { displayCurrency: 'BTC' }, { priorityFee: 'ultra' }, { profileVisibility: 'friends' }, { confirmBeforeSigning: 1 }, {}, []])
    assert.equal((await s.st('t1', { action: 'save', settings: bad })).statusCode, 400, JSON.stringify(bad));
  assert.equal((await s.st('t1', { action: 'save' })).statusCode, 400); assert.equal((await s.st('t1', { action: 'nope' })).statusCode, 400);
  assert.equal(s.fs.docs.has('userSettings/U1'), false);
  s.fs.docs.set('userSettings/U1', { displayCurrency: 'NGN', priorityFee: 'turbo' });
  assert.equal(normalizeSettings({ displayCurrency: 'NGN' }).displayCurrency, 'USD');
  const g = await s.st('t1', { action: 'get' }); assert.equal(g.body.settings.displayCurrency, 'USD'); assert.equal(g.body.settings.priorityFee, 'medium');
});
test('settings: user isolation (a UID in the body is ignored; one user never sees another user\'s preferences)', async () => {
  const s = setup();
  await s.st('t1', { action: 'save', settings: { profileVisibility: 'private', displayCurrency: 'SOL' }, uid: 'U2' });
  const u2 = await s.st('t2', { action: 'get', uid: 'U1' }); assert.equal(u2.body.settings.profileVisibility, 'public'); assert.equal(u2.body.settings.displayCurrency, 'USD');
  assert.equal(s.fs.docs.has('userSettings/U2'), false); assert.equal(s.fs.docs.get('userSettings/U1').uid, 'U1');
});

// ---------------------------------------------------------------- sessions
test('sessions: register, list, per-device revoke, current session cannot be revoked, revoke-others spares the current one', async () => {
  const s = setup();
  const a = await s.st('t1', { action: 'session-register' }, { ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36' }); assert.equal(a.statusCode, 200); const sa = a.body.sessionId;
  assert.equal(a.body.session.label, 'Chrome on Android'); assert.ok(!JSON.stringify([...s.fs.docs.keys()]).includes(sa), 'raw session id is never stored');
  const b = await s.st('t1', { action: 'session-register' }, { sid: sa, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' }); const sb = b.body.sessionId;
  const c = await s.st('t1', { action: 'session-register' }, { ua: 'Mozilla/5.0 (Windows NT 10.0) Firefox/120' }); const sc = c.body.sessionId;
  const list = await s.st('t1', { action: 'session-list' }, { sid: sa }); assert.equal(list.body.sessions.length, 3);
  assert.deepEqual(list.body.sessions.filter(x => x.current).map(x => x.label), ['Chrome on Android']);
  const idB = b.body.session.id, idA = a.body.session.id;
  const self = await s.st('t1', { action: 'session-revoke', id: idA }, { sid: sa }); assert.equal(self.statusCode, 400); assert.equal(self.body.error, 'cannot_revoke_current_session');
  assert.equal((await s.st('t1', { action: 'session-revoke', id: idB }, { sid: sa })).statusCode, 200);
  const dead = await s.st('t1', { action: 'get' }, { sid: sb }); assert.equal(dead.statusCode, 401); assert.equal(dead.body.code, 'session_revoked');
  assert.equal((await s.st('t1', { action: 'get' }, { sid: sa })).statusCode, 200);
  const o = await s.st('t1', { action: 'session-revoke-others' }, { sid: sa }); assert.equal(o.body.revoked, 1);
  assert.equal((await s.st('t1', { action: 'get' }, { sid: sc })).statusCode, 401);
  assert.equal((await s.st('t1', { action: 'get' }, { sid: sa })).statusCode, 200);
  assert.equal((await s.st('t1', { action: 'session-list' }, { sid: sa })).body.sessions.length, 1);
});
test('sessions: enforcement is server-side on EVERY authenticated route, including when the header is simply omitted', async () => {
  const s = setup(); const w = await s.link('t1', 'U1'); const sid = (await s.st('t1', { action: 'session-register' })).body.sessionId; await s.st('t1', { action: 'session-revoke-others' }, { sid });
  assert.equal((await s.call(s.app.account, 't1', {})).statusCode, 401, 'headerless token refused once the account uses sessions');
  assert.equal((await s.call(s.app.account, 't1', {}, { sid })).statusCode, 200);
  assert.equal((await s.call(s.app.notificationsList, 't1', {})).statusCode, 401);
  assert.equal((await s.call(s.app.chatList, 't1', {})).statusCode, 401);
  assert.equal((await s.call(s.app.profileSave, 't1', { wallet: w.address, username: 'abc_one' })).statusCode, 401);
  assert.equal((await s.call(s.app.profileSave, 't1', { wallet: w.address, username: 'abc_one' }, { sid })).statusCode, 200);
  const stolen = await s.st('t1', { action: 'get' }, { sid: 'x'.repeat(30) }); assert.equal(stolen.statusCode, 401); // unknown id
});
test('sessions: another account\'s session id is unusable, and you cannot list or revoke another account\'s sessions', async () => {
  const s = setup(); const a = await s.st('t1', { action: 'session-register' }); const b = await s.st('t2', { action: 'session-register' });
  assert.equal((await s.st('t2', { action: 'get' }, { sid: a.body.sessionId })).statusCode, 401);
  assert.equal((await s.st('t2', { action: 'session-revoke', id: a.body.session.id }, { sid: b.body.sessionId })).statusCode, 404);
  assert.equal((await s.st('t1', { action: 'get' }, { sid: a.body.sessionId })).statusCode, 200);
  assert.equal((await s.st('t2', { action: 'session-revoke', id: 'nothex' }, { sid: b.body.sessionId })).statusCode, 400);
});
test('sessions: sign-out ends the session, idle sessions expire, and revoke-others needs a known current session', async () => {
  const s = setup(); const a = await s.st('t1', { action: 'session-register' }); const sid = a.body.sessionId;
  assert.equal((await s.st('t1', { action: 'session-revoke-others' }, {})).statusCode, 401);   // enforced: no header => refused
  assert.equal((await s.st('t1', { action: 'session-end' }, { sid })).statusCode, 200);
  assert.equal((await s.st('t1', { action: 'get' }, { sid })).body.code, 'session_revoked');
  const b = await s.st('t1', { action: 'session-register' }); s.tick(61 * 24 * 3600 * 1000);
  assert.equal((await s.st('t1', { action: 'get' }, { sid: b.body.sessionId })).body.code, 'session_expired');
});

// ---------------------------------------------------------------- privacy enforcement via direct API calls
test('privacy: a Private profile is invisible to search/profile-get/follow-lists for everyone but its owner; Public flips back', async () => {
  const s = setup(); const w1 = await s.link('t1', 'U1'), w2 = await s.link('t2', 'U2'); await s.profile('t1', w1, 'alice_x'); await s.profile('t2', w2, 'bob_x');
  const search = (tok, q) => s.call(s.app.profileSearch, tok, { q });
  assert.equal((await search(null, 'alice')).body.items.length, 1);
  await s.st('t1', { action: 'save', settings: { profileVisibility: 'private' } });
  assert.equal((await search(null, 'alice')).body.items.length, 0); assert.equal((await search('t2', 'alice')).body.items.length, 0); assert.equal((await search('t2', w1.address)).body.items.length, 0);
  assert.equal((await search('t1', 'alice')).body.items.length, 1, 'owner still sees own profile');
  for (const body of [{ wallet: w1.address }, { username: 'alice_x' }]) { assert.equal((await s.call(s.app.profileGet, null, body)).body.profile, null); assert.equal((await s.call(s.app.profileGet, 't2', body)).body.profile, null); assert.equal((await s.call(s.app.profileGet, 't1', body)).body.profile.username, 'alice_x'); }
  s.follow(w2.address, w1.address);
  const lst = await s.call(s.app.followList, 't2', { wallet: w2.address, kind: 'following' }); assert.deepEqual(lst.body.wallets, [], 'private account removed from other users\' following lists');
  await s.st('t1', { action: 'save', settings: { profileVisibility: 'public' } });
  assert.equal((await search(null, 'alice')).body.items.length, 1);
  assert.equal((await s.call(s.app.followList, 't2', { wallet: w2.address, kind: 'following' })).body.wallets.length, 1);
});
test('privacy: profile-get reports showBalance/showPnl from the owner\'s server-side settings; hidden profiles expose neither', async () => {
  const s = setup(); const w1 = await s.link('t1', 'U1'); await s.profile('t1', w1, 'carol_x');
  assert.deepEqual((await s.call(s.app.profileGet, null, { wallet: w1.address })).body.privacy, { showBalance: true, showPnl: true });
  await s.st('t1', { action: 'save', settings: { showBalance: false } });
  assert.deepEqual((await s.call(s.app.profileGet, null, { wallet: w1.address })).body.privacy, { showBalance: false, showPnl: true });
  await s.st('t1', { action: 'save', settings: { showPnl: false, profileVisibility: 'private' } });
  const hidden = await s.call(s.app.profileGet, 't2', { wallet: w1.address }); assert.equal(hidden.body.profile, null); assert.deepEqual(hidden.body.privacy, { showBalance: false, showPnl: false });
  assert.deepEqual((await s.call(s.app.profileGet, 't1', { wallet: w1.address })).body.privacy, { showBalance: false, showPnl: false });
  const unknown = newWallet().address; assert.deepEqual((await s.call(s.app.profileGet, null, { wallet: unknown })).body.privacy, { showBalance: true, showPnl: true });
});
test('privacy: a Private account\'s community posts carry no name, photo or wallet', async () => {
  const s = setup(); const w1 = await s.link('t1', 'U1'); await s.profile('t1', w1, 'dave_x'); const room = newWallet().address;
  const post = async cid => s.call(s.app.communityPost, 't1', { room, cid, text: 'gm', wallet: w1.address });
  const r1 = await post('cid-public-1'); assert.equal(r1.statusCode, 200); assert.equal(r1.body.by, 'dave_x');
  await s.st('t1', { action: 'save', settings: { profileVisibility: 'private' } }); s.tick(5000);
  const r2 = await post('cid-private-1'); assert.equal(r2.body.by, 'Trader');
  const stored = [...s.fs.docs].filter(([k]) => k.includes('/messages/')).map(([, v]) => v).find(v => v.cid === 'cid-private-1'); assert.equal(stored.wallet, undefined); assert.equal(stored.ph, undefined);
});

// ---------------------------------------------------------------- blocked traders
async function pair() { const s = setup(); const w1 = await s.link('t1', 'U1'), w2 = await s.link('t2', 'U2'); await s.profile('t1', w1, 'alice_x'); await s.profile('t2', w2, 'bob_x'); return { s, w1, w2 }; }
test('blocks: block/list/unblock persist, validate input, and refuse self / non-Saturn wallets', async () => {
  const { s, w1, w2 } = await pair();
  assert.equal((await s.st('t1', { action: 'block', wallet: w2.address })).statusCode, 200);
  const l = await s.st('t1', { action: 'blocks-list' }); assert.deepEqual(l.body.items.map(i => [i.wallet, i.username]), [[w2.address, 'bob_x']]);
  assert.equal((await s.st('t2', { action: 'blocks-list' })).body.items.length, 0, 'the blocked person does not see the block');
  assert.equal((await s.st('t1', { action: 'block', wallet: w2.address })).body.duplicate, true);
  assert.equal((await s.st('t1', { action: 'block', wallet: w1.address })).body.error, 'cannot_block_self');
  assert.equal((await s.st('t1', { action: 'block', wallet: w1.address + 'x'.repeat(40) })).statusCode, 400);
  assert.equal((await s.st('t1', { action: 'block', wallet: newWallet().address })).body.error, 'not_a_saturn_user');
  assert.equal((await s.st('t1', { action: 'unblock', wallet: w2.address })).statusCode, 200); assert.equal((await s.st('t1', { action: 'blocks-list' })).body.items.length, 0);
});
test('blocks: enforced in search, profile lookup and follow in BOTH directions, and block removes existing follows', async () => {
  const { s, w1, w2 } = await pair(); s.follow(w1.address, w2.address); s.follow(w2.address, w1.address);
  const b = await s.st('t1', { action: 'block', wallet: w2.address }); assert.equal(b.body.followsRemoved, 2); assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('follows/')).length, 0);
  for (const [tok, q] of [['t1', 'bob'], ['t2', 'alice']]) assert.equal((await s.call(s.app.profileSearch, tok, { q })).body.items.length, 0);
  assert.equal((await s.call(s.app.profileGet, 't1', { wallet: w2.address })).body.profile, null); assert.equal((await s.call(s.app.profileGet, 't2', { username: 'alice_x' })).body.profile, null);
  const f1 = await s.call(s.app.followSet, 't1', { wallet: w2.address, from: w1.address, follow: true }); assert.equal(f1.statusCode, 403); assert.equal(f1.body.error, 'blocked');
  assert.equal((await s.call(s.app.followSet, 't2', { wallet: w1.address, from: w2.address, follow: true })).statusCode, 403);
  assert.equal((await s.call(s.app.profileSearch, null, { q: 'bob' })).body.items.length, 1, 'signed-out visitors are unaffected');
  await s.st('t1', { action: 'unblock', wallet: w2.address });
  assert.equal((await s.call(s.app.profileSearch, 't1', { q: 'bob' })).body.items.length, 1); assert.equal((await s.call(s.app.followSet, 't1', { wallet: w2.address, from: w1.address, follow: true })).statusCode, 200);
});
test('blocks: private chat is unusable in both directions via direct API (open, send, history, list, eligibility) and returns after unblock', async () => {
  const { s, w1, w2 } = await pair(); s.follow(w1.address, w2.address); s.follow(w2.address, w1.address);
  const o = await s.call(s.app.chatOpen, 't1', { wallet: w2.address }); assert.equal(o.statusCode, 200); const conv = o.body.conversation;
  assert.equal((await s.call(s.app.chatSend, 't1', { conversation: conv, cid: 'cid-aaaaaaaa', text: 'hi' })).statusCode, 200);
  s.follow(w1.address, w2.address); s.follow(w2.address, w1.address);
  await s.st('t2', { action: 'block', wallet: w1.address }); s.follow(w1.address, w2.address); s.follow(w2.address, w1.address); // follows re-created directly in the DB: the block must still win
  for (const tok of ['t1', 't2']) {
    const other = tok === 't1' ? w2.address : w1.address;
    assert.equal((await s.call(s.app.chatOpen, tok, { wallet: other })).statusCode, 404);
    assert.equal((await s.call(s.app.chatEligibility, tok, { wallet: other })).statusCode, 404);
    assert.equal((await s.call(s.app.chatSend, tok, { conversation: conv, cid: 'cid-bbbbbbbb', text: 'x' })).statusCode, 404);
    assert.equal((await s.call(s.app.chatHistory, tok, { conversation: conv })).statusCode, 404);
    assert.equal((await s.call(s.app.chatList, tok, {})).body.items.length, 0);
  }
  await s.st('t2', { action: 'unblock', wallet: w1.address }); s.tick(5000);
  assert.equal((await s.call(s.app.chatHistory, 't1', { conversation: conv })).statusCode, 200); assert.equal((await s.call(s.app.chatList, 't2', {})).body.items.length, 1);
});
test('blocks: no follow or trade notification is created across a block', async () => {
  const { s, w1, w2 } = await pair(); await s.st('t1', { action: 'block', wallet: w2.address });
  await s.call(s.app.followSet, 't2', { wallet: w1.address, from: w2.address, follow: true });
  assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('notifications/follow_')).length, 0);
});

// ---------------------------------------------------------------- reports
test('reports: validated, stored only with a real write, success only after the write, rate limited, authenticated', async () => {
  const s = setup(); const ok = { action: 'report', category: 'bug', message: 'The chart does not load on my phone.', contact: 'me@example.com', appVersion: 'index-46', wallet: newWallet().address };
  const r = await s.st('t1', ok); assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true); assert.ok(r.body.id);
  const saved = s.fs.docs.get('reports/' + r.body.id); assert.equal(saved.uid, 'U1'); assert.equal(saved.category, 'bug'); assert.equal(saved.status, 'new');
  assert.equal((await s.st('t1', ok)).body.error, 'too_fast'); assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('reports/')).length, 1);
  s.tick(31000);
  for (const [patch, err] of [[{ category: 'nope' }, 'invalid_category'], [{ message: 'short' }, 'message_too_short'], [{ message: 'x'.repeat(2001) }, 'message_too_long'], [{ message: 5 }, 'message_too_long'], [{ contact: 'c'.repeat(121) }, 'contact_too_long'], [{ wallet: 'bad' }, 'invalid_wallet']]) {
    const x = await s.st('t1', { ...ok, ...patch }); assert.equal(x.statusCode, 400, JSON.stringify(patch)); assert.equal(x.body.error, err, JSON.stringify(patch)); }
  assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('reports/')).length, 1, 'rejected reports are never stored');
  assert.equal((await s.st(null, ok)).statusCode, 401);
});
test('reports: if storage fails the API does NOT report success', async () => {
  const s = setup(); const real = s.fs.runTransaction.bind(s.fs); s.fs.runTransaction = async () => { throw new Error('firestore down'); };
  const r = await s.st('t1', { action: 'report', category: 'bug', message: 'Something is wrong with the app.' }); assert.equal(r.statusCode, 500); assert.notEqual(r.body.ok, true); s.fs.runTransaction = real;
  assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('reports/')).length, 0);
});

// ---------------------------------------------------------------- account deletion
async function populated() {
  const { s, w1, w2 } = await pair(); const third = await s.link('t3', 'U3');
  s.follow(w1.address, w2.address); s.follow(w2.address, w1.address); s.follow(third.address, w1.address);
  const conv = (await s.call(s.app.chatOpen, 't1', { wallet: w2.address })).body.conversation; await s.call(s.app.chatSend, 't1', { conversation: conv, cid: 'cid-aaaaaaaa', text: 'hello' });
  const room = newWallet().address; await s.call(s.app.communityPost, 't1', { room, cid: 'cid-room-001', text: 'gm', wallet: w1.address }); await s.call(s.app.communityPost, 't2', { room, cid: 'cid-room-002', text: 'gm2', wallet: w2.address });
  await s.st('t1', { action: 'save', settings: { displayCurrency: 'SOL' } }); await s.st('t3', { action: 'block', wallet: w1.address });
  s.fs.docs.set('events/sig1', { type: 'trade', uid: 'U1', wallet: w1.address, side: 'buy' }); s.fs.docs.set('notifications/n1', { uid: 'U1', type: 'welcome' }); s.fs.docs.set('notifications/n2', { uid: 'U2', type: 'follow', from: w1.address });
  s.tick(40000); await s.st('t1', { action: 'report', category: 'other', message: 'A report written before deletion.', contact: 'me@example.com' });
  return { s, w1, w2, third, conv };
}
const keysOf = (s, prefix) => [...s.fs.docs.keys()].filter(k => k.startsWith(prefix));
test('delete: refuses without typed confirmation or without recent re-authentication, and deletes nothing in either case', async () => {
  const { s } = await populated(); const before = s.fs.docs.size;
  assert.equal((await s.st('t1', { action: 'delete-account' })).body.error, 'confirmation_required');
  assert.equal((await s.st('t1', { action: 'delete-account', confirm: 'delete' })).body.error, 'confirmation_required');
  const re = await s.st('t1', { action: 'delete-account', confirm: 'DELETE' }); assert.equal(re.statusCode, 401); assert.equal(re.body.error, 'reauth_required');
  assert.equal(s.fs.docs.size, before); assert.deepEqual(s.deleted, []);
});
test('delete: re-authentication by a fresh sign-in deletes Saturn data, ends sessions, anonymizes records and leaves other users untouched', async () => {
  const { s, w1, w2, third } = await populated(); const sid = (await s.st('t1fresh', { action: 'session-register' })).body.sessionId;
  const r = await s.st('t1fresh', { action: 'delete-account', confirm: 'DELETE' }, { sid }); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true); assert.ok(r.body.retained.includes('wallet_and_assets_on_chain'));
  for (const p of ['users/U1', 'userSettings/U1', 'profiles/' + w1.address, 'usernames/alice_x', 'walletLinks/' + w1.address, 'notifications/n1', 'notifications/n2']) assert.equal(s.fs.docs.has(p), false, p);
  assert.equal(keysOf(s, 'follows/').filter(k => k.includes(w1.address)).length, 0, 'every follow edge touching the deleted account is gone');
  assert.equal(keysOf(s, 'privateChats').length, 0); assert.equal(keysOf(s, 'blocks/').length, 0);
  assert.equal([...s.fs.docs].filter(([k, v]) => k.includes('/messages/') && v.uid === 'U1').length, 0, 'community messages removed');
  assert.equal([...s.fs.docs].filter(([k, v]) => k.includes('/messages/') && v.uid === 'U2').length, 1, 'other users\' community messages survive');
  assert.equal(s.fs.docs.get('events/sig1').uid, null); assert.equal(s.fs.docs.get('events/sig1').wallet, w1.address, 'on-chain trade facts are kept');
  const rep = [...s.fs.docs].find(([k]) => k.startsWith('reports/'))[1]; assert.deepEqual([rep.uid, rep.contact], [null, null]); assert.ok(rep.message);
  assert.equal(s.fs.docs.has('profiles/' + w2.address), true); assert.equal(s.fs.docs.has('walletLinks/' + third.address), true); assert.equal(s.fs.docs.has('users/U2'), true);
  assert.equal([...s.fs.docs].filter(([k]) => k.startsWith('sessions/')).every(([, v]) => v.revokedAt), true); assert.deepEqual(s.deleted, ['U1']); assert.ok([...s.fs.docs.keys()].some(k => k.startsWith('deletedAccounts/')));
  assert.equal((await s.st('t1fresh', { action: 'get' }, { sid })).statusCode, 401);
  assert.equal((await s.call(s.app.profileSearch, null, { q: 'alice' })).body.items.length, 0);
});
test('delete: wallet-signature re-authentication works for accounts without a fresh sign-in, rejects bad/foreign/stale proofs and each proof works once', async () => {
  const { s, w1 } = await populated(); const msg = (u, w, t) => deletionMessage(u, w, t);
  const bad = async proof => (await s.st('t1', { action: 'delete-account', confirm: 'DELETE', proof })).statusCode;
  const other = newWallet();
  assert.equal(await bad({ wallet: w1.address, message: msg('U1', w1.address, NOW), signature: Buffer.alloc(64).toString('base64') }), 401, 'invalid signature');
  assert.equal(await bad({ wallet: other.address, message: msg('U1', other.address, NOW), signature: other.sign(msg('U1', other.address, NOW)) }), 401, 'wallet not linked to this account');
  assert.equal(await bad({ wallet: w1.address, message: msg('U2', w1.address, NOW), signature: w1.sign(msg('U2', w1.address, NOW)) }), 401, 'message for another uid');
  assert.equal(await bad({ wallet: w1.address, message: msg('U1', w1.address, NOW - 6 * 60000), signature: w1.sign(msg('U1', w1.address, NOW - 6 * 60000)) }), 401, 'stale');
  assert.equal(s.fs.docs.has('users/U1'), true);
  const m = msg('U1', w1.address, NOW), proof = { wallet: w1.address, message: m, signature: w1.sign(m) };
  assert.equal((await s.st('t1', { action: 'delete-account', confirm: 'DELETE', proof })).statusCode, 200); assert.equal(s.fs.docs.has('users/U1'), false);
  assert.equal((await s.st('t1', { action: 'delete-account', confirm: 'DELETE', proof })).statusCode, 401, 'replayed proof refused');
});
test('delete: wallets and on-chain data are never touched, and a partial failure leaves the account and its sessions intact', async () => {
  const { s, w1 } = await populated(); const sid = (await s.st('t1fresh', { action: 'session-register' })).body.sessionId; s.fs.failCollectionGroup = true;
  const r = await s.st('t1fresh', { action: 'delete-account', confirm: 'DELETE' }, { sid }); assert.equal(r.statusCode, 500); assert.equal(r.body.error, 'deletion_incomplete'); assert.deepEqual(r.body.pending, ['community_messages']);
  assert.equal(s.fs.docs.has('users/U1'), true); assert.deepEqual(s.deleted, []); assert.equal((await s.st('t1fresh', { action: 'get' }, { sid })).statusCode, 200, 'still signed in so the user can retry');
  s.fs.failCollectionGroup = false; s.tick(31000);
  assert.equal((await s.st('t1fresh', { action: 'delete-account', confirm: 'DELETE' }, { sid })).statusCode, 200, 'retry completes'); assert.equal(s.fs.docs.has('users/U1'), false);
  assert.ok(w1.address); // no code path exists that signs or sends anything on-chain; the module has no RPC dependency
});
test('rate limits: delete, report and session registration are throttled per client', async () => {
  const s = setup(); const o = { fixedIp: '7.7.7.7' };
  const codes = []; for (let i = 0; i < 5; i++) codes.push((await s.st('t1', { action: 'delete-account', confirm: 'DELETE' }, o)).statusCode);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  const regs = []; for (let i = 0; i < 22; i++) regs.push((await s.st('t2', { action: 'session-register' }, { fixedIp: '8.8.8.8' })).statusCode); assert.equal(regs[0], 200); assert.equal(regs[regs.length - 1], 429);
});
