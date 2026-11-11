/* OFFLINE engine tests: mocked RPC world, synthetic ABI-faithful logs. No network is used anywhere in this file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { createRegistry } from '../src/registry.js';
import { createQuoteService } from '../src/quote.js';
import { createMetrics } from '../src/metrics.js';
import { CHAIN_CONFIG } from '../src/chains.js';
import { SEL, lc } from '../src/abi.js';
import { createWorld, addr, buildPool, addRefPool, makeFetch, HIGH, LOW, v2SwapLog, v2SyncLog, v3SwapLog, pancakeV3SwapLog, v4SwapLog, asRemoved, sqrtPFromHumanPrice, tick } from './helpers.js';

const close = (a, b, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-18, `${a} !~ ${b}`);
const waitFor = async (fn, timeoutMs = 500) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 2)); }
  throw new Error('timed out waiting for asynchronous engine update');
};

function setup(chain, { opts = {}, fetchImpl = makeFetch(), clock = null } = {}) {
  const world = createWorld(); world.deployConfig(chain);
  const metrics = createMetrics(), now = clock ? () => clock.t : Date.now;
  const registry = createRegistry({ rpc: world.rpc, metrics, now });
  const quotes = createQuoteService({ registry, fetchImpl, now, metrics });
  const upstream = { subs: new Map(), subscribeLogs(c, a, t) { this.subs.set(c + ':' + a, t); return true; }, unsubscribeLogs(c, a) { this.subs.delete(c + ':' + a); } };
  const engine = createEngine({ rpc: world.rpc, registry, quotes, upstream, metrics, now, opts: { reconcileMs: 0, untrackGraceMs: 20, ...opts } });
  const msgs = []; const listener = m => msgs.push(m);
  const markets = () => msgs.filter(m => m.type === 'evm_market');
  return { world, metrics, registry, quotes, upstream, engine, msgs, markets, listener, fetchImpl, now };
}

/* ---------- A. every chain: discovery -> verified pool -> swap -> price -> USD -> FDV -> update ---------- */
const CASES = [
  { chain: 'eth', protocolId: 'uniswap_v3', quoteKind: 'native', token: LOW, swap: 'v3', refUsd: 3000 },
  { chain: 'bsc', protocolId: 'pancake_v3', quoteKind: 'native', token: HIGH, swap: 'pancake', refUsd: 600, stableDec: 18 },
  { chain: 'base', protocolId: 'uniswap_v2', quoteKind: 'native', token: LOW, swap: 'v2', refUsd: 3100 },
  { chain: 'arb', protocolId: 'uniswap_v3', quoteKind: 'stable', token: HIGH, swap: 'v3' },
  { chain: 'poly', protocolId: 'quickswap_v2', quoteKind: 'native', token: HIGH, swap: 'v2', refUsd: 0.5 },
  { chain: 'robinhood', protocolId: 'uniswap_v3', quoteKind: 'native', token: LOW, swap: 'v3', coinbase: 3050 }
];
for (const c of CASES) {
  test(`chain ${c.chain} (${CHAIN_CONFIG[c.chain].chainId}): ${c.protocolId} swap -> token USD price + FDV`, async () => {
    const cfg = CHAIN_CONFIG[c.chain];
    const fetchImpl = makeFetch(c.coinbase ? { 'api.coinbase.com': { data: { amount: String(c.coinbase) } } } : {});
    const S = setup(c.chain, { fetchImpl });
    const quote = c.quoteKind === 'stable' ? Object.keys(cfg.stables)[0] : cfg.native.wrapped;
    const quoteDec = c.quoteKind === 'stable' ? 6 : 18, pool = addr(0xabc0 + cfg.chainId);
    let quoteUsd = 1;
    if (c.quoteKind === 'native') { if (c.refUsd) addRefPool(S.world, c.chain, c.refUsd, { stableDec: c.stableDec || 6 }); quoteUsd = c.refUsd || c.coinbase; }
    const price = 0.0004; // quote per token
    const { tokenIs0 } = buildPool(S.world, c.chain, { protocolId: c.protocolId, pool, token: c.token, quote, price, quoteDec, tokenBal: 40_000_000, supply: 10n ** 18n * 1_000_000_000n });
    const r = await S.engine.track(c.chain, c.token, 's1', S.listener);
    assert.equal(r.status, 'live');
    assert.ok(S.upstream.subs.has(c.chain + ':' + pool), 'log subscription registered upstream for the verified pool only');
    const snap = S.markets()[0];
    assert.equal(snap.snapshot, true); assert.equal(snap.chainId, cfg.chainId);
    close(snap.priceQuote, price, 1e-6); close(snap.priceUsd, price * quoteUsd, 1e-5);
    assert.equal(snap.mcKind, 'fdv');
    // a buy that moves the price up 10%
    const newPrice = price * 1.1, rawTok = (n, d) => BigInt(Math.round(n)) * 10n ** BigInt(d);
    const prev = S.markets().length;
    if (c.swap === 'v2') {
      const rt = 40_000_000 / 1.1 ** 0.5 /* arbitrary new reserve */, rq = rt * newPrice;
      const r0 = tokenIs0 ? rawTok(rt, 18) : BigInt(Math.round(rq * 1e6)) * 10n ** BigInt(quoteDec) / 1_000_000n;
      const r1 = tokenIs0 ? BigInt(Math.round(rq * 1e6)) * 10n ** BigInt(quoteDec) / 1_000_000n : rawTok(rt, 18);
      S.engine.onLog(c.chain, v2SyncLog({ pool, block: 1002, logIndex: 4, r0, r1 }));
      const quoteIn = BigInt(Math.round(1e6 * 8)) * 10n ** BigInt(quoteDec) / 1_000_000n, tokOut = rawTok(1000, 18);
      S.engine.onLog(c.chain, v2SwapLog({ pool, block: 1002, logIndex: 5, tx: 7777, ...(tokenIs0 ? { a1in: quoteIn, a0out: tokOut } : { a0in: quoteIn, a1out: tokOut }) }));
    } else {
      const sqrtP = tokenIs0 ? sqrtPFromHumanPrice(newPrice, 18, quoteDec) : sqrtPFromHumanPrice(1 / newPrice, quoteDec, 18);
      const tokOut = rawTok(1000, 18), quoteIn = BigInt(Math.round(1e6 * 8)) * 10n ** BigInt(quoteDec) / 1_000_000n;
      const mk = c.swap === 'pancake' ? pancakeV3SwapLog : v3SwapLog;
      S.engine.onLog(c.chain, mk({ pool, block: 1002, logIndex: 5, tx: 7777, sqrtP, ...(tokenIs0 ? { amount0: -tokOut, amount1: quoteIn } : { amount1: -tokOut, amount0: quoteIn }) }));
    }
    await waitFor(() => S.markets().some(m => m.trigger === 'metadata' && m.fdvUsd != null));
    const upd = S.markets().slice(prev), last = upd.find(m => m.trigger === 'swap');
    assert.ok(last);
    assert.equal(last.trade.side, 'buy'); close(last.trade.tokenAmount, 1000); close(last.trade.quoteAmount, 8);
    close(last.priceQuote, newPrice, 1e-5); close(last.priceUsd, newPrice * quoteUsd, 1e-5);
    const enriched = S.markets().at(-1);
    close(enriched.fdvUsd, newPrice * quoteUsd * 1e9, 1e-5);
    assert.equal(last.circulatingMarketCapUsd, null); assert.equal(last.circulatingStatus, 'unavailable');
    assert.ok(last.timing.decodeMs >= 0 && last.timing.serverMs >= 0);
    assert.equal(last.block.number, 1002);
    S.engine.shutdown();
  });
}
test('Robinhood Chain: the only quote USD source is the labelled Coinbase spot (no stable configured), and it is cached across swaps', async () => {
  const fetchImpl = makeFetch({ 'api.coinbase.com': { data: { amount: '3000' } } });
  const S = setup('robinhood', { fetchImpl });
  const pool = addr(0xa1), W = CHAIN_CONFIG.robinhood.native.wrapped;
  buildPool(S.world, 'robinhood', { protocolId: 'uniswap_v3', pool, token: LOW, quote: W, price: 0.001, tokenBal: 5_000_000 });
  await S.engine.track('robinhood', LOW, 's1', S.listener);
  const snap = S.markets()[0]; assert.equal(snap.quoteUsdBasis, 'coinbase_spot'); close(snap.priceUsd, 3);
  for (let i = 0; i < 50; i++) S.engine.onLog('robinhood', v3SwapLog({ pool, block: 1100 + i, amount0: -(10n ** 18n), amount1: 1n * 10n ** 15n, sqrtP: sqrtPFromHumanPrice(0.001 + i * 1e-6, 18, 18) }));
  assert.equal(fetchImpl.calls.length, 1, '50 swaps must not trigger 50 quote requests');
  S.engine.shutdown();
});

