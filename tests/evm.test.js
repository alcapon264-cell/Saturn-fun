import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvm, CHAINS, SWAP_CHAINS, RPC_ALLOW, NATIVE, memoryLimiter } from '../lib/evm.js';

const A = '0x' + '11'.repeat(20);
const B = '0x' + '22'.repeat(20);
const T = '0x' + '33'.repeat(20);
const jr = (payload, ok = true, status = 200) => ({ ok, status, json: async () => payload });

function mock(extraEnv = {}, overrides = {}) {
  const calls = [];
  const env = {
    BLOCKVECTRA_API_KEY: 'test-blockvectra-key',
    ZEROX_API_KEY: 'test-0x-key',
    ...extraEnv
  };
  const ids = {
    eth_mainnet: '0x1',
    base_mainnet: '0x2105',
    arb_mainnet: '0xa4b1',
    polygon_mainnet: '0x89',
    robinhood_mainnet: '0x1237',
    bsc_mainnet: '0x38'
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith('https://api.0x.org/')) {
      return overrides.zeroX ? overrides.zeroX(url, options) :
        jr({ liquidityAvailable: true, sellAmount: '5', buyAmount: '9', minBuyAmount: '8',
          transaction: { to: A, data: '0x12', value: '5', gas: '21000', gasPrice: '2' } });
    }
    const slug = String(url).split('/').pop();
    const request = JSON.parse(options.body);
    if (request.method === 'eth_chainId') return jr({ jsonrpc: '2.0', id: 1, result: ids[slug] });
    return jr({ jsonrpc: '2.0', id: 1, result: '0xabc' });
  };
  return { evm: createEvm({ env, fetchImpl, limiter: overrides.limiter }), calls, env };
}

test('only the six selected EVM chains are configured', () => {
  assert.deepEqual(Object.keys(CHAINS), ['eth', 'base', 'arb', 'poly', 'robinhood', 'bsc']);
  assert.deepEqual([...SWAP_CHAINS], [1, 8453, 42161, 137, 4663, 56]);
  assert.equal(CHAINS.robinhood.chainId, 4663);
  for (const removed of ['op', 'avax', 'hyper']) assert.equal(Object.hasOwn(CHAINS, removed), false);
});

test('BlockVectra requests use fixed per-chain slugs and x-api-key header', async () => {
  const { evm, calls } = mock();
  const result = await evm.verified('base');
  assert.equal(result.ok, true);
  const call = calls[0];
  assert.equal(call.url, 'https://api.blockvectra.com/v1/base_mainnet');
  assert.equal(call.options.headers['x-api-key'], 'test-blockvectra-key');
  assert.equal(call.options.headers['content-type'], 'application/json');
  assert.equal(call.options.method, 'POST');
});

test('config verifies each chain id and never returns secrets or provider URLs', async () => {
  const { evm } = mock();
  const result = await evm.config({ method: 'GET', ip: '1.2.3.4' });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body.chains), ['eth', 'base', 'arb', 'poly', 'robinhood', 'bsc']);
  for (const chain of Object.values(result.body.chains)) {
    assert.equal(chain.rpc, true);
    assert.equal(chain.swap, true);
  }
  const serialized = JSON.stringify(result.body);
  assert.ok(!serialized.includes('test-blockvectra-key'));
  assert.ok(!serialized.includes('test-0x-key'));
  assert.ok(!serialized.includes('api.blockvectra.com'));
});

test('missing BlockVectra key reports all chains unavailable', async () => {
  const { evm } = mock({ BLOCKVECTRA_API_KEY: undefined });
  const result = await evm.config({ method: 'GET' });
  for (const chain of Object.values(result.body.chains)) {
    assert.equal(chain.rpc, false);
    assert.equal(chain.reason, 'rpc_not_configured');
  }
});

test('removed chains are rejected by RPC and quote routes', async () => {
  const { evm } = mock();
  for (const chain of ['op', 'avax', 'hyper', 'optimism', 'avalanche', 'hyperevm']) {
    assert.equal((await evm.rpc({ method: 'POST', query: { chain }, body: { method: 'eth_chainId' } })).status, 400);
    assert.equal((await evm.quote({ method: 'GET', query: { chain } })).status, 400);
  }
});

