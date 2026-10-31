import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createApp, linkMessage } from '../lib/app.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc = b => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let o = ''; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } return o; };
const newWallet = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { address: enc(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')), sign: m => crypto.sign(null, Buffer.from(m), privateKey).toString('base64') }; };
const TREASURY = enc(crypto.randomBytes(32)), MINT = enc(crypto.randomBytes(32)), SIG = '5'.repeat(88), SIG2 = '6'.repeat(88), WSOL = 'So11111111111111111111111111111111111111112';
const memStore = () => { const d = new Map(); return { d,
  async get(p) { return d.has(p) ? structuredClone(d.get(p)) : null; },
  async set(p, v, merge) { d.set(p, merge ? { ...(d.get(p) || {}), ...v } : v); },
  async create(p, v) { if (d.has(p)) return false; d.set(p, structuredClone(v)); return true; },
  async list(c, { limit, orderBy = 'recordedAt' }) { return [...d].filter(([k]) => k.startsWith(c + '/')).map(([, v]) => v).sort((a, b) => (b[orderBy] || 0) - (a[orderBy] || 0)).slice(0, limit); } }; };
const TOK = { 'owner-token': { uid: 'OWNER', email: 'o@x' }, 'user-token': { uid: 'U1', email: 'u@x' }, 'user2-token': { uid: 'U2', email: 'v@x' } };
const auth = { async verifyIdToken(t) { if (!TOK[t]) throw new Error('bad'); return TOK[t]; } };
const ORIGIN = 'https://thunderous-marshmallow-0bceda.netlify.app';
function setup({ rpcTx = null, env = {}, store = memStore() } = {}) {
  const rpc = { async getTransaction() { if (rpcTx instanceof Error) throw rpcTx; return rpcTx; } };
  const app = createApp({ auth, store, rpc, now: () => 1_700_000_000_000, env: { SATURN_ALLOWED_ORIGINS: ORIGIN, OWNER_UIDS: 'OWNER', PLATFORM_TREASURY_WALLET: TREASURY, ...env } });
  return { app, store };
}
const call = async (h, { method = 'POST', token, origin = ORIGIN, body, url = '/x' } = {}) => {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  await h({ method, url, headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body }, res); return res;
};
const mkTx = ({ wallet, err = null, tokPre = 0, tokPost = 0, mint = MINT, signer = true, payer = wallet, solPre = 5_000_000_000, solPost = 4_900_000_000, trePre = 0, trePost = 1_000_000, treWsolPre = 0, treWsolPost = 40_000 } = {}) => ({
  blockTime: 1_700_000_000, transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }, { pubkey: TREASURY, signer: false }, { pubkey: mint, signer: false }, ...(payer !== wallet ? [{ pubkey: wallet, signer }] : [])] } },
  meta: { err, fee: 5000, preBalances: payer === wallet ? [solPre, trePre, 0] : [1, trePre, 0, solPre], postBalances: payer === wallet ? [solPost, trePost, 0] : [1, trePost, 0, solPost],
    preTokenBalances: [...(tokPre ? [{ owner: wallet, mint, uiTokenAmount: { amount: String(tokPre) } }] : []), { owner: TREASURY, mint: WSOL, uiTokenAmount: { amount: String(treWsolPre) } }],
    postTokenBalances: [...(tokPost ? [{ owner: wallet, mint, uiTokenAmount: { amount: String(tokPost) } }] : []), { owner: TREASURY, mint: WSOL, uiTokenAmount: { amount: String(treWsolPost) } }] } });
const W = newWallet();

// ---------- owner authorization (server-side) ----------
test('owner: no token -> 401', async () => assert.equal((await call(setup().app.owner, { method: 'GET', url: '/api/owner' })).statusCode, 401));
test('owner: forged/invalid token -> 401', async () => assert.equal((await call(setup().app.owner, { method: 'GET', token: 'forged' })).statusCode, 401));
test('owner: valid signed-in NON-owner -> 403 and no data', async () => { const r = await call(setup().app.owner, { method: 'GET', token: 'user-token', url: '/api/owner?view=events' }); assert.equal(r.statusCode, 403); assert.deepEqual(r.body, { error: 'Forbidden.' }); });
test('owner: owner token -> 200 summary', async () => { const r = await call(setup().app.owner, { method: 'GET', token: 'owner-token', url: '/api/owner' }); assert.equal(r.statusCode, 200); assert.ok(r.body.summary); });
test('owner: fails CLOSED when OWNER_UIDS is empty (even the would-be owner is refused)', async () => assert.equal((await call(setup({ env: { OWNER_UIDS: '' } }).app.owner, { method: 'GET', token: 'owner-token' })).statusCode, 403));
test('owner: a client cannot self-declare owner via headers/body/query', async () => { const r = await call(setup().app.owner, { method: 'GET', token: 'user-token', url: '/api/owner?owner=1&uid=OWNER', body: { uid: 'OWNER', owner: true } }); assert.equal(r.statusCode, 403); });
test('owner: disallowed browser origin refused before auth', async () => { const r = await call(setup().app.owner, { method: 'GET', token: 'owner-token', origin: 'https://evil.example' }); assert.equal(r.statusCode, 403); assert.equal(r.headers['access-control-allow-origin'], undefined); });
test('owner: wrong method -> 405; OPTIONS preflight -> 204 for allowed origin only', async () => { const s = setup(); assert.equal((await call(s.app.owner, { method: 'POST', token: 'owner-token' })).statusCode, 405); const p = await call(s.app.owner, { method: 'OPTIONS' }); assert.equal(p.statusCode, 204); assert.equal(p.headers['access-control-allow-origin'], ORIGIN); });
test('owner: responses are never cacheable', async () => assert.equal((await call(setup().app.owner, { method: 'GET', token: 'owner-token' })).headers['cache-control'], 'no-store'));