/* ---------- B. orientation + decimals through the whole pipeline (USDC 6d quote) ---------- */
for (const [name, token] of [['token is token0', LOW], ['token is token1', HIGH]]) {
  test(`orientation/decimals: ${name}, 6-decimal stable quote, V2 and V3 agree`, async () => {
    const S = setup('arb'), USDC = Object.keys(CHAIN_CONFIG.arb.stables)[0];
    buildPool(S.world, 'arb', { protocolId: 'uniswap_v2', pool: addr(0xb1), token, quote: USDC, price: 0.02, quoteDec: 6, tokenBal: 3_000_000 });
    await S.engine.track('arb', token, 's1', S.listener);
    close(S.markets()[0].priceUsd, 0.02, 1e-6);
    const S2 = setup('arb');
    buildPool(S2.world, 'arb', { protocolId: 'uniswap_v3', pool: addr(0xb2), token, quote: USDC, price: 0.02, quoteDec: 6, tokenBal: 3_000_000 });
    await S2.engine.track('arb', token, 's1', S2.listener);
    close(S2.markets()[0].priceUsd, 0.02, 1e-6);
    S.engine.shutdown(); S2.engine.shutdown();
  });
}

/* ---------- C. multiple pools per token ---------- */
test('multiple pools: primary = deepest verified pool; shallow and mismatched pools are rejected; secondary swaps do not move the token price', async () => {
  const S = setup('eth'), W = CHAIN_CONFIG.eth.native.wrapped, USDC = Object.keys(CHAIN_CONFIG.eth.stables)[0];
  addRefPool(S.world, 'eth', 3000);
  const deep = addr(0xc1), mid = addr(0xc2), dust = addr(0xc3);
  buildPool(S.world, 'eth', { protocolId: 'uniswap_v3', pool: deep, token: LOW, quote: USDC, price: 0.05, quoteDec: 6, tokenBal: 20_000_000, quoteBal: 1_000_000 });
  buildPool(S.world, 'eth', { protocolId: 'uniswap_v2', pool: mid, token: LOW, quote: W, price: 0.0000165, tokenBal: 3_000_000, quoteBal: 49.5 }); // ~$148k of ETH
  buildPool(S.world, 'eth', { protocolId: 'uniswap_v2', pool: dust, token: LOW, quote: USDC, price: 0.05, quoteDec: 6, tokenBal: 4000, quoteBal: 200 }); // $400 TVL < $1000 floor
  const r = await S.engine.track('eth', LOW, 's1', S.listener); assert.equal(r.status, 'live');
  const m = S.markets()[0];
  assert.equal(m.primaryPool.address, deep); assert.equal(m.pools.length, 2);
  assert.equal(S.metrics.snapshot().counters.pool_rejected_low_liquidity, 1);
  // swap in the secondary (V2) pool at a different price: pool list changes, token price (primary pool) must not
  const before = S.markets().length;
  S.engine.onLog('eth', v2SyncLog({ pool: mid, block: 1010, logIndex: 1, r0: 1n, r1: 1n })); // junk tiny reserves: price computed but pool is secondary
  const after = S.markets().slice(before).pop();
  assert.equal(after.primaryPool.address, deep); close(after.priceUsd, 0.05, 1e-6);
  S.engine.shutdown();
});
test('pool verification: a factory answer whose pool reports different token0/token1 is rejected', async () => {
  const S = setup('eth'), USDC = Object.keys(CHAIN_CONFIG.eth.stables)[0], liar = addr(0xd1);
  buildPool(S.world, 'eth', { protocolId: 'uniswap_v2', pool: liar, token: LOW, quote: USDC, price: 0.05, quoteDec: 6, tokenBal: 3_000_000 });
  // corrupt the pool so it claims a different pair than the factory registered
  S.world.ch('eth').pools.get(liar).t0 = addr(0x777);
  const r = await S.engine.track('eth', LOW, 's1', S.listener);
  assert.equal(r.status, 'no_pools'); assert.equal(S.metrics.snapshot().counters.pool_rejected_pair_mismatch, 1);
  S.engine.shutdown();
});
test('pool verification: empty pools (zero reserves / zero V3 liquidity) are unusable', async () => {
  const S = setup('eth'), USDC = Object.keys(CHAIN_CONFIG.eth.stables)[0];
  buildPool(S.world, 'eth', { protocolId: 'uniswap_v3', pool: addr(0xe1), token: LOW, quote: USDC, price: 0.05, quoteDec: 6 });
  S.world.ch('eth').pools.get(addr(0xe1)).liquidity = 0n;
  assert.equal((await S.engine.track('eth', LOW, 's1', S.listener)).status, 'no_pools');
  S.engine.shutdown();
});
test('a quote token that cannot be priced rejects the pool (no unverified USD value is ever produced)', async () => {
  const S = setup('robinhood', { fetchImpl: makeFetch({}) }); // Coinbase answers 404; no stables on this chain
  buildPool(S.world, 'robinhood', { protocolId: 'uniswap_v3', pool: addr(0xf1), token: LOW, quote: CHAIN_CONFIG.robinhood.native.wrapped, price: 0.001 });
  const r = await S.engine.track('robinhood', LOW, 's1', S.listener);
  assert.equal(r.status, 'no_pools'); assert.equal(S.metrics.snapshot().counters.pool_rejected_quote_unpriced, 1);
  S.engine.shutdown();
});

