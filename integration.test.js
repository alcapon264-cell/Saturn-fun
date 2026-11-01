// Runs the page's REAL SyncService code (extracted from index-14.html) against the REAL backend handlers (in-memory store, fake Firebase Auth/RPC).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { createApp } from '../lib/app.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc = b => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } return o; };
const ORIGIN = 'https://thunderous-marshmallow-0bceda.netlify.app', MINT = enc(crypto.randomBytes(32)), TREASURY = enc(crypto.randomBytes(32)), SIG = '5'.repeat(88);
const html = fs.readFileSync(new URL('../../index-14.html', import.meta.url), 'utf8').split('\n');
const a = html.findIndex(l => l.startsWith('const BACKEND_URL=')), b = html.findIndex(l => l.startsWith('// Wallet trade history.'));
const src = html.slice(a, b).join('\n');
const memStore = () => { const d = new Map(); return { d, async get(p) { return d.has(p) ? structuredClone(d.get(p)) : null; }, async set(p, v, m) { d.set(p, m ? { ...(d.get(p) || {}), ...v } : v); }, async create(p, v) { if (d.has(p)) return false; d.set(p, structuredClone(v)); return true; }, async list(c) { return [...d].filter(([k]) => k.startsWith(c + '/')).map(([, v]) => v); } }; };
function harness({ backendUrl = 'https://backend.test', rpcSeq }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'), wallet = enc(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')), store = memStore(), seq = [...(typeof rpcSeq === 'function' ? rpcSeq(wallet) : rpcSeq)], calls = [];
  const app = createApp({ auth: { async verifyIdToken(t) { if (t !== 'user-token') throw new Error('bad'); return { uid: 'U1', email: 'u@x' }; } }, store, rpc: { async getTransaction() { return seq.length > 1 ? seq.shift() : seq[0]; } }, env: { SATURN_ALLOWED_ORIGINS: ORIGIN, OWNER_UIDS: 'OWNER', PLATFORM_TREASURY_WALLET: TREASURY } });
  const routes = { '/api/events': app.events, '/api/link-wallet': app.linkWallet, '/api/account': app.account };
  const fetch = async (url, o) => { const path = new URL(url).pathname; calls.push({ path, headers: o.headers, body: JSON.parse(o.body) });
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(x) { this.body = x ? JSON.parse(x) : null; } };
    await routes[path]({ method: 'POST', url: path, headers: { origin: ORIGIN, ...(o.headers.authorization ? { authorization: o.headers.authorization } : {}) }, body: JSON.parse(o.body) }, res);
    return { status: res.statusCode, json: async () => res.body }; };
  const ctx = { IdentityLink: { state: 'unknown' }, /* stand-in: the real IdentityLink is tested in tests/privy_login.test.js */ fetch, sleep: async () => {}, TextEncoder, bytesToB64: x => Buffer.from(x).toString('base64'),
    AuthService: { user: { uid: 'U1' }, _auth: { currentUser: { getIdToken: async () => 'user-token' } } },
    WalletService: { address: wallet, signMessage: async m => new Uint8Array(crypto.sign(null, Buffer.from(m), privateKey)) } };
  vm.createContext(ctx); vm.runInContext(src.replace(/const BACKEND_URL='[^']*';/, `const BACKEND_URL='${backendUrl}';`) + ';this.SyncService=SyncService;this.BACKEND_URL=BACKEND_URL;', ctx);
  return { ctx, wallet, store, calls, S: ctx.SyncService };
}
const tx = (w) => ({ blockTime: 1_700_000_000, transaction: { message: { accountKeys: [{ pubkey: w, signer: true }, { pubkey: TREASURY, signer: false }, { pubkey: MINT, signer: false }] } },
  meta: { err: null, fee: 5000, preBalances: [5e9, 0, 0], postBalances: [4.9e9, 1e6, 0], preTokenBalances: [], postTokenBalances: [{ owner: w, mint: MINT, uiTokenAmount: { amount: '777' } }] } });

test('shipped default: BACKEND_URL is the deployed backend (https, no trailing slash); with an empty value every sync call is a no-op with NO network request', async () => {
  assert.equal(/^const BACKEND_URL='([^']*)';/.exec(html[a])[1], 'https://saturn-backend-4sfwevstv-saturn-81f4.vercel.app');
  const h = harness({ backendUrl: '', rpcSeq: [null] }); assert.equal(await h.S.report({ type: 'trade', side: 'buy', wallet: h.wallet, mint: MINT, sig: SIG }), null); assert.equal(await h.S.account(), null); assert.equal(h.calls.length, 0); });
test('wallet link: the page signs with the wallet and the backend verifies it (frontend <-> backend)', async () => {
  const h = harness({ rpcSeq: [null] }); const r = await h.S.linkWallet(); assert.equal(r.ok, true); assert.equal((await h.store.get('walletLinks/' + h.wallet)).uid, 'U1'); assert.deepEqual((await h.store.get('users/U1')).wallets, [h.wallet]);
  assert.ok(h.calls[0].headers.authorization === 'Bearer user-token'); });