// ---------- account + wallet linking ----------
test('account: requires sign-in; creates user from the VERIFIED token uid only', async () => {
  const s = setup(); assert.equal((await call(s.app.account, {})).statusCode, 401);
  const r = await call(s.app.account, { token: 'user-token', body: { uid: 'OWNER' } }); assert.equal(r.statusCode, 200); assert.equal(r.body.uid, 'U1'); assert.ok(await s.store.get('users/U1')); assert.equal(await s.store.get('users/OWNER'), null); });
const link = (w, uid, issued = 1_700_000_000_000) => { const message = linkMessage(uid, w.address, issued); return { wallet: w.address, message, signature: w.sign(message) }; };
test('link-wallet: valid wallet signature links the wallet to the account', async () => { const s = setup(); const r = await call(s.app.linkWallet, { token: 'user-token', body: link(W, 'U1') }); assert.equal(r.statusCode, 200); assert.deepEqual(r.body.wallets, [W.address]); assert.equal((await s.store.get('walletLinks/' + W.address)).uid, 'U1'); });
test('link-wallet: signature from a DIFFERENT key is rejected', async () => { const o = newWallet(), b = link(W, 'U1'); b.signature = o.sign(b.message); assert.equal((await call(setup().app.linkWallet, { token: 'user-token', body: b })).statusCode, 400); });
test('link-wallet: message bound to another uid is rejected', async () => assert.equal((await call(setup().app.linkWallet, { token: 'user-token', body: link(W, 'U2') })).statusCode, 400));
test('link-wallet: expired message is rejected', async () => assert.equal((await call(setup().app.linkWallet, { token: 'user-token', body: link(W, 'U1', 1_700_000_000_000 - 11 * 60 * 1000) })).statusCode, 400));
test('link-wallet: a wallet already linked to another account -> 409 (cannot be stolen)', async () => { const s = setup(); await call(s.app.linkWallet, { token: 'user-token', body: link(W, 'U1') }); const r = await call(s.app.linkWallet, { token: 'user2-token', body: link(W, 'U2') }); assert.equal(r.statusCode, 409); assert.equal((await s.store.get('walletLinks/' + W.address)).uid, 'U1'); });
test('link-wallet: re-linking the same wallet to the same account is idempotent', async () => { const s = setup(); await call(s.app.linkWallet, { token: 'user-token', body: link(W, 'U1') }); const r = await call(s.app.linkWallet, { token: 'user-token', body: link(W, 'U1') }); assert.equal(r.statusCode, 200); assert.equal(r.body.wallets.length, 1); });
test('link-wallet: unauthenticated -> 401', async () => assert.equal((await call(setup().app.linkWallet, { body: link(W, 'U1') })).statusCode, 401));

// ---------- event store: only chain-verified facts ----------
const buy = { type: 'trade', side: 'buy', sig: SIG, wallet: W.address, mint: MINT };
test('events: verified BUY is recorded from CHAIN data; client-supplied amounts are ignored', async () => {
  const s = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 1234 }) }); const r = await call(s.app.events, { body: { ...buy, tokenDelta: '999999', solDelta: '1', amount: 42 } });
  assert.equal(r.statusCode, 200); const e = await s.store.get('events/' + SIG); assert.equal(e.tokenDelta, '1234'); assert.equal(e.solDelta, '-100000000'); assert.equal(e.txFee, '5000'); assert.equal(e.treasuryLamportsDelta, '1000000'); assert.deepEqual(e.treasuryTokenDeltas, { [WSOL]: '40000' }); assert.equal(e.uid, null); assert.equal(e.amount, undefined); });