/* ---------- D. dedupe, malformed, unknown pools, ordering ---------- */
async function liveV3(chain = 'arb', S = setup(chain)) {
  const USDC = Object.keys(CHAIN_CONFIG[chain].stables)[0], pool = addr(0x5001);
  buildPool(S.world, chain, { protocolId: 'uniswap_v3', pool, token: LOW, quote: USDC, price: 0.02, quoteDec: 6, tokenBal: 3_000_000 });
  await S.engine.track(chain, LOW, 's1', S.listener);
  const sw = (block, p, extra = {}) => v3SwapLog({ pool, block, logIndex: 1, amount0: -(10n ** 18n), amount1: 20_000n, sqrtP: sqrtPFromHumanPrice(p, 18, 6), ...extra });
  return { S, pool, sw, chain };
}
test('dedupe: the same log delivered twice yields exactly one update', async () => {
  const { S, sw } = await liveV3(); const n = S.markets().length, l = sw(1005, 0.021);
  S.engine.onLog('arb', l); S.engine.onLog('arb', { ...l }); S.engine.onLog('arb', JSON.parse(JSON.stringify(l)));
  assert.equal(S.markets().length, n + 1); assert.equal(S.metrics.snapshot().counters.logs_duplicate, 2);
  S.engine.shutdown();
});
test('malformed / foreign logs never throw and never publish', async () => {
  const { S, pool, sw } = await liveV3(); const n = S.markets().length;
  const good = sw(1006, 0.022);
  for (const bad of [null, undefined, 5, {}, { ...good, data: '0x12' }, { ...good, topics: [] }, { ...good, logIndex: 'zz' }, { ...good, blockHash: '0xabc' }, { ...good, address: addr(0x9999) }, { ...good, topics: [good.topics[0]] }, { ...good, data: good.data.replace(/^0x(.{128})(.{64})/, '0x$1' + '0'.repeat(64)) }])
    assert.doesNotThrow(() => S.engine.onLog('arb', bad));
  assert.equal(S.markets().length, n);
  const c = S.metrics.snapshot().counters; assert.ok(c.logs_malformed >= 6); assert.ok(c.logs_unknown_pool >= 1);
  S.engine.shutdown();
});
test('out-of-order (older) event does not move the price backwards', async () => {
  const { S, sw } = await liveV3();
  S.engine.onLog('arb', sw(1020, 0.03)); const n = S.markets().length;
  S.engine.onLog('arb', sw(1019, 0.01, { tx: 4242 })); // older block, different tx => not a duplicate, but late
  assert.equal(S.markets().length, n); assert.equal(S.metrics.snapshot().counters.logs_late, 1);
  close(S.markets().pop().priceUsd, 0.03);
  S.engine.shutdown();
});