test('RPC allows read methods and raw signed tx broadcast, but refuses wallet signing methods', async () => {
  const { evm, calls } = mock();
  const request = (method, params = []) => evm.rpc({
    method: 'POST', query: { chain: 'eth' }, body: { id: 7, method, params }, ip: 'ip1'
  });
  const balance = await request('eth_getBalance', [A, 'latest']);
  assert.equal(balance.status, 200);
  assert.equal(balance.body.result, '0xabc');
  for (const method of ['eth_sign', 'personal_sign', 'eth_accounts', 'eth_sendTransaction', 'debug_traceTransaction']) {
    assert.equal((await request(method)).status, 403, method);
  }
  assert.ok(RPC_ALLOW.has('eth_sendRawTransaction'));
  assert.ok(!RPC_ALLOW.has('eth_sendTransaction'));
  assert.ok(calls.every(c => c.url.startsWith('https://api.blockvectra.com/v1/')));
});

test('RPC rejects malformed, oversized, unknown and wrong-method requests', async () => {
  const { evm } = mock();
  const run = (body, method = 'POST', chain = 'eth') => evm.rpc({ method, query: { chain }, body });
  assert.equal((await run('{broken')).status, 400);
  assert.equal((await run([{ method: 'eth_chainId' }])).status, 400);
  assert.equal((await run({ method: 'eth_call', params: ['x'.repeat(80000)] })).status, 413);
  assert.equal((await run({ method: 'eth_chainId' }, 'GET')).status, 405);
  assert.equal((await run({ method: 'eth_chainId' }, 'POST', 'nope')).status, 400);
});

test('quote uses 0x API v2 for each supported network and returns a trimmed transaction', async () => {
  const { evm, calls } = mock();
  for (const [key, chain] of Object.entries(CHAINS)) {
    const result = await evm.quote({ method: 'GET', query: {
      chain: key, mode: 'quote', sellToken: 'NATIVE', buyToken: T, sellAmount: '5', taker: B
    } });
    assert.equal(result.status, 200, key);
    assert.equal(result.body.ok, true, key);
    assert.equal(result.body.chainId, chain.chainId, key);
  }
  const quoteCall = calls.find(c => c.url.startsWith('https://api.0x.org/'));
  assert.ok(quoteCall.url.includes('chainId=1'));
  assert.equal(quoteCall.options.headers['0x-version'], 'v2');
  assert.equal(quoteCall.options.headers['0x-api-key'], 'test-0x-key');
  const first = await evm.quote({ method: 'GET', query: {
    chain: 'eth', mode: 'quote', sellToken: 'NATIVE', buyToken: T, sellAmount: '5', taker: B
  } });
  assert.deepEqual(Object.keys(first.body.transaction).sort(), ['data', 'gas', 'gasPrice', 'to', 'value']);
  assert.equal(first.body.sellToken, NATIVE);
});

test('quote validation, no key, no route and no liquidity', async () => {
  const baseQuery = { chain: 'eth', sellToken: 'NATIVE', buyToken: T, sellAmount: '5', taker: B };
  const { evm } = mock();
  assert.equal((await evm.quote({ method: 'GET', query: { ...baseQuery, sellAmount: '0' } })).status, 400);
  assert.equal((await evm.quote({ method: 'GET', query: { ...baseQuery, buyToken: 'bad' } })).status, 400);
  assert.equal((await evm.quote({ method: 'GET', query: { ...baseQuery, buyToken: NATIVE } })).body.error, 'same_token');
  const noKey = mock({ ZEROX_API_KEY: undefined }).evm;
  assert.equal((await noKey.quote({ method: 'GET', query: baseQuery })).body.error, 'swap_not_configured');
  const noRoute = mock({}, { zeroX: async () => jr({ reason: 'No route' }, false, 400) }).evm;
  assert.equal((await noRoute.quote({ method: 'GET', query: baseQuery })).body.error, 'no_route');
  const noLiquidity = mock({}, { zeroX: async () => jr({ liquidityAvailable: false }) }).evm;
  assert.equal((await noLiquidity.quote({ method: 'GET', query: baseQuery })).body.error, 'no_liquidity');
});

test('rate limiter is applied to each EVM handler', async () => {
  const seen = [];
  const { evm } = mock({}, { limiter: name => { seen.push(name); return true; } });
  assert.equal((await evm.config({ method: 'GET' })).status, 429);
  assert.equal((await evm.rpc({ method: 'POST', query: { chain: 'eth' }, body: { method: 'eth_chainId' } })).status, 429);
  assert.equal((await evm.quote({ method: 'GET', query: {} })).status, 429);
  assert.deepEqual(seen, ['cfg', 'rpc', 'quote']);
  const limiter = memoryLimiter();
  let blocked = 0;
  for (let i = 0; i < 130; i++) if (limiter('rpc', 'a', 120, 60000)) blocked++;
  assert.equal(blocked, 10);
});
