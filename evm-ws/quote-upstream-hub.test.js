import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { createRegistry } from '../src/registry.js';
import { createQuoteService } from '../src/quote.js';
import { createUpstream } from '../src/upstream.js';
import { createHub } from '../src/hub.js';
import { createMetrics } from '../src/metrics.js';
import { CHAIN_CONFIG } from '../src/chains.js';
import { TOPIC } from '../src/abi.js';
import { createWorld, addr, buildPool, addRefPool, makeFetch, LOW, HIGH, v3SwapLog, sqrtPFromHumanPrice, tick } from './helpers.js';
import { FakeUpstreamWS, FakeBrowserWS } from './fakes.js';

const close = (a, b, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel, `${a} !~ ${b}`);

/* ================= quote USD ================= */
function quoteSetup(chain, fetchImpl = makeFetch(), clk = { t: 1e12 }) {
  const world = createWorld(); world.deployConfig(chain); const metrics = createMetrics(), now = () => clk.t;
  const registry = createRegistry({ rpc: world.rpc, metrics, now });
  return { world, metrics, clk, quotes: createQuoteService({ registry, fetchImpl, now, metrics, ttlMs: 1000, staleMs: 10000 }), fetchImpl };
}
test('quote: stablecoins are 1 USD (labelled peg assumption); unknown assets are never priced', async () => {
  const Q = quoteSetup('eth'), USDC = Object.keys(CHAIN_CONFIG.eth.stables)[0];
  const s = Q.quotes.peek('eth', USDC); assert.equal(s.usd, 1); assert.equal(s.basis, 'stable_peg_assumed');
  assert.equal(Q.quotes.peek('eth', addr(0x1111)), null); assert.equal(await Q.quotes.get('eth', addr(0x1111)), null);
});
test('quote: wrapped native from the deepest on-chain reference pool; many reads, one refresh; stale-if-error window then null', async () => {
  const Q = quoteSetup('eth'), W = CHAIN_CONFIG.eth.native.wrapped; addRefPool(Q.world, 'eth', 3200);
  const q = await Q.quotes.get('eth', W); close(q.usd, 3200); assert.equal(q.basis, 'onchain_reference_pool'); assert.equal(Q.fetchImpl.calls.length, 0);
  const calls = Q.world.calls.total; for (let i = 0; i < 100; i++) Q.quotes.peek('eth', W);
  assert.equal(Q.world.calls.total, calls, 'fresh cache => no RPC');
  Q.clk.t += 1500; Q.world.ch('eth').down = true; // refresh will fail; stale value still served inside the stale window
  assert.ok(Q.quotes.peek('eth', W)); await tick(20); assert.ok(Q.quotes.peek('eth', W));
  Q.clk.t += 20000; assert.equal(Q.quotes.peek('eth', W), null, 'beyond the stale window nothing is invented');
});
test('quote: an on-chain reference pool below the minimum liquidity is ignored; Coinbase spot is the labelled fallback', async () => {
  const Q = quoteSetup('eth', makeFetch({ 'api.coinbase.com': { data: { amount: '2900' } } })), W = CHAIN_CONFIG.eth.native.wrapped;
  addRefPool(Q.world, 'eth', 3200, { liqUsd: 5000 });
  const q = await Q.quotes.get('eth', W); assert.equal(q.basis, 'coinbase_spot'); close(q.usd, 2900);
});
test('quote: no source at all => null', async () => {
  const Q = quoteSetup('robinhood', makeFetch({ 'api.coinbase.com': new Error('down') }));
  assert.equal(await Q.quotes.get('robinhood', CHAIN_CONFIG.robinhood.native.wrapped), null);
});