/* ---------- E. reorgs ---------- */
test('reorg: removed log reverts to the previous canonical price; the replacement block then applies', async () => {
  const { S, sw } = await liveV3();
  const a = sw(2001, 0.021), b = sw(2002, 0.025, { blockHash: 902 });
  S.engine.onLog('arb', a); S.engine.onLog('arb', b); close(S.markets().pop().priceUsd, 0.025);
  S.engine.onLog('arb', asRemoved(b));
  const rv = S.markets().pop(); assert.equal(rv.reorg, true); assert.equal(rv.trigger, 'reorg'); close(rv.priceUsd, 0.021);
  S.engine.onLog('arb', sw(2002, 0.0235, { blockHash: 903, tx: 9090 }));
  close(S.markets().pop().priceUsd, 0.0235);
  assert.equal(S.metrics.snapshot().counters.reorgs, 1);
  // the removed log may be re-delivered later on the new canonical chain: it must not be swallowed by the dedupe cache
  S.engine.onLog('arb', sw(2003, 0.0236, { blockHash: 902 }));
  S.engine.shutdown();
});
test('reorg deeper than the history ring falls back to an on-chain state re-read', async () => {
  const S = setup('arb', { opts: { historySize: 2 } }), { world } = S;
  const { sw, pool } = await liveV3('arb', S);
  S.engine.onLog('arb', sw(3001, 0.021)); S.engine.onLog('arb', sw(3002, 0.022, { blockHash: 31 }));
  world.setV3Price('arb', pool, sqrtPFromHumanPrice(0.0205, 18, 6)); // canonical chain state after the reorg
  S.engine.onLog('arb', asRemoved(sw(3001, 0.021))); S.engine.onLog('arb', asRemoved(sw(3002, 0.022, { blockHash: 31 })));
  await tick(30);
  close(S.markets().pop().priceUsd, 0.0205, 1e-5);
  S.engine.shutdown();
});


