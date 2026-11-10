import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bnbHolders, _test } from '../lib/bnbHolders.js';

const TOKEN = '0x' + '55'.repeat(20);
const A = n => '0x' + n.toString(16).padStart(2, '0').repeat(20);
const env = { GOLDRUSH_API_KEY: 'test-only-secret' };
const item = (address, balance) => ({ address, balance, total_supply: '1000000', contract_decimals: 6 });
const payload = (items, hasMore = false, total = items.length) => ({ error: false, data: { items, pagination: { has_more: hasMore, total_count: total, page_number: 0, page_size: 100 } } });
const response = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: k => headers[k.toLowerCase()] || null } });
beforeEach(() => { _test.cache.clear(); _test.inflight.clear(); });

test('requires a server-side GoldRush key', async () => {
  const r = await bnbHolders({ query: { token: TOKEN }, env: {} });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'not_configured');
});
test('validates token and cursor', async () => {
  assert.equal((await bnbHolders({ query: { token: '0x123' }, env })).status, 400);
  assert.equal((await bnbHolders({ query: { token: TOKEN, cursor: '../' }, env })).body.error, 'invalid_cursor');
  assert.deepEqual(_test.parseCursor('0:50'), { page: 0, offset: 50 });
  assert.deepEqual(_test.parseCursor('2'), { page: 2, offset: 0 });
});
test('uses supported GoldRush page size and excludes unsupported no-spam parameter', async () => {
  let requestUrl = '';
  const r = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: async url => { requestUrl = url; return response(200, payload([item(A(1), '2')], false)); } });
  assert.equal(r.status, 200);
  assert.match(requestUrl, /page-size=100/);
  assert.match(requestUrl, /page-number=0/);
  assert.doesNotMatch(requestUrl, /no-spam/);
});
test('splits GoldRush 100-row pages into Saturn 50-row pages without skipping rows', async () => {
  const items = Array.from({ length: 100 }, (_, i) => item(A(i + 1), String(i + 1)));
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(200, payload(items, true, 150)); };
  const first = await bnbHolders({ query: { token: TOKEN, limit: '50' }, env, fetchImpl });
  const second = await bnbHolders({ query: { token: TOKEN, limit: '50', cursor: first.body.nextCursor }, env, fetchImpl });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(first.body.holders.length, 50); assert.equal(second.body.holders.length, 50);
  assert.equal(first.body.holders[0].address, A(1)); assert.equal(second.body.holders[0].address, A(51));
  assert.equal(first.body.nextCursor, '0:50'); assert.equal(second.body.nextCursor, '1:0');
  assert.equal(calls, 1); // second 50 are sliced from cached first upstream page
});
test('advances to the next GoldRush page after the first 100 holders', async () => {
  const items = Array.from({ length: 100 }, (_, i) => item(A(i + 1), String(i + 1)));
  let pageUrls = [];
  const fetchImpl = async url => { pageUrls.push(url); return response(200, payload(items, true, 250)); };
  const a = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl });
  const b = await bnbHolders({ query: { token: TOKEN, cursor: a.body.nextCursor }, env, fetchImpl });
  const c = await bnbHolders({ query: { token: TOKEN, cursor: b.body.nextCursor }, env, fetchImpl });
  assert.equal(a.body.nextCursor, '0:50');
  assert.equal(b.body.nextCursor, '1:0');
  assert.match(pageUrls[1], /page-number=1/);
  assert.equal(c.body.nextCursor, '1:50');
});
test('maps GoldRush authentication, credit, and parameter failures explicitly', async () => {
  const auth = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: async () => response(401, {}) });
  const credits = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: async () => response(402, {}) });
  const bad = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: async () => response(400, {}) });
  assert.equal(auth.body.error, 'provider_auth');
  assert.equal(credits.body.error, 'provider_credits_exhausted');
  assert.equal(bad.body.error, 'provider_bad_request');
});
test('maps rate limit and upstream errors', async () => {
  const rate = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: async () => response(429, {}, { 'retry-after': '7' }) });
  const upstream = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: async () => response(503, {}) });
  assert.equal(rate.status, 429); assert.equal(rate.headers['retry-after'], '7');
  assert.equal(upstream.body.error, 'provider_unavailable');
});
test('rejects malformed rows and never returns fake holders', async () => {
  const bad = await bnbHolders({ query: { token: TOKEN }, env, fetchImpl: async () => response(200, payload([{ address: 'bad', balance: '1' }])) });
  assert.equal(bad.status, 502); assert.equal(bad.body.error, 'bad_provider_response');
});
