import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bnbHolders, _test } from '../lib/bnbHolders.js';

const TOKEN = '0x' + '55'.repeat(20);
const A = '0x' + '11'.repeat(20);
const B = '0x' + '22'.repeat(20);
const env = { GOLDRUSH_API_KEY: 'test-only-secret' };
const payload = (items, hasMore = false, total = items.length) => ({ error: false, data: { items, pagination: { has_more: hasMore, total_count: total } } });
const item = (address, balance) => ({ address, balance, total_supply: '1000000', contract_decimals: 6 });
const fetchWith = (status, body, headers = {}) => async (url, init) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: k => headers[k.toLowerCase()] || null }, url, init });
beforeEach(() => { _test.cache.clear(); _test.inflight.clear(); });

test('requires server-side GoldRush key and never calls provider without it', async () => {
  let calls = 0;
  const r = await bnbHolders({ query: { token: TOKEN }, env: {}, fetchImpl: async () => { calls++; } });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'not_configured'); assert.equal(calls, 0);
});
test('validates contract address and cursor', async () => {
  assert.equal((await bnbHolders({ query: { token: '0x123' }, env })).status, 400);
  assert.equal((await bnbHolders({ query: { token: TOKEN, cursor: '../' }, env })).body.error, 'invalid_cursor');
});
test('calls GoldRush BNB mainnet with bearer key only server-side', async () => {
  let call;
  const r = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: async (url, init) => { call = { url, init }; return { ok: true, status: 200, json: async () => payload([item(A, '42')], true, 12) }; } });
  assert.equal(r.status, 200); assert.equal(r.body.chain, 'bsc'); assert.equal(r.body.holders[0].balance, '42');
  assert.match(call.url, /bsc-mainnet\/tokens\//); assert.equal(call.init.headers.Authorization, 'Bearer test-only-secret');
  assert.ok(!JSON.stringify(r).includes('test-only-secret'));
});
test('supports page cursor and preserves real supply metadata', async () => {
  let url;
  const r = await bnbHolders({ query: { token: TOKEN, cursor: '2', limit: '25' }, env, fetchImpl: async u => { url = u; return { ok: true, status: 200, json: async () => payload([item(A, '9')], false, 1) }; } });
  assert.match(url, /page-number=2/); assert.match(url, /page-size=25/); assert.equal(r.body.nextCursor, null); assert.equal(r.body.decimals, 6); assert.equal(r.body.totalSupply, '1000000');
});
test('drops zero balances and rejects malformed provider rows', async () => {
  const ok = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: fetchWith(200, payload([item(A, '0'), item(B, '5')])) });
  assert.deepEqual(ok.body.holders.map(x => x.address), [B]);
  const bad = await bnbHolders({ query: { token: '0x' + '66'.repeat(20) }, env, fetchImpl: fetchWith(200, payload([{ address: 'bad', balance: '5' }])) });
  assert.equal(bad.status, 502); assert.equal(bad.body.error, 'bad_provider_response');
});
test('maps rate limiting and provider authentication errors safely', async () => {
  const rate = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: fetchWith(429, {}, { 'retry-after': '7' }) });
  assert.equal(rate.status, 429); assert.equal(rate.headers['retry-after'], '7');
  const auth = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: fetchWith(401, {}) });
  assert.equal(auth.status, 502); assert.equal(auth.body.error, 'provider_auth');
});
test('coalesces simultaneous identical provider requests and caches success', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { ok: true, status: 200, json: async () => payload([item(A, '4')]) }; };
  const args = { query: { token: TOKEN }, env, fetchImpl };
  await Promise.all([bnbHolders(args), bnbHolders(args)]);
  await bnbHolders(args);
  assert.equal(calls, 1);
});
test('maps network and upstream failures without inventing rows', async () => {
  const net = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(net.status, 502); assert.equal(net.body.error, 'provider_unreachable');
  const upstream = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: fetchWith(503, {}) });
  assert.equal(upstream.body.error, 'provider_error');
});
