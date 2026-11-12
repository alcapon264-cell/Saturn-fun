import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifi, LIFI_CHAIN_IDS } from '../lib/lifi.js';

const EVM = '0x' + '11'.repeat(20);
const EVM_TO = '0x' + '22'.repeat(20);
const SOL = '11111111111111111111111111111111';
const SOL_WALLET = 'So11111111111111111111111111111111111111112';
const SOL_TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const HASH = '0x' + 'ab'.repeat(32);
const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

function setup(overrides = {}, env = {}) {
  const calls = [];
  const lifi = createLifi({
    env,
    limiter: () => false,
    now: () => 123456,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (overrides.fetch) return overrides.fetch(String(url), options);
      if (String(url).includes('/status')) return response({ status: 'DONE', receiving: { txHash: HASH } });
      return response({ transactionRequest: { to: EVM, data: '0x1234', value: '0x0' }, estimate: { toAmount: '100', toAmountMin: '98', executionDuration: 120 } });
    }
  });
  return { lifi, calls };
}

const quoteReq = (query = {}) => ({
  method: 'GET',
  ip: '127.0.0.1',
  query: {
    fromChain: LIFI_CHAIN_IDS.solana,
    toChain: LIFI_CHAIN_IDS.ethereum,
    fromToken: SOL,
    toToken: '0x0000000000000000000000000000000000000000',
    fromAddress: SOL_WALLET,
    toAddress: EVM_TO,
    fromAmount: '1000000000',
    ...query
  }
});

test('LI.FI supported chain IDs include Saturn networks', () => {
  assert.deepEqual(LIFI_CHAIN_IDS, {
    solana: '1151111081099710', ethereum: '1', base: '8453',
    arbitrum: '42161', polygon: '137', robinhood: '4663', bnb: '56'
  });
});

test('quote proxies an executable Solana to EVM route and keeps API key server-side', async () => {
  const { lifi, calls } = setup({}, { LIFI_API_KEY: 'server-only-secret' });
  const result = await lifi.quote(quoteReq());
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.provider, 'LI.FI');
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('fromChain'), LIFI_CHAIN_IDS.solana);
  assert.equal(url.searchParams.get('toChain'), '1');
  assert.equal(url.searchParams.get('fromAmount'), '1000000000');
  assert.equal(url.searchParams.get('integrator'), 'Saturn');
  assert.equal(calls[0].options.headers['x-lifi-api-key'], 'server-only-secret');
  assert.ok(!JSON.stringify(result.body).includes('server-only-secret'));
});

test('quote supports EVM to Solana and uses actual destination address', async () => {
  const { lifi, calls } = setup();
  const result = await lifi.quote(quoteReq({
    fromChain: '1', toChain: LIFI_CHAIN_IDS.solana,
    fromToken: '0x0000000000000000000000000000000000000000',
    toToken: SOL_TOKEN, fromAddress: EVM, toAddress: SOL_WALLET, fromAmount: '1000000000000000000'
  }));
  assert.equal(result.body.ok, true);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('fromAddress'), EVM);
  assert.equal(url.searchParams.get('toAddress'), SOL_WALLET);
});

test('quote rejects invalid chains, same-chain requests, addresses, token addresses, amounts and slippage', async () => {
  const { lifi, calls } = setup();
  for (const q of [
    { fromChain: '10' },
    { fromChain: '1', toChain: '1' },
    { fromAddress: 'not-a-wallet' },
    { toAddress: 'not-a-wallet' },
    { fromToken: 'bad-token' },
    { toToken: 'bad-token' },
    { fromAmount: '0' },
    { fromAmount: '1.5' },
    { slippage: '0.9' }
  ]) {
    const result = await lifi.quote(quoteReq(q));
    assert.equal(result.status, 400, JSON.stringify(q));
  }
  assert.equal(calls.length, 0);
});

test('quote never presents a non-executable response as a route', async () => {
  const { lifi } = setup({ fetch: async () => response({ message: 'no route' }) });
  const result = await lifi.quote(quoteReq());
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error, 'no_executable_route');
});

test('provider no-route and rate-limit errors are normalized', async () => {
  const noRoute = setup({ fetch: async () => response({ message: 'No route' }, false, 400) });
  assert.equal((await noRoute.lifi.quote(quoteReq())).body.error, 'no_route');
  const limited = setup({ fetch: async () => response({}, false, 429) });
  assert.equal((await limited.lifi.quote(quoteReq())).status, 429);
});

test('status validates hashes and chain IDs before forwarding', async () => {
  const { lifi, calls } = setup();
  const bad = await lifi.status({ method: 'GET', query: { txHash: 'bad', fromChain: '1', toChain: '8453' } });
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 0);
  const good = await lifi.status({ method: 'GET', query: { txHash: HASH, fromChain: '1', toChain: LIFI_CHAIN_IDS.solana } });
  assert.equal(good.status, 200);
  assert.equal(good.body.status, 'DONE');
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v1/status');
  assert.equal(url.searchParams.get('txHash'), HASH);
});

test('both routes require GET', async () => {
  const { lifi } = setup();
  assert.equal((await lifi.quote({ method: 'POST' })).status, 405);
  assert.equal((await lifi.status({ method: 'POST' })).status, 405);
});