test('fast first snapshot: delayed historical backfill does not block track; live price is published before recovery finishes', async () => {
  const S = setup('arb'), USDC = Object.keys(CHAIN_CONFIG.arb.stables)[0], pool = addr(0x6f01);
  buildPool(S.world, 'arb', { protocolId: 'uniswap_v3', pool, token: LOW, quote: USDC, price: 0.25, quoteDec: 6, tokenBal: 2_000_000 });
  const originalGetLogs = S.world.rpc.getLogs.bind(S.world.rpc);
  let release, enteredResolve;
  const entered = new Promise(r => { enteredResolve = r; });
  const gate = new Promise(r => { release = r; });
  S.world.rpc.getLogs = async (...args) => { enteredResolve(); await gate; return originalGetLogs(...args); };

  const result = await S.engine.track('arb', LOW, 's1', S.listener);
  assert.equal(result.status, 'live');
  const first = S.markets().find(m => m.snapshot);
  assert.ok(first, 'initial snapshot is available before getLogs resolves');
  close(first.priceUsd, 0.25);
  await entered;
  assert.equal(S.markets().filter(m => m.snapshot).length, 1);
  release();
  await new Promise(r => setTimeout(r, 10));
  S.engine.shutdown();
});

/* ---------- F. supply: FDV vs circulating ---------- */
test('FDV uses totalSupply scaled by token decimals; circulating market cap is reported unavailable (never FDV relabelled)', async () => {
  const S = setup('arb'), USDC = Object.keys(CHAIN_CONFIG.arb.stables)[0];
  buildPool(S.world, 'arb', { protocolId: 'uniswap_v3', pool: addr(0x6001), token: LOW, quote: USDC, price: 0.5, quoteDec: 6, tokenDec: 6, tokenBal: 1_000_000, supply: 21_000_000n * 10n ** 6n });
  await S.engine.track('arb', LOW, 's1', S.listener); const m = await waitFor(() => S.markets().find(x => x.totalSupply != null));
  assert.equal(m.totalSupply, 21_000_000); close(m.fdvUsd, 10_500_000);
  assert.equal(m.mcKind, 'fdv'); assert.equal(m.circulatingMarketCapUsd, null); assert.equal(m.circulatingSupply, null); assert.equal(m.circulatingStatus, 'unavailable');
  assert.ok(!('marketCapUsd' in m), 'no field may present FDV as "market cap"');
  S.engine.shutdown();
});
test('unreadable total supply: price still published, FDV is null (not guessed)', async () => {
  const S = setup('arb'), USDC = Object.keys(CHAIN_CONFIG.arb.stables)[0];
  buildPool(S.world, 'arb', { protocolId: 'uniswap_v3', pool: addr(0x6101), token: LOW, quote: USDC, price: 0.5, quoteDec: 6, tokenBal: 1_000_000 });
  S.world.ch('arb').erc20.get(LOW).supply = 0n; // totalSupply() == 0 is treated as unreadable
  await S.engine.track('arb', LOW, 's1', S.listener); const m = await waitFor(() => S.markets().find(x => x.trigger === 'metadata'));
  close(m.priceUsd, 0.5); assert.equal(m.fdvUsd, null); assert.equal(m.totalSupply, null);
  S.engine.shutdown();
});

