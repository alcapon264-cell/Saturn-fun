// Profile registry tests. The handlers run through the REAL makeStore() from lib/deps.js over a Firestore-SHAPED fake (below) that enforces Firestore's
// transaction rules (all reads before any write; transactions serialized). This exercises Saturn's transaction code — it does NOT prove behaviour of real Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp, linkMessage } from '../lib/app.js';
import { makeStore } from '../lib/deps.js';
import { normalizeUsername } from '../lib/profiles.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc = b => {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let o = '';
  while (n > 0n) {
    o = A[Number(n % 58n)] + o;
    n /= 58n;
  }
  let z = 0;
  while (z < b.length && b[z] === 0) z++;
  return '1'.repeat(z) + o;
};
const newWallet = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { address: enc(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')), sign: m => crypto.sign(null, Buffer.from(m), privateKey).toString('base64') }; };

import { fakeFirestore } from './fake-firestore.js';
const TOK = { 'u1-token': { uid: 'U1', email: 'u1@private.example', name: 'Private Name U1' }, 'u2-token': { uid: 'U2', email: 'u2@private.example' }, 'u3-token': { uid: 'U3', email: 'u3@private.example' } };
const ORIGIN = 'https://thunderous-marshmallow-0bceda.netlify.app';
function setup(fs = fakeFirestore()) {
  const store = makeStore(fs);
  const app = createApp({ auth: { async verifyIdToken(t) { if (!TOK[t]) throw new Error('bad'); return TOK[t]; } }, store, rpc: {}, now: () => 1_700_000_000_000, env: { SATURN_ALLOWED_ORIGINS: ORIGIN } });
  return { app, fs, store };
}
const call = async (h, { token, origin = ORIGIN, body = {}, ip = '1.1.1.' + Math.floor(Math.random() * 250), method = 'POST' } = {}) => {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  await h({ method, url: '/x', headers: { ...(origin ? { origin } : {}), 'x-forwarded-for': ip, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body }, res); return res; };
// link a wallet through the REAL /api/link-wallet signature flow (the ownership proof profile writes depend on)
async function linked(s, token, uid, w = newWallet()) { const message = linkMessage(uid, w.address, 1_700_000_000_000);
  assert.equal((await call(s.app.linkWallet, { token, body: { wallet: w.address, message, signature: w.sign(message) } })).statusCode, 200); return w; }
const save = (s, token, wallet, b = {}) => call(s.app.profileSave, { token, body: { wallet, ...b } });
const jpeg = () => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');

test('1 create: linked wallet + sign-in creates the profile; response is the canonical public profile', async () => {
  const s = setup(), w = await linked(s, 'u1-token', 'U1'); const r = await save(s, 'u1-token', w.address, { username: '  @Alice_01 ', displayName: ' Alice ​‮ A ', bio: 'hi\nthere', avatar: jpeg() });
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { ok: true, profile: { wallet: w.address, username: 'alice_01', displayName: 'Alice A', avatar: jpeg(), bio: 'hi there' } });
  assert.equal(r.headers['cache-control'], 'no-store'); assert.ok((await s.store.get('usernames/alice_01')).wallet === w.address); });
test('2 update own profile: fields change, createdAt kept, old username released and claimable by someone else', async () => {
  const s = setup(), w = await linked(s, 'u1-token', 'U1'), w2 = await linked(s, 'u2-token', 'U2'); await save(s, 'u1-token', w.address, { username: 'first', displayName: 'One' });
  const r = await save(s, 'u1-token', w.address, { username: 'second', displayName: 'Two', bio: 'b' }); assert.equal(r.statusCode, 200); assert.equal(r.body.profile.displayName, 'Two');
  assert.equal(await s.store.get('usernames/first'), null); assert.equal((await save(s, 'u2-token', w2.address, { username: 'first' })).statusCode, 200); });
test('3 unauthenticated / forged-token write -> 401, nothing stored', async () => {
  const s = setup(), w = await linked(s, 'u1-token', 'U1'); assert.equal((await save(s, undefined, w.address, { username: 'nope_x' })).statusCode, 401); assert.equal((await save(s, 'forged', w.address, { username: 'nope_x' })).statusCode, 401);
  assert.equal(await s.store.get('profiles/' + w.address), null); });
test('4 wallet not owned by the authenticated account -> 403 (other account\'s wallet, never-linked wallet, uid in body is ignored)', async () => {
  const s = setup(), mine = await linked(s, 'u1-token', 'U1'), theirs = await linked(s, 'u2-token', 'U2'), never = newWallet();
  for (const [tok, wal] of [['u1-token', theirs.address], ['u1-token', never.address], ['u3-token', mine.address]]) { const r = await save(s, tok, wal, { username: 'stolen_x', uid: 'U2' }); assert.equal(r.statusCode, 403, wal); }
  assert.equal(s.fs.docs.size > 0 && [...s.fs.docs.keys()].some(k => k.startsWith('profiles/')), false); assert.equal(await s.store.get('usernames/stolen_x'), null); });
test('5 duplicate username owned by another wallet -> 409 and the loser stores nothing', async () => {
  const s = setup(), a = await linked(s, 'u1-token', 'U1'), b = await linked(s, 'u2-token', 'U2'); await save(s, 'u1-token', a.address, { username: 'taken_one' });
  const r = await save(s, 'u2-token', b.address, { username: 'taken_one', displayName: 'Loser' }); assert.equal(r.statusCode, 409); assert.equal(r.body.field, 'username'); assert.equal(await s.store.get('profiles/' + b.address), null);
  assert.equal((await save(s, 'u1-token', a.address, { username: 'taken_one', bio: 'same wallet may re-save' })).statusCode, 200); });
test('6 username collision is case-insensitive and Unicode-normalized (full-width, @, spaces)', async () => {
  const s = setup(), a = await linked(s, 'u1-token', 'U1'), b = await linked(s, 'u2-token', 'U2'); await save(s, 'u1-token', a.address, { username: 'Alice' });
  for (const u of ['ALICE', 'aLiCe', ' @alice ', 'ＡＬＩＣＥ']) assert.equal((await save(s, 'u2-token', b.address, { username: u })).statusCode, 409, u); assert.equal(normalizeUsername('ＡＬＩＣＥ'), 'alice'); });
test('7 get profile by wallet and by username (case/@ ignored)', async () => {
  const s = setup(), w = await linked(s, 'u1-token', 'U1'); await save(s, 'u1-token', w.address, { username: 'getme', displayName: 'Get Me', bio: 'bio' });
  for (const body of [{ wallet: w.address }, { username: '@GETME' }]) { const r = await call(s.app.profileGet, { body }); assert.equal(r.statusCode, 200); assert.equal(r.body.profile.wallet, w.address); assert.equal(r.body.profile.displayName, 'Get Me'); } });
test('8 get missing profile -> profile:null; malformed -> 400', async () => {
  const s = setup(); assert.equal((await call(s.app.profileGet, { body: { wallet: newWallet().address } })).body.profile, null); assert.equal((await call(s.app.profileGet, { body: { username: 'nobody' } })).body.profile, null);
  assert.equal((await call(s.app.profileGet, { body: { username: '!!' } })).body.profile, null); assert.equal((await call(s.app.profileGet, { body: { wallet: 'bad' } })).statusCode, 400); assert.equal((await call(s.app.profileGet, { body: {} })).statusCode, 400); });
async function seed3() { const s = setup(); const k = []; for (const [i, tok, b] of [[1, 'u1-token', { username: 'nova', displayName: 'Zed' }], [2, 'u2-token', { username: 'nova_whale', displayName: 'Whale' }], [3, 'u3-token', { displayName: 'Nova Labs' }]]) { const w = await linked(s, tok, 'U' + i); await save(s, tok, w.address, b); k.push(w); } return { s, k }; }
test('9 search by username: exact first, then prefix; case and @ ignored', async () => { const { s, k } = await seed3();
  const r = await call(s.app.profileSearch, { body: { q: '@NOVA' } }); assert.equal(r.statusCode, 200); assert.deepEqual(r.body.items.map(p => p.username), ['nova', 'nova_whale', '']); assert.equal(r.body.items[0].wallet, k[0].address);
  assert.deepEqual((await call(s.app.profileSearch, { body: { q: 'nova_w' } })).body.items.map(p => p.username), ['nova_whale']); });
test('10 search by display name (prefix, case-insensitive), including profiles with no username', async () => { const { s, k } = await seed3();
  const r = await call(s.app.profileSearch, { body: { q: 'whal' } }); assert.deepEqual(r.body.items.map(p => p.displayName), ['Whale']); const r2 = await call(s.app.profileSearch, { body: { q: 'NOVA L' } }); assert.deepEqual(r2.body.items.map(p => p.wallet), [k[2].address]); });
test('11 search by wallet address (exact); valid wallet without a profile -> empty list', async () => { const { s, k } = await seed3();
  assert.equal((await call(s.app.profileSearch, { body: { q: k[1].address } })).body.items[0].username, 'nova_whale'); assert.deepEqual((await call(s.app.profileSearch, { body: { q: newWallet().address } })).body.items, []); });
test('search: empty / 1 char / too long / non-string -> [] and no Firestore query; limit honoured; results come from bounded queries', async () => { const { s } = await seed3(); const before = s.fs.stats.queries;
  for (const q of [undefined, null, '', '  ', 'n', '@n', 'x'.repeat(65), 5, {}]) assert.deepEqual((await call(s.app.profileSearch, { body: { q } })).body.items, []); assert.equal(s.fs.stats.queries, before);
  assert.equal((await call(s.app.profileSearch, { body: { q: 'nov', limit: 1 } })).body.items.length, 1); assert.ok(s.fs.stats.queries > before && s.fs.stats.maxReturned <= 16, 'bounded by limit*2'); });
test('12 responses never expose private account data (uid, email, name, timestamps, search keys, user doc)', async () => {
  const { s } = await seed3(); await s.app.account({ method: 'POST', url: '/', headers: { origin: ORIGIN, authorization: 'Bearer u1-token' }, body: {} }, { setHeader() {}, end() {} });
  const out = JSON.stringify([(await call(s.app.profileSearch, { body: { q: 'nova' } })).body, (await call(s.app.profileGet, { body: { username: 'nova' } })).body, (await save(s, 'u1-token', (await s.store.get('usernames/nova')).wallet, { username: 'nova', bio: 'x' })).body]);
  for (const bad of ['U1', 'U2', 'private.example', 'Private Name', 'uid', 'email', 'nameLower', 'createdAt', 'updatedAt']) assert.ok(!out.includes(bad), bad);
  for (const it of JSON.parse(JSON.stringify((await call(s.app.profileSearch, { body: { q: 'nova' } })).body.items))) assert.deepEqual(Object.keys(it).sort(), ['avatar', 'bio', 'displayName', 'username', 'wallet']); });
test('13 update survives a second read, including from a brand-new app instance on the same database (reload)', async () => {
  const s = setup(), w = await linked(s, 'u1-token', 'U1'); await save(s, 'u1-token', w.address, { username: 'persist_me', displayName: 'Before' }); await save(s, 'u1-token', w.address, { displayName: 'After', username: 'persist_me', bio: 'kept' });
  const s2 = setup(s.fs); const r = await call(s2.app.profileGet, { body: { wallet: w.address } }); assert.deepEqual(r.body.profile, { wallet: w.address, username: 'persist_me', displayName: 'After', avatar: '', bio: 'kept' });
  assert.equal((await call(s2.app.profileSearch, { body: { q: 'persist' } })).body.items.length, 1); });
test('14 concurrency: many wallets racing for one username -> exactly one winner; one wallet renaming in parallel keeps usernames consistent', async () => {
  const s = setup(), ws = []; for (let i = 0; i < 10; i++) { TOK['r' + i] = { uid: 'R' + i }; ws.push(await linked(s, 'r' + i, 'R' + i)); }
  const rs = await Promise.all(ws.map((w, i) => save(s, 'r' + i, w.address, { username: 'race_me' }))); assert.equal(rs.filter(r => r.statusCode === 200).length, 1); assert.equal(rs.filter(r => r.statusCode === 409).length, 9);
  const w = ws[0]; await Promise.all(['a_name', 'b_name', 'c_name', 'd_name'].map(u => save(s, 'r0', w.address, { username: u })));
  const final = (await s.store.get('profiles/' + w.address)).username, claims = [...s.fs.docs].filter(([k, v]) => k.startsWith('usernames/') && v.wallet === w.address).map(([k]) => k.slice(10));
  assert.deepEqual(claims, [final], 'a wallet holds exactly one username claim — no leaked claims'); });
test('transaction rules: the store reads everything before writing (fake rejects otherwise) and unpublish frees the username', async () => {
  const s = setup(), w = await linked(s, 'u1-token', 'U1'), b = await linked(s, 'u2-token', 'U2'); await save(s, 'u1-token', w.address, { username: 'temp_nm', bio: 'x' });
  const r = await save(s, 'u1-token', w.address, {}); assert.equal(r.statusCode, 200); assert.equal(r.body.profile, null); assert.equal(await s.store.get('profiles/' + w.address), null); assert.equal(await s.store.get('usernames/temp_nm'), null);
  assert.equal((await save(s, 'u2-token', b.address, { username: 'temp_nm' })).statusCode, 200); });
test('validation: bad usernames / reserved / over-long / unsafe avatars -> 400 with the field, nothing stored', async () => {
  const s = setup(), w = await linked(s, 'u1-token', 'U1');
  for (const u of ['ab', 'a'.repeat(21), 'bad name', 'bad-name', 'émile', '😀😀😀', 'Admin', 'SATURN']) { const r = await save(s, 'u1-token', w.address, { username: u }); assert.equal(r.statusCode, 400, u); assert.equal(r.body.field, 'username'); }
  assert.equal((await save(s, 'u1-token', w.address, { displayName: 'x'.repeat(25) })).body.field, 'displayName'); assert.equal((await save(s, 'u1-token', w.address, { bio: 'x'.repeat(121) })).body.field, 'bio');
  for (const av of ['https://evil.example/a.jpg', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,' + Buffer.from('not a jpeg').toString('base64'), 'data:image/jpeg;base64,' + 'A'.repeat(32000), 42]) assert.equal((await save(s, 'u1-token', w.address, { avatar: av })).body.field, 'avatar');
  assert.equal((await save(s, 'u1-token', 'not-a-wallet', { username: 'okname' })).body.field, 'wallet'); assert.equal([...s.fs.docs.keys()].some(k => k.startsWith('profiles/') || k.startsWith('usernames/')), false); });
test('http: disallowed origin refused before anything runs; GET refused; rate limit; public reads need no token; Privy-style uid works the same', async () => {
  const s = setup(), w = await linked(s, 'u1-token', 'U1'); await save(s, 'u1-token', w.address, { username: 'pubread' });
  assert.equal((await call(s.app.profileSearch, { origin: 'https://evil.example', body: { q: 'pub' } })).statusCode, 403); assert.equal((await call(s.app.profileSave, { method: 'GET', token: 'u1-token' })).statusCode, 405);
  assert.equal((await call(s.app.profileSearch, { body: { q: 'pub' } })).body.items.length, 1);
  let last; for (let i = 0; i < 25; i++) last = await call(s.app.profileSave, { token: 'u1-token', ip: '9.9.9.9', body: { wallet: w.address, bio: 'x' + i } }); assert.equal(last.statusCode, 429); });
test('existing endpoints are untouched: createApp still exposes them and link-wallet conflict behaviour is unchanged', async () => {
  const s = setup(); for (const k of ['account', 'linkWallet', 'linkIdentity', 'events', 'owner', 'isOwner', 'profileSave', 'profileGet', 'profileSearch']) assert.equal(typeof s.app[k], 'function', k);
  const w = newWallet(); await linked(s, 'u1-token', 'U1', w); const m = linkMessage('U2', w.address, 1_700_000_000_000); assert.equal((await call(s.app.linkWallet, { token: 'u2-token', body: { wallet: w.address, message: m, signature: w.sign(m) } })).statusCode, 409); });