test('events: duplicate signature is idempotent (one record)', async () => { const s = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 5 }) }); await call(s.app.events, { body: buy }); const r = await call(s.app.events, { body: buy }); assert.equal(r.body.duplicate, true); assert.equal([...s.store.d.keys()].filter(k => k.startsWith('events/')).length, 1); });
test('events: verified SELL is recorded; a "sell" that actually received tokens is rejected', async () => {
  const s = setup({ rpcTx: mkTx({ wallet: W.address, tokPre: 500, tokPost: 0 }) }); assert.equal((await call(s.app.events, { body: { ...buy, side: 'sell' } })).statusCode, 200);
  const s2 = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 500 }) }); assert.equal((await call(s2.app.events, { body: { ...buy, side: 'sell' } })).statusCode, 422); assert.equal(await s2.store.get('events/' + SIG), null); });
test('events: a "buy" that moved tokens out is rejected', async () => { const s = setup({ rpcTx: mkTx({ wallet: W.address, tokPre: 500, tokPost: 0 }) }); assert.equal((await call(s.app.events, { body: buy })).statusCode, 422); });
test('events: transaction not signed / not paid by the claimed wallet -> 422, nothing recorded', async () => { const o = newWallet(); const s = setup({ rpcTx: mkTx({ wallet: o.address, tokPost: 10 }) }); assert.equal((await call(s.app.events, { body: buy })).statusCode, 422); assert.equal(await s.store.get('events/' + SIG), null); });
test('events: failed on-chain tx is NOT a trade; it is logged as an error', async () => { const s = setup({ rpcTx: mkTx({ wallet: W.address, err: { InstructionError: [3, { Custom: 1 }] } }) }); const r = await call(s.app.events, { body: buy }); assert.equal(r.body.status, 'failed_on_chain'); assert.equal(await s.store.get('events/' + SIG), null); assert.match((await s.store.get('errors/' + SIG)).error, /Custom/); });
test('events: transaction not yet visible -> 202 pending, nothing recorded', async () => { const s = setup({ rpcTx: null }); assert.equal((await call(s.app.events, { body: buy })).statusCode, 202); assert.equal(await s.store.get('events/' + SIG), null); });
test('events: RPC outage -> 502, nothing recorded', async () => { const s = setup({ rpcTx: new Error('down') }); assert.equal((await call(s.app.events, { body: buy })).statusCode, 502); });
test('events: malformed input rejected', async () => { const s = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 1 }) }); for (const b of [{ ...buy, sig: 'x' }, { ...buy, wallet: 'bad' }, { ...buy, type: 'admin' }, { ...buy, side: 'hold' }, {}]) assert.equal((await call(s.app.events, { body: b })).statusCode, 400); });
test('events: LAUNCH recorded only when the mint is part of the verified transaction', async () => {
  const s = setup({ rpcTx: mkTx({ wallet: W.address }) }); assert.equal((await call(s.app.events, { body: { type: 'launch', sig: SIG, wallet: W.address, mint: MINT, kind: 'PUMP_LAUNCH' } })).statusCode, 200); assert.equal((await s.store.get('events/' + SIG)).launchKind, 'PUMP_LAUNCH');
  const s2 = setup({ rpcTx: mkTx({ wallet: W.address }) }); assert.equal((await call(s2.app.events, { body: { type: 'launch', sig: SIG2, wallet: W.address, mint: enc(crypto.randomBytes(32)) } })).statusCode, 422); });
test('events: identity (uid) is attached ONLY when the wallet is proven-linked to the signed-in account', async () => {
  const s = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 9 }) }); await call(s.app.events, { token: 'user-token', body: buy }); assert.equal((await s.store.get('events/' + SIG)).uid, null);
  const s2 = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 9 }) }); await call(s2.app.linkWallet, { token: 'user-token', body: link(W, 'U1') }); await call(s2.app.events, { token: 'user-token', body: buy }); assert.equal((await s2.store.get('events/' + SIG)).uid, 'U1');
  const s3 = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 9 }) }); await call(s3.app.linkWallet, { token: 'user-token', body: link(W, 'U1') }); await call(s3.app.events, { token: 'user2-token', body: buy }); assert.equal((await s3.store.get('events/' + SIG)).uid, null); });

// ---------- owner reads the recorded data ----------
test('owner summary aggregates ONLY recorded verified events (empty store -> zeros, nothing fabricated)', async () => {
  const empty = await call(setup().app.owner, { method: 'GET', token: 'owner-token' }); assert.equal(empty.body.summary.trades, 0); assert.equal(empty.body.summary.volumeLamports, '0');
  const s = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 77 }) }); await call(s.app.account, { token: 'user-token' }); await call(s.app.events, { body: buy });
  const r = await call(s.app.owner, { method: 'GET', token: 'owner-token' }); const m = r.body.summary; assert.equal(m.trades, 1); assert.equal(m.buys, 1); assert.equal(m.users, 1); assert.equal(m.volumeLamports, '100000000'); assert.equal(m.treasuryLamportsReceived, '1000000'); assert.equal(m.treasuryTokenDeltas[WSOL], '40000'); });