/* ---------- G. caches, reuse, bounded memory ---------- */
test('subscription reuse: a second subscriber costs zero RPC and gets the cached snapshot instantly', async () => {
  const { S } = await liveV3(); const calls = S.world.calls.total, m2 = [];
  const r = await S.engine.track('arb', LOW, 's2', m => m2.push(m));
  assert.equal(r.status, 'live'); assert.equal(m2[0].snapshot, true); assert.equal(S.world.calls.total, calls);
  assert.equal(S.engine.stats().tokens, 1); assert.equal(S.engine.stats().subscribers, 2);
  S.engine.shutdown();
});
test('total supply is read once, not once per swap; decimals are cached', async () => {
  const { S, sw } = await liveV3(); const sup0 = S.world.calls.sel[SEL.totalSupply];
  for (let i = 0; i < 40; i++) S.engine.onLog('arb', sw(4000 + i, 0.02 + i * 1e-5));
  assert.equal(S.world.calls.sel[SEL.totalSupply], sup0); assert.equal(S.world.calls.sel[SEL.decimals], 2); // token + quote, once each
  S.engine.shutdown();
});
test('discovery cache: re-tracking after the grace period skips discovery but re-reads live pool state', async () => {
  const { S, pool } = await liveV3(); const found0 = S.world.calls.sel[SEL.getPool];
  S.engine.untrack('arb', LOW, 's1'); await tick(60);
  assert.equal(S.engine.stats().tokens, 0); assert.equal(S.upstream.subs.size, 0, 'upstream log subscription released');
  S.world.setV3Price('arb', pool, sqrtPFromHumanPrice(0.04, 18, 6)); // price moved while nobody was watching
  const m2 = []; await S.engine.track('arb', LOW, 's9', m => m2.push(m));
  assert.equal(S.world.calls.sel[SEL.getPool], found0, 'factory lookups not repeated'); assert.equal(S.metrics.snapshot().counters.discovery_cache_hits, 1);
  close(m2.find(m => m.type === 'evm_market').priceUsd, 0.04, 1e-5); // stale cached state must never be served
  S.engine.shutdown();
});
test('two subscribers share one pool subscription; it is released only when the last leaves', async () => {
  const { S } = await liveV3(); await S.engine.track('arb', LOW, 's2', () => {});
  S.engine.untrack('arb', LOW, 's1'); await tick(60); assert.equal(S.engine.stats().tokens, 1); assert.equal(S.upstream.subs.size, 1);
  S.engine.untrack('arb', LOW, 's2'); await tick(60); assert.equal(S.engine.stats().tokens, 0); assert.equal(S.upstream.subs.size, 0);
  S.engine.shutdown();
});
test('bounded memory: token capacity, dedupe LRU and history ring are capped', async () => {
  const S = setup('arb', { opts: { maxTokens: 1, seenSize: 5, historySize: 3 } });
  const { sw } = await liveV3('arb', S);
  assert.deepEqual(await S.engine.track('arb', HIGH, 'x', () => {}), { status: 'error', reason: 'capacity' });
  for (let i = 0; i < 20; i++) S.engine.onLog('arb', sw(5000 + i, 0.02 + i * 1e-5));
  assert.ok(S.engine._seen.size <= 5); const tp = [...S.engine._tokens.values()][0].pools[0]; assert.ok(tp.history.length <= 3);
  S.engine.shutdown();
});
test('no pool / invalid token: clear status, then discovery is retried after the negative TTL', async () => {
  const clk = { t: 1e12 }, S = setup('arb', { clock: clk, opts: { noPoolTtlMs: 1000 } });
  const r = await S.engine.track('arb', LOW, 's1', S.listener); assert.equal(r.status, 'no_pools');
  assert.equal(S.msgs.find(m => m.type === 'evm_token_status').status, 'no_pools');
  const USDC = Object.keys(CHAIN_CONFIG.arb.stables)[0];
  buildPool(S.world, 'arb', { protocolId: 'uniswap_v3', pool: addr(0x7001), token: LOW, quote: USDC, price: 0.02, quoteDec: 6, tokenBal: 3_000_000 });
  clk.t += 1500; const r2 = await S.engine.track('arb', LOW, 's1', S.listener); assert.equal(r2.status, 'live');
  assert.equal((await S.engine.track('arb', 'nonsense', 's1', S.listener)).status, 'error');
  S.engine.shutdown();
});

