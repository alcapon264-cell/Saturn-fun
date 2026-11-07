import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvm, CHAINS, RPC_ALLOW, NATIVE, memoryLimiter } from '../lib/evm.js';

const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), T = '0x' + '33'.repeat(20);
const jr = (o, ok = true, status = 200) => ({ ok, status, json: async () => o });
// Fake upstream: chain id by URL; records calls.
function mk(envExtra = {}, over = {}) {
  const calls = [], env = Object.assign({ EVM_RPC_URL_ETH: 'https://rpc.eth/k', EVM_RPC_URL_BASE: 'https://rpc.base/k', EVM_RPC_URL_ARB: 'https://rpc.arb/k' }, envExtra);
  const ids = { 'https://rpc.eth/k': '0x1', 'https://rpc.base/k': '0x2105', 'https://rpc.arb/k': '0x1' /* WRONG on purpose */, 'https://rpc.rh/k': '0x1237' };
  const fetchImpl = async (url, opt) => {
    calls.push([String(url), opt && opt.body]);
    if (String(url).startsWith('https://api.0x.org/')) return over.zerox ? over.zerox(url, opt) : jr({ liquidityAvailable: true, sellAmount: '5', buyAmount: '9', minBuyAmount: '8', transaction: { to: A, data: '0x12', value: '5', gas: '21000' } });
    const b = JSON.parse(opt.body);
    if (b.method === 'eth_chainId') return jr({ jsonrpc: '2.0', id: 1, result: ids[url] });
    return jr({ jsonrpc: '2.0', id: 1, result: '0xabc' });
  };
  return { evm: createEvm({ env, fetchImpl, limiter: over.limiter }), calls, env };
}