/* ================= upstream manager ================= */
function mkUp(over = {}) {
  FakeUpstreamWS.reset(); const timers = []; const logs = [], ups = [], downs = [], heads = [];
  const catalog = Object.fromEntries(Object.keys(CHAIN_CONFIG).map(k => [k, { supported: true, logs: true }]));
  const up = createUpstream({ WebSocketImpl: FakeUpstreamWS, apiKey: 'k', catalog, onLog: (c, l) => logs.push([c, l]), onUp: c => ups.push(c), onDown: c => downs.push(c), onHead: (c, h) => heads.push([c, h]),
    setTimeoutImpl: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; }, rand: () => 0.5, ...over });
  return { up, timers, logs, ups, downs, heads };
}
test('upstream: connects every supported chain, subscribes newHeads, pool logs with address+topic filter, routes logs by subscription id', () => {
  const U = mkUp(); U.up.start(); assert.equal(FakeUpstreamWS.instances.length, 6);
  const ws = FakeUpstreamWS.for('arb_mainnet'); ws.open(); const pool = addr(0x11);
  U.up.subscribeLogs('arb', pool, [TOPIC.v3Swap]); ws.ackAll();
  const sub = ws.sent.find(m => m.params[0] === 'logs');
  assert.deepEqual(sub.params[1], { address: pool, topics: [[TOPIC.v3Swap]] });
  assert.ok(ws.sent.find(m => m.params[0] === 'newHeads'));
  ws.pushLog(pool, { x: 1 }); assert.deepEqual(U.logs, [['arb', { x: 1 }]]);
  ws.emit('message', Buffer.from(JSON.stringify({ method: 'eth_subscription', params: { subscription: 'unknown', result: { y: 2 } } }))); assert.equal(U.logs.length, 1, 'logs of unknown subscriptions are dropped');
  ws.emit('message', Buffer.from('not json')); assert.equal(U.logs.length, 1);
});
test('upstream: reconnect with jittered backoff, every pool resubscribed, onDown/onUp fired', () => {
  const U = mkUp(); U.up.start(); const ws1 = FakeUpstreamWS.for('base_mainnet'); ws1.open(); U.up.subscribeLogs('base', addr(0x21), [TOPIC.v2Swap, TOPIC.v2Sync]); U.up.subscribeLogs('base', addr(0x22), [TOPIC.v3Swap]); ws1.ackAll();
  ws1.close(); assert.deepEqual(U.downs, ['base']); assert.equal(U.up.state.base.connected, false); assert.equal(U.up.state.base.reconnects, 1);
  const t = U.timers.pop(); assert.ok(t.ms >= 0 && t.ms <= 20000); const n = FakeUpstreamWS.instances.length; t.fn();
  assert.equal(FakeUpstreamWS.instances.length, n + 1); const ws2 = FakeUpstreamWS.instances.at(-1); ws2.open();
  assert.equal(ws2.sent.filter(m => m.params[0] === 'logs').length, 2, 'both pools resubscribed after reconnect'); assert.deepEqual(U.ups, ['base']);
  ws2.ackAll(); ws2.pushLog(addr(0x22), { z: 3 }); assert.equal(U.logs.at(-1)[1].z, 3);
  ws2.close(); const t2 = U.timers.pop(); assert.ok(t2.ms <= 20000); // repeated failures keep backing off, capped
});
test('upstream: unsubscribe sends eth_unsubscribe; chains without logs support are never subscribed; pool cap enforced', () => {
  const catalog = { ...Object.fromEntries(Object.keys(CHAIN_CONFIG).map(k => [k, { supported: true, logs: true }])), poly: { supported: true, logs: false } };
  const U = mkUp({ catalog, maxPoolsPerChain: 1 }); U.up.start(); const ws = FakeUpstreamWS.for('eth_mainnet'); ws.open();
  assert.equal(U.up.subscribeLogs('eth', addr(1), [TOPIC.v3Swap]), true); ws.ackAll(); assert.equal(U.up.subscribeLogs('eth', addr(2), [TOPIC.v3Swap]), false);
  U.up.unsubscribeLogs('eth', addr(1)); assert.ok(ws.sent.find(m => m.method === 'eth_unsubscribe'));
  assert.equal(U.up.subscribeLogs('poly', addr(3), [TOPIC.v3Swap]), false);
});
test('upstream: no API key or unsupported catalog entry => no connection attempt', () => {
  const U = mkUp({ apiKey: '' }); U.up.start(); assert.equal(FakeUpstreamWS.instances.length, 0);
});