/* ---------- H. missing-event recovery / reconcile ---------- */
test('missing-event recovery: after an upstream reconnect the gap is back-filled from eth_getLogs (deduped against live events)', async () => {
  const { S, sw, pool } = await liveV3(); const { world } = S;
  const l1 = sw(1010, 0.021), l2 = sw(1011, 0.023, { tx: 5501 }), l3 = sw(1012, 0.026, { tx: 5502 });
  S.engine.onLog('arb', l1); world.pushLog('arb', l1); world.pushLog('arb', l2); world.pushLog('arb', l3); // l2,l3 happened while the socket was down
  world.ch('arb').block = 1013; world.setV3Price('arb', pool, sqrtPFromHumanPrice(0.026, 18, 6));
  const n = S.markets().length; await S.engine.onUpstreamUp('arb');
  close(S.markets().pop().priceUsd, 0.026, 1e-5); assert.equal(S.metrics.snapshot().counters.backfilled_logs >= 3, true);
  assert.equal(S.markets().length, n + 1, 'one recovery update, not one per replayed log');
  S.engine.onLog('arb', l3); assert.equal(S.metrics.snapshot().counters.logs_duplicate >= 1, true); // late live delivery of a replayed log is a duplicate
  S.engine.shutdown();
});
test('missing-event recovery: a gap larger than the backfill window, or a failing getLogs, falls back to an on-chain state read', async () => {
  const S = setup('arb', { opts: { maxBackfillBlocks: 5 } }); const { sw, pool } = await liveV3('arb', S), { world } = S;
  S.engine.onLog('arb', sw(1010, 0.021));
  world.ch('arb').block = 5000; world.setV3Price('arb', pool, sqrtPFromHumanPrice(0.031, 18, 6));
  await S.engine.onUpstreamUp('arb'); close(S.markets().pop().priceUsd, 0.031, 1e-5); assert.equal(S.metrics.snapshot().counters.recover_large_gap, 1);
  const S2 = setup('arb'); const t2 = await liveV3('arb', S2); t2.S.engine.onLog('arb', t2.sw(1010, 0.021));
  S2.world.ch('arb').failGetLogs = true; S2.world.ch('arb').block = 1015; S2.world.setV3Price('arb', t2.pool, sqrtPFromHumanPrice(0.033, 18, 6));
  await S2.engine.onUpstreamUp('arb'); close(S2.markets().pop().priceUsd, 0.033, 1e-5);
  S.engine.shutdown(); S2.engine.shutdown();
});
test('upstream down -> subscribers are told the token is degraded (clients fall back to HTTP)', async () => {
  const { S } = await liveV3(); S.engine.onUpstreamDown('arb');
  assert.equal(S.msgs.filter(m => m.type === 'evm_token_status').pop().status, 'degraded'); S.engine.shutdown();
});
test('periodic reconcile detects silent drift (a missed event) and republishes the corrected price', async () => {
  const { S, pool } = await liveV3(); await waitFor(() => S.markets().some(m => m.trigger === 'metadata')); S.world.setV3Price('arb', pool, sqrtPFromHumanPrice(0.0275, 18, 6));
  await S.engine.reconcileAll(); const m = S.markets().pop();
  assert.equal(m.trigger, 'reconcile'); close(m.priceUsd, 0.0275, 1e-5); assert.equal(S.metrics.snapshot().counters.reconcile_drift, 1);
  const n = S.markets().length; await S.engine.reconcileAll(); assert.equal(S.markets().length, n, 'no republish when nothing drifted');
  S.engine.shutdown();
});
test('RPC economy: discovery costs a small, fixed number of HTTP requests and swaps cost zero', async () => {
  const { S, sw } = await liveV3(); const total = S.world.calls.total, batches = S.world.calls.batches;
  for (let i = 0; i < 100; i++) S.engine.onLog('arb', sw(6000 + i, 0.02 + i * 1e-6));
  assert.equal(S.world.calls.total, total, '100 swaps => 0 additional RPC calls');
  assert.ok(batches <= 12, 'discovery used batched requests (' + batches + ')');
  S.engine.shutdown();
});

