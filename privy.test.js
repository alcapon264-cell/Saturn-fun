// Real cryptography: tokens are signed with a freshly generated P-256 key (ES256, IEEE-P1363) exactly as Privy issues them, and verified by the real verifier.
// Only Firebase Auth and Firestore are stand-ins (fake auth + in-memory store). The Privy verification itself is NOT mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp, linkMessage } from '../lib/app.js';

const APP = 'cmv1ke5s6006p0fjruyd2obw5', ORIGIN = 'https://thunderous-marshmallow-0bceda.netlify.app', NOW = 1_700_000_000_000, DID = 'did:privy:cm1abc2def3ghi';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }), PEM = publicKey.export({ type: 'spki', format: 'pem' });
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const jwt = ({ header = { alg: 'ES256', typ: 'JWT' }, payload = {}, key = privateKey, sigOverride } = {}) => {
  const p = { sid: 'sess1', iss: 'privy.io', iat: NOW / 1000 - 10, aud: APP, sub: DID, exp: NOW / 1000 + 3600, ...payload }, data = b64u(header) + '.' + b64u(p);
  return data + '.' + (sigOverride ?? crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')); };
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc = b => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } return o; };
const wallet = () => { const k = crypto.generateKeyPairSync('ed25519'); return { address: enc(Buffer.from(k.publicKey.export({ format: 'jwk' }).x, 'base64url')), sign: m => crypto.sign(null, Buffer.from(m), k.privateKey).toString('base64') }; };
const memStore = () => { const d = new Map(); return { d, async get(p) { return d.has(p) ? structuredClone(d.get(p)) : null; }, async set(p, v, m) { d.set(p, m ? { ...(d.get(p) || {}), ...v } : v); }, async create(p, v) { if (d.has(p)) return false; d.set(p, structuredClone(v)); return true; }, async list(c) { return [...d].filter(([k]) => k.startsWith(c + '/')).map(([, v]) => v); } }; };
const fbAuth = { async verifyIdToken(t) { if (t === 'fb-user') return { uid: 'FB1', email: 'f@x' }; if (t === 'fb-evil') return { uid: 'did:privy:cm1abc2def3ghi' }; throw new Error('bad'); } };
const mk = (env = {}, store = memStore()) => ({ store, app: createApp({ auth: fbAuth, store, rpc: { async getTransaction() { return null; } }, now: () => NOW, env: { SATURN_ALLOWED_ORIGINS: ORIGIN, OWNER_UIDS: 'OWNER_UID_X,' + DID, PRIVY_APP_ID: APP, PRIVY_VERIFICATION_KEY: PEM, ...env } }) });
const call = async (h, { method = 'POST', token, body, url = '/x' } = {}) => { const res = { headers: {}, setHeader() {}, end(b) { this.body = b ? JSON.parse(b) : null; } };
  await h({ method, url, headers: { origin: ORIGIN, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body }, res); return res; };

test('Privy: a valid access token creates/updates the account keyed by the Privy DID (provider recorded; no email invented)', async () => {
  const { app, store } = mk(); const r = await call(app.account, { token: jwt() }); assert.equal(r.statusCode, 200); assert.equal(r.body.uid, DID);
  const u = await store.get('users/' + DID); assert.equal(u.provider, 'privy'); assert.equal(u.email, null); });
test('Firebase tokens still work on the same app and keep their own uid/provider (existing users untouched)', async () => {
  const { app, store } = mk(); const r = await call(app.account, { token: 'fb-user' }); assert.equal(r.statusCode, 200); assert.equal(r.body.uid, 'FB1'); assert.equal((await store.get('users/FB1')).provider, 'firebase'); });
test('Privy: PEM supplied with escaped "\\n" (how env vars are usually pasted) is accepted', async () => assert.equal((await call(mk({ PRIVY_VERIFICATION_KEY: PEM.replace(/\n/g, '\\n') }).app.account, { token: jwt() })).statusCode, 200));
for (const [name, token] of [
  ['expired', () => jwt({ payload: { exp: NOW / 1000 - 3600 } })], ['missing exp', () => { const t = jwt().split('.'); const p = JSON.parse(Buffer.from(t[1], 'base64url')); delete p.exp; const d = t[0] + '.' + b64u(p); return d + '.' + crypto.sign('sha256', Buffer.from(d), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'); }],
  ['issued in the future', () => jwt({ payload: { iat: NOW / 1000 + 3600 } })], ['wrong audience (another Privy app)', () => jwt({ payload: { aud: 'someotherapp' } })],
  ['wrong issuer', () => jwt({ payload: { iss: 'evil.io' } })], ['signed by a DIFFERENT key', () => jwt({ key: other.privateKey })],
  ['tampered payload', () => { const t = jwt().split('.'); return t[0] + '.' + b64u({ ...JSON.parse(Buffer.from(t[1], 'base64url')), sub: 'did:privy:attacker' }) + '.' + t[2]; }],
  ['alg none', () => b64u({ alg: 'none' }) + '.' + b64u({ iss: 'privy.io', aud: APP, sub: DID, exp: NOW / 1000 + 99 }) + '.'],
  ['HS256 key-confusion (public key used as HMAC secret)', () => { const d = b64u({ alg: 'HS256' }) + '.' + b64u({ iss: 'privy.io', aud: APP, sub: DID, exp: NOW / 1000 + 99 }); return d + '.' + crypto.createHmac('sha256', PEM).update(d).digest('base64url'); }],
  ['header claims a different algorithm (ES384) even though the P-256 signature is otherwise valid', () => jwt({ header: { alg: 'ES384', typ: 'JWT' } })],
  ['signature wrong length / garbage', () => jwt({ sigOverride: 'AAAA' })], ['sub is not a Privy DID', () => jwt({ payload: { sub: 'FB1' } })], ['sub with path characters', () => jwt({ payload: { sub: 'did:privy:../../x' } })],
]) test(`Privy: ${name} -> 401, nothing written`, async () => { const { app, store } = mk(); const r = await call(app.account, { token: token() }); assert.equal(r.statusCode, 401); assert.equal([...store.d.keys()].length, 0); });
test('Privy: tokens are rejected when the backend is not configured with BOTH PRIVY_APP_ID and a valid verification key (fail closed)', async () => {
  assert.equal((await call(mk({ PRIVY_APP_ID: '' }).app.account, { token: jwt() })).statusCode, 401); assert.equal((await call(mk({ PRIVY_VERIFICATION_KEY: '' }).app.account, { token: jwt() })).statusCode, 401);
  assert.equal((await call(mk({ PRIVY_VERIFICATION_KEY: 'not a key' }).app.account, { token: jwt() })).statusCode, 401);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }); assert.equal((await call(mk({ PRIVY_VERIFICATION_KEY: rsa }).app.account, { token: jwt() })).statusCode, 401);
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ type: 'spki', format: 'pem' }); assert.equal((await call(mk({ PRIVY_VERIFICATION_KEY: p384 }).app.account, { token: jwt() })).statusCode, 401); });
test('A Firebase identity can never claim a Privy DID as its uid (namespace separation)', async () => assert.equal((await call(mk().app.account, { token: 'fb-evil' })).statusCode, 401));
test('A Firebase token cannot be routed through the Privy verifier, and a forged "privy.io" token does not fall back to Firebase', async () => {
  const forged = b64u({ alg: 'ES256' }) + '.' + b64u({ iss: 'privy.io', sub: DID }) + '.' + 'x'.repeat(86); assert.equal((await call(mk().app.account, { token: forged })).statusCode, 401); });
