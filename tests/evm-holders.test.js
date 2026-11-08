// Routescan holder adapter tests use mocked fetch; no external API calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evmHolders } from '../lib/evm-holders.js';

const TOKEN = '0x' + 'ab'.repeat(20);
const HOLDER = '0x' + '01'.repeat(20);
const response = (body, options = {}) => async (url, init) => ({ ok: true, status: 200, json: async () => body, url, init, ...options });

test('rejects networks not currently confirmed in Routescan supported-chain catalog', async () => {
  for (const chain of ['base', 'arb', 'poly', 'bsc', 'robinhood']) {
    assert.equal((await evmHolders({ chain, token: TOKEN })).body.error, 'unsupported_chain');
  }
});

test('rejects invalid token address', async () => {
  assert.equal((await evmHolders({ chain: 'eth', token: '0x123' })).status, 400);
});

test('calls Ethereum ERC20 holders endpoint without an API key on free tier', async () => {
  let called;
  const fetchImpl = async (url, init) => {
    called = { url, init };
    return { ok: true, status: 200, json: async () => ({ items: [{ chainId: '1', address: HOLDER, balance: '5000', percentage: 0.5 }], link: {} }) };
  };
  const result = await evmHolders({ chain: 'eth', token: TOKEN, limit: '2' }, { env: {}, fetchImpl });
  assert.equal(called.url, `https://api.routescan.io/v2/network/mainnet/evm/1/erc20/${TOKEN}/holders?limit=2`);
  assert.equal(called.init.headers.apikey, undefined);
  assert.deepEqual(result.body, { ok: true, holders: [{ address: HOLDER, balance: '5000', percentage: 0.5 }], nextCursor: null });
});

test('sends optional Routescan key only as apikey header', async () => {
  let init;
  const fetchImpl = async (_url, options) => { init = options; return { ok: true, status: 200, json: async () => ({ items: [], link: {} }) }; };
  await evmHolders({ chain: 'eth', token: TOKEN }, { env: { ROUTESCAN_API_KEY: 'secret-test-key' }, fetchImpl });
  assert.equal(init.headers.apikey, 'secret-test-key');
  assert.equal(init.headers.accept, 'application/json');
});

test('maps holders and pagination token', async () => {
  const result = await evmHolders({ chain: 'eth', token: TOKEN }, { env: {}, fetchImpl: response({ items: [{ address: HOLDER, balance: '999' }], link: { nextToken: 'page-two' } }) });
  assert.deepEqual(result.body, { ok: true, holders: [{ address: HOLDER, balance: '999' }], nextCursor: 'page-two' });
});

test('passes pagination cursor as next query parameter', async () => {
  let url;
  await evmHolders({ chain: 'eth', token: TOKEN, cursor: 'page-two' }, { env: {}, fetchImpl: async (u) => { url = u; return { ok: true, status: 200, json: async () => ({ items: [], link: {} }) }; } });
  assert.match(url, /[?&]next=page-two/);
});

test('rejects malformed provider rows rather than inventing values', async () => {
  const result = await evmHolders({ chain: 'eth', token: TOKEN }, { env: {}, fetchImpl: response({ items: [{ address: HOLDER, balance: 12.5 }] }) });
  assert.equal(result.body.error, 'provider_bad_response');
});

test('reports rate limiting distinctly', async () => {
  const result = await evmHolders({ chain: 'eth', token: TOKEN }, { env: {}, fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(result.body.error, 'provider_rate_limited');
});

test('reports network failure', async () => {
  const result = await evmHolders({ chain: 'eth', token: TOKEN }, { env: {}, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.body.error, 'provider_unreachable');
});