test('Robinhood Uniswap V4: Initialize discovery -> StateView snapshot -> PoolManager Swap -> live USD price and FDV', async () => {
  const fetchImpl = makeFetch({ 'api.coinbase.com': { data: { amount: '3000' } } });
  const S = setup('robinhood', { fetchImpl });
  const cfg = CHAIN_CONFIG.robinhood, manager = cfg.protocols.find(p => p.id === 'uniswap_v4').manager;
  const poolId = '0x' + 'ab'.repeat(32), initialPrice = 0.001;
  S.world.token('robinhood', LOW, { decimals: 18, supply: 10n ** 27n });
  // V4 uses native ETH (address zero) as currency0; token is currency1.
  S.world.v4Pool('robinhood', poolId, LOW, '0x' + '0'.repeat(40), sqrtPFromHumanPrice(1 / initialPrice, 18, 18), 10n ** 20n);
  const r = await S.engine.track('robinhood', LOW, 'v4-s1', S.listener);
  assert.equal(r.status, 'live');
  const snap = S.markets()[0];
  close(snap.priceQuote, initialPrice, 1e-6); close(snap.priceUsd, initialPrice * 3000, 1e-5);
  assert.equal(snap.primaryPool.protocol, 'uniswap_v4'); assert.equal(snap.primaryPool.poolId, poolId);
  assert.equal(snap.liquidityUsd, null, 'V4 active liquidity is not misreported as TVL');
  const nextPrice = 0.008, prev = S.markets().length;
  S.engine.onLog('robinhood', v4SwapLog({ manager, poolId, block: 1002, logIndex: 1, amount0: 8n * 10n ** 18n, amount1: -(1000n * 10n ** 18n), sqrtP: sqrtPFromHumanPrice(1 / nextPrice, 18, 18) }));
  const update = S.markets().slice(prev).find(m => m.trigger === 'swap');
  assert.equal(update.trigger, 'swap'); assert.equal(update.trade.side, 'buy');
  close(update.priceQuote, nextPrice, 1e-6); close(update.priceUsd, nextPrice * 3000, 1e-5);
  await waitFor(() => S.markets().some(m => m.fdvUsd != null)); close(S.markets().at(-1).fdvUsd, nextPrice * 3000 * 1e9, 1e-5);
  S.engine.shutdown();
});