test('link-wallet works for a Privy user: the wallet signature is bound to the Privy DID; the wallet cannot then be claimed by a Firebase account', async () => {
  const { app, store } = mk(), w = wallet(), msg = linkMessage(DID, w.address, NOW);
  const r = await call(app.linkWallet, { token: jwt(), body: { wallet: w.address, message: msg, signature: w.sign(msg) } }); assert.equal(r.statusCode, 200); assert.deepEqual(r.body.wallets, [w.address]); assert.equal((await store.get('walletLinks/' + w.address)).uid, DID);
  const m2 = linkMessage('FB1', w.address, NOW); assert.equal((await call(app.linkWallet, { token: 'fb-user', body: { wallet: w.address, message: m2, signature: w.sign(m2) } })).statusCode, 409);
  const stolen = linkMessage('did:privy:cm9other', w.address, NOW); assert.equal((await call(app.linkWallet, { token: jwt({ payload: { sub: 'did:privy:cm9other' } }), body: { wallet: w.address, message: stolen, signature: w.sign(stolen) } })).statusCode, 409); });
test('link-wallet: a Privy token cannot link using a message bound to a different uid', async () => { const w = wallet(), msg = linkMessage('FB1', w.address, NOW); assert.equal((await call(mk().app.linkWallet, { token: jwt(), body: { wallet: w.address, message: msg, signature: w.sign(msg) } })).statusCode, 400); });
test('owner: only an allowlisted Privy DID gets in; other valid Privy users get 403; expired owner token gets 401', async () => {
  const { app } = mk(); assert.equal((await call(app.owner, { method: 'GET', token: jwt() })).statusCode, 200); assert.equal((await call(app.owner, { method: 'GET', token: jwt({ payload: { sub: 'did:privy:cm9notowner' } }) })).statusCode, 403);
  assert.equal((await call(app.owner, { method: 'GET', token: jwt({ payload: { exp: NOW / 1000 - 3600 } }) })).statusCode, 401); });
test('events: a Privy-authenticated request attaches the DID only when that wallet is proven-linked to it', async () => {
  const w = wallet(), MINT = enc(crypto.randomBytes(32)), SIG = '5'.repeat(88), store = memStore();
  const tx = { blockTime: 1_700_000_000, transaction: { message: { accountKeys: [{ pubkey: w.address, signer: true }, { pubkey: MINT, signer: false }] } }, meta: { err: null, fee: 5000, preBalances: [5e9, 0], postBalances: [4.9e9, 0], preTokenBalances: [], postTokenBalances: [{ owner: w.address, mint: MINT, uiTokenAmount: { amount: '9' } }] } };
  const app = createApp({ auth: fbAuth, store, rpc: { async getTransaction() { return tx; } }, now: () => NOW, env: { SATURN_ALLOWED_ORIGINS: ORIGIN, OWNER_UIDS: 'x', PRIVY_APP_ID: APP, PRIVY_VERIFICATION_KEY: PEM } });
  const msg = linkMessage(DID, w.address, NOW); await call(app.linkWallet, { token: jwt(), body: { wallet: w.address, message: msg, signature: w.sign(msg) } });
  const r = await call(app.events, { token: jwt(), body: { type: 'trade', side: 'buy', sig: SIG, wallet: w.address, mint: MINT } }); assert.equal(r.statusCode, 200); assert.equal((await store.get('events/' + SIG)).uid, DID); });
test('no secrets: the verifier uses only the PUBLIC verification key and App ID; no Privy secret is referenced anywhere in the backend', async () => {
  const fs = await import('node:fs'); for (const f of ['lib/privy.js', 'lib/app.js', 'lib/deps.js']) assert.ok(!/PRIVY_APP_SECRET|PRIVY_SECRET|app[-_ ]secret/i.test(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')), f); });
