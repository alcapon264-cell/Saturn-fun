// Proven account linking. Privy tokens are REAL ES256 JWTs verified by the real verifier; Firebase Admin and Firestore are stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../lib/app.js';

const APP = 'cmv1ke5s6006p0fjruyd2obw5', ORIGIN = 'https://thunderous-marshmallow-0bceda.netlify.app', NOW = 1_700_000_000_000;
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }), PEM = publicKey.export({ type: 'spki', format: 'pem' });
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const privy = (sub = 'did:privy:cm1abc2def3ghi') => { const d = b64u({ alg: 'ES256', typ: 'JWT' }) + '.' + b64u({ sid: 's', iss: 'privy.io', iat: NOW / 1000 - 5, aud: APP, sub, exp: NOW / 1000 + 3600 }); return d + '.' + crypto.sign('sha256', Buffer.from(d), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'); };
const FB = { 'fb-fresh-A': { uid: 'FB_A', email: 'a@x', auth_time: NOW / 1000 - 30 }, 'fb-fresh-B': { uid: 'FB_B', email: 'b@x', auth_time: NOW / 1000 - 30 }, 'fb-stale-A': { uid: 'FB_A', email: 'a@x', auth_time: NOW / 1000 - 3600 }, 'fb-noauthtime-A': { uid: 'FB_A', email: 'a@x' }, 'fb-evil': { uid: 'did:privy:cm1abc2def3ghi', auth_time: NOW / 1000 } };
const auth = { async verifyIdToken(t) { if (!FB[t]) throw new Error('bad'); return FB[t]; } };
const memStore = (lat = false) => { const d = new Map(); const yieldTick = () => lat ? new Promise(r => setTimeout(r, 2)) : null; return { d,
  async createPair(pa, da, pb, db) { await yieldTick(); const a = d.get(pa) ?? null, b = d.get(pb) ?? null; if (a || b) return { created: false, a: a && structuredClone(a), b: b && structuredClone(b) }; d.set(pa, structuredClone(da)); d.set(pb, structuredClone(db)); return { created: true }; }, async get(p) { await yieldTick(); return d.has(p) ? structuredClone(d.get(p)) : null; }, async set(p, v, m) { d.set(p, m ? { ...(d.get(p) || {}), ...v } : v); }, async create(p, v) { if (d.has(p)) return false; d.set(p, structuredClone(v)); return true; }, async list(c) { return [...d].filter(([k]) => k.startsWith(c + '/')).map(([, v]) => v); } }; };
const mk = (store = memStore()) => ({ store, app: createApp({ auth, store, rpc: { async getTransaction() { return null; } }, now: () => NOW, env: { SATURN_ALLOWED_ORIGINS: ORIGIN, OWNER_UIDS: 'x', PRIVY_APP_ID: APP, PRIVY_VERIFICATION_KEY: PEM } }) });
const call = async (h, { method = 'POST', token, body, origin = ORIGIN } = {}) => { const res = { headers: {}, setHeader() {}, end(b) { this.body = b ? JSON.parse(b) : null; } }; await h({ method, url: '/x', headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body }, res); return res; };
const FBTOK = 'fb-fresh-A-token-padding'.length >= 20;
const link = (app, privTok, fbTok) => call(app.linkIdentity, { token: privTok, body: { firebaseIdToken: fbTok } });
const pad = t => t.padEnd(24, '_'); for (const k of Object.keys(FB)) FB[pad(k)] = FB[k];

test('link-identity: proof of BOTH accounts (Privy bearer + fresh Firebase token) records a 1:1 link and merges NOTHING', async () => {
  const { app, store } = mk(); await call(app.account, { token: 'fb-fresh-A'.padEnd(24, '_') }); const before = structuredClone(await store.get('users/FB_A'));
  const r = await link(app, privy(), pad('fb-fresh-A')); assert.equal(r.statusCode, 200);
  assert.equal((await store.get('identityLinks/did:privy:cm1abc2def3ghi')).firebaseUid, 'FB_A'); assert.equal((await store.get('identityLinks/fb_FB_A')).privy, 'did:privy:cm1abc2def3ghi');
  assert.deepEqual(await store.get('users/FB_A'), before);                                           // the Firebase user's data is untouched
  assert.equal((await store.get('users/did:privy:cm1abc2def3ghi')).linkedFirebaseUid, 'FB_A');
  assert.ok(![...store.d.keys()].some(k => k.startsWith('walletLinks/')));                           // no wallet links moved/created
  const a1 = await call(app.account, { token: privy() }); assert.equal(a1.body.identityLinked, true); const a2 = await call(app.account, { token: pad('fb-fresh-A') }); assert.equal(a2.body.identityLinked, true); });
test('link-identity: before linking, account reports identityLinked=false for both identities', async () => { const { app } = mk(); assert.equal((await call(app.account, { token: privy() })).body.identityLinked, false); assert.equal((await call(app.account, { token: pad('fb-fresh-A') })).body.identityLinked, false); });
test('link-identity: the Authorization token must be a PRIVY token (a Firebase bearer is refused)', async () => assert.equal((await link(mk().app, pad('fb-fresh-A'), pad('fb-fresh-B'))).statusCode, 403));
test('link-identity: unauthenticated -> 401; disallowed origin -> 403', async () => { const { app } = mk(); assert.equal((await call(app.linkIdentity, { body: { firebaseIdToken: pad('fb-fresh-A') } })).statusCode, 401); assert.equal((await call(app.linkIdentity, { token: privy(), origin: 'https://evil.example', body: { firebaseIdToken: pad('fb-fresh-A') } })).statusCode, 403); });
test('link-identity: a STALE Firebase sign-in (older than 5 min) or one without auth_time is refused — ownership must be freshly proven', async () => {
  const { app, store } = mk(); assert.equal((await link(app, privy(), pad('fb-stale-A'))).statusCode, 401); assert.equal((await link(app, privy(), pad('fb-noauthtime-A'))).statusCode, 401); assert.equal([...store.d.keys()].filter(k => k.startsWith('identityLinks/')).length, 0); });
test('link-identity: invalid Firebase token -> 401; a Privy token in the Firebase slot -> 400; missing/short token -> 400', async () => {
  const { app } = mk(); assert.equal((await link(app, privy(), 'garbage-token-garbage-token')).statusCode, 401); assert.equal((await link(app, privy(), privy())).statusCode, 400); assert.equal((await link(app, privy(), 'x')).statusCode, 400); assert.equal((await call(app.linkIdentity, { token: privy(), body: {} })).statusCode, 400); });
test('link-identity: a Firebase identity masquerading as a Privy DID is refused', async () => assert.equal((await link(mk().app, privy(), pad('fb-evil'))).statusCode, 401));
test('link-identity: repeating the same pair is idempotent; either side already linked elsewhere -> 409 and nothing changes', async () => {
  const { app, store } = mk(); assert.equal((await link(app, privy(), pad('fb-fresh-A'))).statusCode, 200); assert.equal((await link(app, privy(), pad('fb-fresh-A'))).body.duplicate, true);
  const n = store.d.size;
  assert.equal((await link(app, privy('did:privy:cm9other'), pad('fb-fresh-A'))).statusCode, 409);           // that Firebase account already belongs to another Privy account
  assert.equal((await link(app, privy(), pad('fb-fresh-B'))).statusCode, 409);                               // this Privy account already linked to a different Firebase account
  assert.equal(store.d.size, n); });
test('link-identity: rate limited to 5 attempts/min', async () => { const { app } = mk(); let r; for (let i = 0; i < 6; i++) r = await link(app, privy(), 'garbage-token-garbage-token'); assert.equal(r.statusCode, 429); });
test('link-identity: no secrets and no Privy secret referenced; wallet ownership flow unchanged', async () => { const fs = await import('node:fs'); const src = fs.readFileSync(new URL('../lib/app.js', import.meta.url), 'utf8'); assert.ok(!/PRIVY_APP_SECRET|PRIVY_SECRET/.test(src)); assert.match(src, /const linkWallet = guard\('POST'/); });

test('ATOMIC: two concurrent links of the SAME Privy account to two DIFFERENT Firebase accounts -> exactly one wins, the other gets 409, and NO orphan link document is left', async () => {
  const { app, store } = mk(memStore(true)); const [r1, r2] = await Promise.all([link(app, privy(), pad('fb-fresh-A')), link(app, privy(), pad('fb-fresh-B'))]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409]);
  const fbDocs = [...store.d.keys()].filter(k => k.startsWith('identityLinks/fb_')); assert.equal(fbDocs.length, 1);                      // the loser left nothing behind
  const winner = fbDocs[0].replace('identityLinks/fb_', ''); assert.equal((await store.get('identityLinks/did:privy:cm1abc2def3ghi')).firebaseUid, winner);
  const loserTok = winner === 'FB_A' ? pad('fb-fresh-B') : pad('fb-fresh-A'); assert.equal((await call(app.account, { token: loserTok })).body.identityLinked, false); });
test('ATOMIC: two concurrent links of the SAME Firebase account to two DIFFERENT Privy accounts -> exactly one wins, no orphan', async () => {
  const { app, store } = mk(memStore(true)); const [r1, r2] = await Promise.all([link(app, privy('did:privy:cmONE'), pad('fb-fresh-A')), link(app, privy('did:privy:cmTWO'), pad('fb-fresh-A'))]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409]); assert.equal([...store.d.keys()].filter(k => k.startsWith('identityLinks/did:privy:')).length, 1); });
test('ATOMIC: concurrent identical requests -> one creates, the rest are idempotent (never a conflict against yourself)', async () => {
  const { app } = mk(memStore(true)); const rs = await Promise.all([1, 2, 3].map(() => link(app, privy(), pad('fb-fresh-A')))); assert.ok(rs.every(r => r.statusCode === 200)); assert.equal(rs.filter(r => r.body.duplicate).length, 2); });
test('ATOMIC: the production store implements createPair with a Firestore transaction (runTransaction + t.get + t.create), and the link endpoint uses it', async () => {
  const fs = await import('node:fs'); const d = fs.readFileSync(new URL('../lib/deps.js', import.meta.url), 'utf8'), a = fs.readFileSync(new URL('../lib/app.js', import.meta.url), 'utf8');
  assert.match(d, /createPair[\s\S]*fs\.runTransaction[\s\S]*t\.get\(ra\)[\s\S]*t\.create\(ra, da\)[\s\S]*t\.create\(rb, db\)/); assert.match(a, /store\.createPair\('identityLinks\/fb_'/); assert.ok(!/store\.create\('identityLinks/.test(a)); });