/* ================= hub (browser-facing) ================= */
async function hubSetup(limits = {}) {
  const world = createWorld(); world.deployConfig('arb'); const metrics = createMetrics();
  const registry = createRegistry({ rpc: world.rpc, metrics }), quotes = createQuoteService({ registry, fetchImpl: makeFetch(), metrics });
  const upstream = { subscribeLogs() { return true; }, unsubscribeLogs() {} };
  const engine = createEngine({ rpc: world.rpc, registry, quotes, upstream, metrics, opts: { reconcileMs: 0, untrackGraceMs: 10 } });
  const hub = createHub({ engine, registry, metrics, limits: { flushMs: 1e9, ...limits } });
  const USDC = Object.keys(CHAIN_CONFIG.arb.stables)[0], pools = {};
  for (const [i, tk] of [LOW, HIGH, addr(0x2222)].entries()) { pools[tk] = addr(0x7000 + i); buildPool(world, 'arb', { protocolId: 'uniswap_v3', pool: pools[tk], token: tk, quote: USDC, price: 0.02 * (i + 1), quoteDec: 6, tokenBal: 3_000_000 }); }
  const sw = (tk, p, block) => v3SwapLog({ pool: pools[tk], block, logIndex: 1, amount0: 1n, amount1: 1n, sqrtP: 0n, ...{} });
  const swapFor = (tk, price, block) => { const t0 = tk < USDC; return v3SwapLog({ pool: pools[tk], block, logIndex: 1, ...(t0 ? { amount0: -(10n ** 18n), amount1: 20_000n, sqrtP: sqrtPFromHumanPrice(price, 18, 6) } : { amount1: -(10n ** 18n), amount0: 20_000n, sqrtP: sqrtPFromHumanPrice(1 / price, 6, 18) }) }); };
  const client = () => { const ws = new FakeBrowserWS(); hub.attach(ws); return ws; };
  return { world, metrics, engine, hub, client, swapFor, pools };
}
const sub = (ws, token, chain = 'arb') => ws.recv({ type: 'subscribe_token', chain, token });
test('hub: validates every inbound message and never accepts RPC URLs, methods or raw pool addresses', async () => {
  const H = await hubSetup(), ws = H.client();
  ws.recv('{bad'); ws.recv('[]'); ws.recv({ type: 5 }); ws.recv({ type: 'eth_call' }); ws.recv({ type: 'subscribe_token', chain: 'solana', token: LOW }); ws.recv({ type: 'subscribe_token', chain: 'arb', token: 'nope' });
  ws.recv({ type: 'subscribe_pool', chain: 'arb', address: addr(1) }); ws.recv({ type: 'subscribe_token', chain: 'arb', token: LOW, rpcUrl: 'http://evil' });
  await tick(30);
  assert.deepEqual(ws.of('evm_error').map(e => e.code), ['bad_json', 'bad_message', 'bad_message', 'unknown_type', 'unsupported_chain', 'bad_token', 'subscribe_pool_deprecated']);
  assert.equal(ws.of('evm_subscribed').length, 1, 'extra fields are ignored, only chain+token are used');
  H.engine.shutdown();
});
test('hub: only subscribed tokens are delivered; multiple tokens per client; no raw logs ever reach a browser', async () => {
  const H = await hubSetup(), A = H.client(), B = H.client();
  sub(A, LOW); sub(A, HIGH); sub(B, addr(0x2222)); await tick(40);
  assert.equal(A.of('evm_subscribed').length, 2); assert.deepEqual(A.of('evm_subscribed').map(m => m.status), ['live', 'live']);
  H.hub.flushAll(); A.out.length = 0; B.out.length = 0;
  H.engine.onLog('arb', H.swapFor(LOW, 0.021, 1500)); H.engine.onLog('arb', H.swapFor(HIGH, 0.045, 1501)); H.hub.flushAll();
  assert.deepEqual(A.of('evm_market').map(m => m.token).sort(), [HIGH, LOW].sort()); assert.equal(B.of('evm_market').length, 0);
  assert.ok(A.out.every(m => m.type === 'evm_market' || m.type.startsWith('evm_')) && !A.out.some(m => m.type === 'evm_pool_log' || m.topics));
  assert.ok(A.of('evm_market').every(m => typeof m.sentAt === 'number'));
  H.engine.shutdown();
});
test('hub: per-client token limit, rate limit, unsubscribe and disconnect cleanup', async () => {
  const H = await hubSetup({ maxTokensPerClient: 2, maxMsgPerWindow: 6 }), ws = H.client();
  sub(ws, LOW); sub(ws, HIGH); sub(ws, addr(0x2222)); await tick(30);
  assert.ok(ws.of('evm_error').some(e => e.code === 'too_many_tokens'));
  ws.recv({ type: 'unsubscribe_token', chain: 'arb', token: LOW }); H.hub.flushAll(); ws.out.length = 0;
  H.engine.onLog('arb', H.swapFor(LOW, 0.03, 1600)); H.hub.flushAll(); assert.equal(ws.of('evm_market').length, 0, 'unsubscribed token delivers nothing');
  for (let i = 0; i < 10; i++) ws.recv({ type: 'ping' }); assert.ok(ws.of('evm_error').some(e => e.code === 'rate_limited'));
  ws.emit('close'); await tick(40); assert.equal(H.engine.stats().subscribers, 0);
  H.engine.shutdown();
});
test('hub: bursts are coalesced to the latest value per token per flush', async () => {
  const H = await hubSetup(), ws = H.client(); sub(ws, LOW); await tick(40); H.hub.flushAll(); ws.out.length = 0;
  for (let i = 0; i < 25; i++) H.engine.onLog('arb', H.swapFor(LOW, 0.02 + i * 1e-4, 1700 + i));
  H.hub.flushAll(); const m = ws.of('evm_market'); assert.equal(m.length, 1); assert.equal(m[0].coalesced, 25); close(m[0].priceUsd, 0.02 + 24 * 1e-4, 1e-4);
  assert.equal(H.metrics.snapshot().counters.coalesced_updates, 24); H.engine.shutdown();
});
test('hub: backpressure drops updates for a congested client, then closes a consumer that stays slow', async () => {
  let t = 1e12; const H = await hubSetup({ softBufferBytes: 1000, hardBufferBytes: 1e6, slowCloseAfterMs: 5000 }), ws = H.client(); sub(ws, LOW); await tick(40); H.hub.flushAll();
  ws.out.length = 0; ws.bufferedAmount = 5000; H.engine.onLog('arb', H.swapFor(LOW, 0.05, 1800)); H.hub.flushAll();
  assert.equal(ws.of('evm_market').length, 0); assert.equal(H.metrics.snapshot().counters.client_backpressure_drops, 1);
  ws.bufferedAmount = 2e6; H.engine.onLog('arb', H.swapFor(LOW, 0.06, 1801)); H.hub.flushAll();
  assert.equal(ws.closed.code, 1013); assert.equal(H.metrics.snapshot().counters.client_slow_closed, 1);
  const ws2 = H.client(); sub(ws2, LOW); await tick(30); ws2.bufferedAmount = 0; H.engine.onLog('arb', H.swapFor(LOW, 0.07, 1802)); H.hub.flushAll(); assert.ok(ws2.of('evm_market').length >= 1, 'a healthy client recovers normally');
  H.engine.shutdown();
});