test('config: only chains whose RPC returns the exact chain id are rpc:true; no secrets in output', async () => {
  const { evm } = mk({ ZEROX_API_KEY: 'secret-key' });
  const r = await evm.config({ method: 'GET', ip: '1' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.chains.eth.rpc, r.body.chains.base.rpc, r.body.chains.arb.rpc], [true, true, false]);
  assert.equal(r.body.chains.arb.reason, 'chain_id_mismatch');
  assert.equal(r.body.chains.op.reason, 'rpc_not_configured');
  assert.equal(r.body.chains.eth.swap, true);
  assert.equal(r.body.chains.hyper.swap, false);
  const s = JSON.stringify(r.body); assert.ok(!s.includes('secret-key') && !s.includes('rpc.eth'));
  assert.equal(Object.keys(r.body.chains).length, 9);
  assert.equal(CHAINS.robinhood.chainId, 4663);
});
test('config: swap is false without a 0x key; wrong method refused', async () => {
  const { evm } = mk();
  assert.equal((await evm.config({ method: 'GET' })).body.chains.eth.swap, false);
  assert.equal((await evm.config({ method: 'POST' })).status, 405);
});
test('robinhood verifies only with 4663', async () => {
  const { evm } = mk({ EVM_RPC_URL_ROBINHOOD: 'https://rpc.rh/k' });
  assert.equal((await evm.config({ method: 'GET' })).body.chains.robinhood.rpc, true);
});
test('rpc: allow-list, single request, unknown chain, unverified chain', async () => {
  const { evm, calls } = mk();
  const go = (chain, body, method = 'POST') => evm.rpc({ method, query: { chain }, body, ip: 'x' });
  assert.equal((await go('eth', { method: 'eth_getBalance', params: [A, 'latest'] })).body.result, '0xabc');
  for (const m of ['eth_sign', 'personal_sign', 'debug_traceTransaction', 'eth_accounts', 'admin_peers', 'eth_sendTransaction']) assert.equal((await go('eth', { method: m, params: [] })).status, 403, m);
  assert.equal((await go('eth', [{ method: 'eth_chainId' }])).status, 400);
  assert.equal((await go('nope', { method: 'eth_chainId' })).status, 400);
  assert.equal((await go('__proto__', { method: 'eth_chainId' })).status, 400);
  assert.equal((await go('arb', { method: 'eth_getBalance', params: [A, 'latest'] })).status, 503);
  assert.equal((await go('op', { method: 'eth_getBalance', params: [A, 'latest'] })).status, 503);
  assert.equal((await go('eth', { method: 'eth_call', params: ['x'.repeat(80000)] })).status, 413);
  assert.equal((await go('eth', { method: 'eth_getBalance' }, 'GET')).status, 405);
  assert.equal((await go('eth', '{bad json')).status, 400);
  assert.ok(!calls.some(c => /arb/.test(c[0]) && /eth_getBalance/.test(c[1] || '')), 'unverified chain must never be queried for data');
  assert.ok(RPC_ALLOW.has('eth_sendRawTransaction') && !RPC_ALLOW.has('eth_sendTransaction'));
});
test('quote: validation, native alias, limits, chain verification, trimmed output', async () => {
  const { evm, calls } = mk({ ZEROX_API_KEY: 'k' });
  const q = (o) => evm.quote({ method: 'GET', ip: 'q', query: Object.assign({ chain: 'eth', mode: 'quote', sellToken: 'NATIVE', buyToken: T, sellAmount: '5', taker: B, slippageBps: '100' }, o) });
  const ok = await q({});
  assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.equal(ok.body.sellToken, NATIVE); assert.equal(ok.body.chainId, 1);
  assert.deepEqual(Object.keys(ok.body.transaction).sort(), ['data', 'gas', 'gasPrice', 'to', 'value']);
  const zx = calls.find(c => c[0].startsWith('https://api.0x.org/'))[0]; assert.match(zx, /chainId=1&/); assert.match(zx, /slippageBps=100/);
  assert.equal((await q({ sellAmount: '0' })).status, 400); assert.equal((await q({ sellAmount: '-1' })).status, 400);
  assert.equal((await q({ buyToken: 'zzz' })).status, 400); assert.equal((await q({ taker: '0x12' })).status, 400);
  assert.equal((await q({ buyToken: NATIVE })).body.error, 'same_token');
  assert.equal((await q({ chain: 'arb' })).status, 503);
  assert.equal((await q({ slippageBps: '99999' })).status, 200);
  assert.match(calls.filter(c => c[0].startsWith('https://api.0x.org/')).pop()[0], /slippageBps=1000/);
  assert.equal((await q({ mode: 'price' })).body.transaction, null);
});
test('quote: no key -> 503; upstream error -> no_route; no liquidity', async () => {
  assert.equal((await mk().evm.quote({ method: 'GET', query: { chain: 'eth', sellToken: 'NATIVE', buyToken: T, sellAmount: '5', taker: B } })).body.error, 'swap_not_configured');
  const { evm } = mk({ ZEROX_API_KEY: 'k' }, { zerox: async () => jr({ reason: 'No route' }, false, 400) });
  const r = await evm.quote({ method: 'GET', query: { chain: 'eth', sellToken: 'NATIVE', buyToken: T, sellAmount: '5', taker: B } });
  assert.equal(r.body.ok, false); assert.equal(r.body.error, 'no_route');
  const m2 = mk({ ZEROX_API_KEY: 'k' }, { zerox: async () => jr({ liquidityAvailable: false }) });
  assert.equal((await m2.evm.quote({ method: 'GET', query: { chain: 'eth', sellToken: 'NATIVE', buyToken: T, sellAmount: '5', taker: B } })).body.error, 'no_liquidity');
});
test('abuse protection: injected (shared) limiter is honoured per route; default limiter caps rpc', async () => {
  const seen = []; const { evm } = mk({ ZEROX_API_KEY: 'k' }, { limiter: (name, ip) => { seen.push([name, ip]); return true; } });
  assert.equal((await evm.config({ method: 'GET', ip: '9.9.9.9' })).status, 429);
  assert.equal((await evm.rpc({ method: 'POST', ip: '9.9.9.9', query: { chain: 'eth' }, body: { method: 'eth_chainId' } })).status, 429);
  assert.equal((await evm.quote({ method: 'GET', ip: '9.9.9.9', query: {} })).status, 429);
  assert.deepEqual(seen.map(s => s[0]), ['cfg', 'rpc', 'quote']);
  const lim = memoryLimiter(); let n = 0; for (let i = 0; i < 130; i++) if (lim('rpc', '1.1.1.1', 120, 60000)) n++; assert.equal(n, 10);
  assert.equal(lim('rpc', '2.2.2.2', 120, 60000), false);
});
test('module is ESM-only and has no token creation / signing surface', async () => {
  const mod = await import('../lib/evm.js'); const names = Object.keys(mod).join(' ');
  assert.ok(!/createToken|launch|sign|mint|deploy/i.test(names), names);
  const src = (await import('node:fs')).readFileSync(new URL('../lib/evm.js', import.meta.url), 'utf8');
  assert.ok(!/require\(|module\.exports/.test(src));
});

// ======================= Integration with Saturn's existing app (lib/app.js + api/[route].js) =======================
import fs from 'node:fs';
import { createApp } from '../lib/app.js';

const ORIGIN = 'https://saturn-io.netlify.app';
const memStore = (seed = {}) => { const d = new Map(Object.entries(seed)); return { d,
  async get(p) { return d.has(p) ? structuredClone(d.get(p)) : null; },
  async set(p, v, merge) { d.set(p, merge ? { ...(d.get(p) || {}), ...v } : v); },
  async create(p, v) { if (d.has(p)) return false; d.set(p, structuredClone(v)); return true; } }; };
const TOKENS = { 'user-token': { uid: 'U1', email: 'u@x' }, 'banned-token': { uid: 'B1', email: 'b@x' } };
const auth = { async verifyIdToken(t) { if (!TOKENS[t]) throw new Error('bad'); return TOKENS[t]; } };
function mkApp(env = {}, store = memStore({ 'moderation/B1': { status: 'banned' } })) {
  const upstream = [];
  globalThis.fetch = async (url, opt) => { // fake network: nothing real is ever contacted
    upstream.push(String(url));
    if (String(url).startsWith('https://api.0x.org/')) return jr({ liquidityAvailable: true, sellAmount: '5', buyAmount: '9', minBuyAmount: '8', transaction: { to: A, data: '0x12', value: '5' } });
    const b = JSON.parse(opt.body); return jr({ jsonrpc: '2.0', id: 1, result: b.method === 'eth_chainId' ? '0x1' : '0x7b' });
  };
  const app = createApp({ auth, store, rpc: { async forward() { return { jsonrpc: '2.0', id: 1, result: 'sol' }; } },
    env: { SATURN_ALLOWED_ORIGINS: ORIGIN, EVM_RPC_URL_ETH: 'https://secret-rpc.example/KEY123', ZEROX_API_KEY: 'SECRET0X', ...env } });
  return { app, upstream };
}
const call = async (h, { method = 'POST', token, origin = ORIGIN, body, query = {}, ip = '3.3.3.' + Math.floor(Math.random() * 250) } = {}) => {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  await h({ method, url: '/x', query, headers: { ...(origin ? { origin } : {}), 'x-forwarded-for': ip, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body }, res); return res; };
const rpcBody = { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [A, 'latest'] };
const quoteQ = { chain: 'eth', mode: 'quote', sellToken: 'NATIVE', buyToken: T, sellAmount: '5', taker: B, slippageBps: '100' };

test('router: every pre-existing route is still registered and the three EVM routes were added', async () => {
  const src = fs.readFileSync(new URL('../api/[route].js', import.meta.url), 'utf8');
  const table = Object.fromEntries([...src.matchAll(/^\s*'?([\w-]+)'?:\s*'(\w+)',?$/gm)].map(m => [m[1], m[2]]));
  const original = { account: 'account', 'chat-eligibility': 'chatEligibility', 'chat-history': 'chatHistory', 'chat-list': 'chatList', 'chat-open': 'chatOpen', 'chat-read': 'chatRead', 'chat-send': 'chatSend',
    'support-open': 'supportOpen', 'support-list': 'supportList', 'support-history': 'supportHistory', 'support-send': 'supportSend', 'community-post': 'communityPost', 'community-delete': 'communityDelete',
    events: 'events', 'follow-counts': 'followCounts', 'follow-list': 'followList', 'follow-set': 'followSet', 'link-identity': 'linkIdentity', 'link-wallet': 'linkWallet', 'notifications-list': 'notificationsList',
    'notifications-read': 'notificationsRead', owner: 'owner', admin: 'admin', report: 'reportSubmit', 'profile-get': 'profileGet', 'profile-save': 'profileSave', 'profile-search': 'profileSearch', settings: 'settings', rpc: 'rpcProxy', rewards: 'rewards' };
  for (const [k, v] of Object.entries(original)) assert.equal(table[k], v, 'route ' + k);
  assert.deepEqual([table['evm-config'], table['evm-rpc'], table['evm-quote']], ['evmConfig', 'evmRpc', 'evmQuote']);
  const { app } = mkApp();
  for (const m of Object.values(table)) assert.equal(typeof app[m], 'function', m);
  assert.equal(Object.keys(table).length, 33);
});
test('evm-config: public, origin allowlisted, GET only, no secrets, no upstream call for unconfigured chains', async () => {
  const { app } = mkApp();
  const r = await call(app.evmConfig, { method: 'GET' });
  assert.equal(r.statusCode, 200); assert.equal(r.body.chains.eth.rpc, true); assert.equal(r.body.chains.eth.swap, true); assert.equal(r.body.chains.base.reason, 'rpc_not_configured');
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
  const s = JSON.stringify(r.body); assert.ok(!/KEY123|SECRET0X|secret-rpc/.test(s));
  assert.equal((await call(app.evmConfig, { method: 'GET', origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await call(app.evmConfig, { method: 'OPTIONS' })).statusCode, 204);
  assert.equal((await call(app.evmConfig, { method: 'POST' })).statusCode, 405);
});
test('evm-rpc: requires a signed-in Saturn user; origin allowlist; method allow-list; upstream never reached when refused', async () => {
  const { app, upstream } = mkApp();
  assert.equal((await call(app.evmRpc, { body: rpcBody })).statusCode, 401);
  assert.equal((await call(app.evmRpc, { token: 'nope', body: rpcBody })).statusCode, 401);
  assert.equal((await call(app.evmRpc, { token: 'user-token', origin: 'https://evil.example', body: rpcBody, query: { chain: 'eth' } })).statusCode, 403);
  assert.equal((await call(app.evmRpc, { token: 'user-token', method: 'GET', query: { chain: 'eth' } })).statusCode, 405);
  assert.equal(upstream.length, 0, 'no upstream call before auth/origin checks pass');
  const ok = await call(app.evmRpc, { token: 'user-token', body: rpcBody, query: { chain: 'eth' } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.body.result, '0x7b');
  assert.equal((await call(app.evmRpc, { token: 'user-token', body: { method: 'eth_sign', params: [] }, query: { chain: 'eth' } })).statusCode, 403);
  assert.equal((await call(app.evmRpc, { token: 'user-token', body: rpcBody, query: { chain: 'base' } })).statusCode, 503);
});
test('evm-rpc / evm-quote: banned accounts are refused by the shared guard', async () => {
  const { app, upstream } = mkApp();
  assert.equal((await call(app.evmRpc, { token: 'banned-token', body: rpcBody, query: { chain: 'eth' } })).statusCode, 403);
  assert.equal((await call(app.evmQuote, { method: 'GET', token: 'banned-token', query: quoteQ })).statusCode, 403);
  assert.equal(upstream.length, 0);
});
test('evm-quote: requires sign-in, validates, never leaks the 0x key', async () => {
  const { app, upstream } = mkApp();
  assert.equal((await call(app.evmQuote, { method: 'GET', query: quoteQ })).statusCode, 401);
  assert.equal(upstream.length, 0);
  const r = await call(app.evmQuote, { method: 'GET', token: 'user-token', query: quoteQ });
  assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true); assert.ok(!/SECRET0X|KEY123/.test(JSON.stringify(r.body)));
  assert.equal((await call(app.evmQuote, { method: 'GET', token: 'user-token', query: { ...quoteQ, sellAmount: '0' } })).statusCode, 400);
  assert.equal((await call(app.evmQuote, { method: 'POST', token: 'user-token', query: quoteQ })).statusCode, 405);
});
test('abuse protection: the shared per-IP limiter caps each EVM route (config 60, quote 40, rpc 240 per minute)', async () => {
  const { app } = mkApp(); const hit = async (h, o, n) => { let last; for (let i = 0; i < n; i++) last = await call(h, { ...o, ip: '9.9.9.9' }); return last.statusCode; };
  assert.equal(await hit(app.evmConfig, { method: 'GET' }, 60), 200); assert.equal(await hit(app.evmConfig, { method: 'GET' }, 1), 429);
  assert.equal(await hit(app.evmQuote, { method: 'GET', token: 'user-token', query: quoteQ }, 40), 200); assert.equal(await hit(app.evmQuote, { method: 'GET', token: 'user-token', query: quoteQ }, 1), 429);
  assert.equal(await hit(app.evmRpc, { token: 'user-token', body: rpcBody, query: { chain: 'eth' } }, 240), 200); assert.equal(await hit(app.evmRpc, { token: 'user-token', body: rpcBody, query: { chain: 'eth' } }, 1), 429);
});
test('existing Solana rpcProxy is unchanged: still forwards to the Solana provider, EVM routes do not touch it', async () => {
  const { app, upstream } = mkApp();
  const r = await call(app.rpcProxy, { body: { method: 'getBalance', params: ['x'] } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.result, 'sol'); assert.equal(upstream.length, 0);
});