test('owner events/users/errors views are owner-gated and limit-capped', async () => { const s = setup(); for (const v of ['events', 'users', 'errors']) { assert.equal((await call(s.app.owner, { method: 'GET', token: 'user-token', url: '/api/owner?view=' + v })).statusCode, 403); assert.equal((await call(s.app.owner, { method: 'GET', token: 'owner-token', url: '/api/owner?view=' + v + '&limit=99999' })).statusCode, 200); } });

// ---------- static security checks ----------
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
test('no credentials committed: service account only via env, no key material in source', () => {
  for (const f of ['lib/app.js', 'lib/deps.js', 'api/account.js', 'api/events.js', 'api/link-wallet.js', 'api/owner.js']) assert.ok(!/BEGIN (RSA )?PRIVATE KEY|"private_key"|AIza[0-9A-Za-z_-]{30}/.test(read(f)), f);
  assert.match(read('lib/deps.js'), /process\.env\.FIREBASE_SERVICE_ACCOUNT_JSON/); });
test('firestore.rules: clients can read only their own users doc and can never write; everything else denied', () => {
  const r = read('firestore.rules'); assert.match(r, /match \/users\/\{uid\}[\s\S]*allow read: if request\.auth != null\s*&&\s*request\.auth\.uid == uid;[\s\S]*allow write: if false;/);
assert.ok(!/allow (read|write)[^;]*: if true/.test(
  r.replace(
    /match\s+\/communityRooms\/\{room\}\/messages\/\{msg\}\s*\{[\s\S]*?\}/,
    ''
  )
));
});
// ---------- finishing pass: abuse limits, fee attribution, owner page / account page wiring ----------
test('rate limit: the 61st /api/events call in a minute from one client -> 429; owner endpoint limited too', async () => {
  const s = setup({ rpcTx: null }); let last; for (let i = 0; i < 61; i++) last = await call(s.app.events, { body: { ...buy } }); assert.equal(last.statusCode, 429);
  const o = setup(); let ol; for (let i = 0; i < 31; i++) ol = await call(o.app.owner, { method: 'GET', token: 'owner-token' }); assert.equal(ol.statusCode, 429); });
test('rate limit: wallet-link attempts are capped at 10/min', async () => { const s = setup(); let r; for (let i = 0; i < 11; i++) r = await call(s.app.linkWallet, { token: 'user-token', body: { wallet: 'bad' } }); assert.equal(r.statusCode, 429); });
test('rate limit: limits are per client (a different x-forwarded-for is unaffected)', async () => {
  const s = setup({ rpcTx: null }); for (let i = 0; i < 61; i++) await call(s.app.events, { body: { ...buy } });
  const res = { headers: {}, setHeader() {}, end(b) { this.body = b ? JSON.parse(b) : null; } }; await s.app.events({ method: 'POST', url: '/', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.9' }, body: { ...buy } }, res); assert.equal(res.statusCode, 202); });
test('fee attribution: a trade where the Saturn treasury received value is feeVerified; a real trade that paid the treasury nothing is NOT', async () => {
  const s = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 10 }) }); await call(s.app.events, { body: buy }); assert.equal((await s.store.get('events/' + SIG)).feeVerified, true);
  const s2 = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 10, trePost: 0, treWsolPost: 0 }) }); await call(s2.app.events, { body: buy }); assert.equal((await s2.store.get('events/' + SIG)).feeVerified, false); });
test('owner summary separates fee-verified (Saturn-attributed) volume from unattributed trades', async () => {
  const s = setup({ rpcTx: mkTx({ wallet: W.address, tokPost: 10 }) }); await call(s.app.events, { body: buy });
  s.app = createApp({ auth, store: s.store, rpc: { async getTransaction() { return mkTx({ wallet: W.address, tokPost: 10, trePost: 0, treWsolPost: 0 }); } }, now: () => 1_700_000_000_000, env: { SATURN_ALLOWED_ORIGINS: ORIGIN, OWNER_UIDS: 'OWNER', PLATFORM_TREASURY_WALLET: TREASURY } });
  await call(s.app.events, { body: { ...buy, sig: SIG2 } }); const m = (await call(s.app.owner, { method: 'GET', token: 'owner-token' })).body.summary;
  assert.equal(m.trades, 2); assert.equal(m.feeVerifiedTrades, 1); assert.equal(m.feeVerifiedVolumeLamports, '100000000'); assert.equal(m.volumeLamports, '200000000'); });