test('wallet link: refuses to prompt/post when not signed in or no wallet connected', async () => {
  const h = harness({ rpcSeq: [null] }); h.ctx.AuthService.user = null; assert.equal((await h.S.linkWallet()).ok, false); h.ctx.AuthService.user = { uid: 'U1' }; h.ctx.WalletService.address = null; assert.equal((await h.S.linkWallet()).ok, false); assert.equal(h.calls.length, 0); });
test('wallet link: a wallet that cannot sign messages reports a clear error and nothing is sent', async () => {
  const h = harness({ rpcSeq: [null] }); h.ctx.WalletService.signMessage = async () => { throw new Error('This wallet does not support message signing.'); }; const r = await h.S.linkWallet(); assert.equal(r.ok, false); assert.match(r.message, /does not support message signing/); assert.equal(h.calls.length, 0); });
test('event report: sends ONLY {type,side,wallet,mint,sig}; the backend records chain-verified values', async () => {
  const h = harness({ rpcSeq: w => [tx(w)] }); const r = await h.S.report({ type: 'trade', side: 'buy', wallet: h.wallet, mint: MINT, sig: SIG });
  assert.equal(r.ok, true); assert.deepEqual(Object.keys(h.calls[0].body).sort(), ['mint', 'side', 'sig', 'type', 'wallet']);
  const e = await h.store.get('events/' + SIG); assert.equal(e.tokenDelta, '777'); assert.equal(e.solDelta, '-100000000'); assert.equal(e.treasuryLamportsDelta, '1000000'); assert.equal(e.uid, null); });
test('event report: retries while the transaction is not yet visible (202), then records exactly once', async () => {
  const h = harness({ rpcSeq: w => [null, null, tx(w)] }); const r = await h.S.report({ type: 'trade', side: 'buy', wallet: h.wallet, mint: MINT, sig: SIG });
  assert.equal(r.ok, true); assert.equal(h.calls.length, 3); assert.equal([...h.store.d.keys()].filter(k => k === 'events/' + SIG).length, 1); });
test('event report: gives up after 5 pending attempts and records nothing', async () => {
  const h = harness({ rpcSeq: [null] }); assert.equal(await h.S.report({ type: 'trade', side: 'buy', wallet: h.wallet, mint: MINT, sig: SIG }), null); assert.equal(h.calls.length, 5); assert.equal(await h.store.get('events/' + SIG), null); });
test('launch report: posts the launch kind and the backend verifies the mint is in the transaction', async () => {
  const h = harness({ rpcSeq: w => [tx(w)] }); const r = await h.S.report({ type: 'launch', wallet: h.wallet, mint: MINT, sig: SIG, kind: 'PUMP_LAUNCH' }); assert.equal(r.ok, true); assert.equal((await h.store.get('events/' + SIG)).launchKind, 'PUMP_LAUNCH'); });
test('account upsert: signed-in user gets a Firestore user doc keyed by the VERIFIED uid', async () => {
  const h = harness({ rpcSeq: [null] }); const r = await h.S.account(); assert.equal(r.ok, true); assert.ok(await h.store.get('users/U1')); assert.ok(h.calls[0].headers.authorization.startsWith('Bearer ')); });
test('account upsert: not signed in -> no request at all', async () => {
  const h = harness({ rpcSeq: [null] }); h.ctx.AuthService._auth.currentUser = null; assert.equal(await h.S.account(), null); assert.equal(h.calls.length, 0); });
test('page wiring: trade + launch + account hooks exist, and no key material is handled by the sync code', () => {
  const page = html.join('\n');
  assert.match(page, /SyncService\.report\(\{type:'trade',side:sd0,wallet:w0,mint:t0\.id,sig:r\.signature\}\)/);
  assert.match(page, /SyncService\.report\(\{type:'launch',wallet:rec\.creator\|\|WalletService\.address,mint,sig:rec\.signature,kind:rec\.launchKind\}\)/);
  assert.match(page, /SyncService\.account\(\)/); assert.ok(!/privateKey|secretKey|seed/i.test(src.replace(/^\s*\/\/.*$/mg, ''))); });

test('account page state: the linked-wallet list is filled from the backend, extended on link, and cleared on sign-out wiring', async () => {
  const h = harness({ rpcSeq: [null] }); h.ctx.renderAccount = () => {}; assert.deepEqual([...h.S.wallets], []);
  const r1 = await h.S.account(); assert.equal(r1.ok, true); assert.deepEqual([...h.S.wallets], []);
  const r2 = await h.S.linkWallet(); assert.equal(r2.ok, true); assert.deepEqual([...h.S.wallets], [h.wallet]);
  const again = await h.S.account(); assert.deepEqual([...again.wallets], [h.wallet]); assert.deepEqual([...h.S.wallets], [h.wallet]);
  assert.match(html.join('\n'), /if\(!AuthService\.user\)\{SyncService\.wallets=\[\];SyncService\._acct=null\}/); });
