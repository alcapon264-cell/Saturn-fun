/* MarketEngine: blockchain log -> protocol decoder -> pool state -> quote USD -> FDV -> token market update.
 *
 * Transport-agnostic and dependency-injected (rpc, registry, quotes, upstream, clock) so every behaviour is unit-testable offline.
 * Memory is bounded everywhere: tracked tokens, pools per token, per-pool history ring, dedupe LRU, pre-ready event queue. */
import { CHAIN_CONFIG, quoteAssets } from './chains.js';
import { lc, isAddr, HASH_RE, SEL, encodeCall } from './abi.js';
import { handlerFor } from './protocols.js';
import { LRU } from './registry.js';

const perf = () => (globalThis.performance ? performance.now() : Date.now());
const posGt = (a, b) => !b || a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

export function createEngine({ rpc, registry, quotes, upstream, metrics, now = Date.now, log = () => {}, opts = {} } = {}) {
  const O = {
    maxTokens: 500, maxPoolsPerToken: 4, minPoolTvlUsd: 1000, historySize: 64, seenSize: 50000, preReadyMax: 500,
    maxBackfillBlocks: 2000, reconcileMs: 120000, untrackGraceMs: 30000, discoveryTtlMs: 1800000, noPoolTtlMs: 60000, supplyTtlMs: 600000, ...opts
  };
  const tokens = new Map();         // chain:token -> TokenRec
  const poolIndex = new Map();      // chain:pool  -> Set<TokenPool>
  const seen = new LRU(O.seenSize); // chain:blockHash:txHash:logIndex
  const discoveryCache = new LRU(2000); // chain:token -> {at, pools:[verified pool metadata]}  (positive and negative results)
  const timers = new Set();
  let reconcileTimer = null;

  const tkey = (c, t) => c + ':' + lc(t);
  const pkey = (c, p) => c + ':' + lc(p);

  /* ---------------- subscription lifecycle ---------------- */
  function track(chain, token, subscriberId, listener) {
    const cfg = CHAIN_CONFIG[chain];
    if (!cfg || !isAddr(token)) return Promise.resolve({ status: 'error', reason: 'bad_params' });
    const k = tkey(chain, token);
    let rec = tokens.get(k);
    if (!rec) {
      if (tokens.size >= O.maxTokens) { metrics?.inc('track_rejected_capacity'); return Promise.resolve({ status: 'error', reason: 'capacity' }); }
      rec = { key: k, chain, token: lc(token), subs: new Map(), pools: [], primary: null, status: 'discovering', seq: 0, last: null, supply: null, ready: null, dropTimer: null, discoveredAt: 0 };
      tokens.set(k, rec);
      rec.ready = startDiscovery(rec);
    }
    if (rec.dropTimer) { clearTimeout(rec.dropTimer); timers.delete(rec.dropTimer); rec.dropTimer = null; }
    if ((rec.status === 'no_pools' || rec.status === 'error') && now() - (rec.statusAt || 0) > O.noPoolTtlMs) { rec.status = 'discovering'; rec.ready = startDiscovery(rec); }
    rec.subs.set(subscriberId, listener);
    // Reuse: a late subscriber to an already-live token gets the cached snapshot immediately, with zero extra RPC.
    if (rec.status === 'live' && rec.last) { try { listener({ ...rec.last, snapshot: true, trigger: 'snapshot' }); } catch {} }
    return rec.ready.then(() => ({ status: rec.status, reason: rec.reason || null }));
  }
  function untrack(chain, token, subscriberId) {
    const rec = tokens.get(tkey(chain, token)); if (!rec) return;
    rec.subs.delete(subscriberId);
    if (rec.subs.size || rec.dropTimer) return;
    rec.dropTimer = setTimeout(() => { timers.delete(rec.dropTimer); rec.dropTimer = null; if (!rec.subs.size) dropToken(rec); }, O.untrackGraceMs);
    rec.dropTimer.unref?.(); timers.add(rec.dropTimer);
  }
  function dropToken(rec) {
    tokens.delete(rec.key);
    for (const tp of rec.pools) {
      const set = poolIndex.get(pkey(rec.chain, tp.address));
      if (set) { set.delete(tp); if (!set.size) { poolIndex.delete(pkey(rec.chain, tp.address)); upstream.unsubscribeLogs(rec.chain, tp.address); } }
    }
    rec.pools = []; metrics?.inc('tokens_dropped');
  }
  const emit = (rec, msg) => { rec.last = msg; for (const [id, fn] of rec.subs) { try { fn(msg); } catch (e) { metrics?.inc('listener_errors'); } } };
  const emitStatus = (rec, status, reason = null) => { rec.status = status; rec.reason = reason; rec.statusAt = now(); for (const fn of rec.subs.values()) { try { fn({ type: 'evm_token_status', v: 1, chain: rec.chain, chainId: CHAIN_CONFIG[rec.chain].chainId, token: rec.token, status, reason }); } catch {} } };

  /* ---------------- discovery ---------------- */
  async function startDiscovery(rec) {
    const t0 = perf();
    try {
      // Read the block FIRST: every state read below is at or after it, so backfilling from it can never leave a gap.
      const startBlock = await rpc.blockNumber(rec.chain).catch(() => null);
      const cached = discoveryCache.get(rec.key);
      let pools, fromCache = false;
      if (cached && now() - cached.at < (cached.pools.length ? O.discoveryTtlMs : O.noPoolTtlMs)) { pools = cached.pools; fromCache = true; metrics?.inc('discovery_cache_hits'); }
      else { pools = await discoverPools(rec); discoveryCache.set(rec.key, { at: now(), pools }); }
      if (!tokens.has(rec.key)) return;
      if (!pools.length) { emitStatus(rec, 'no_pools', 'no_verified_pool'); return; }
      rec.pools = pools.slice(0, O.maxPoolsPerToken).map(p => makeTokenPool(rec, p, startBlock));
      // Cached pool metadata is factory-verified, but its state can be stale. Refresh cached
      // state before publishing; the expensive historical log recovery remains asynchronous.
      if (fromCache) await Promise.all(rec.pools.map(tp => resync(tp, 'discovery', { silent: true }).catch(() => false)));
      // Subscribe immediately after verified discovery.
      for (const tp of rec.pools) {
        const k = pkey(rec.chain, tp.address); let set = poolIndex.get(k);
        if (!set) { set = new Set(); poolIndex.set(k, set); }
        set.add(tp);
        if (set.size === 1) upstream.subscribeLogs(rec.chain, tp.address, handlerFor(tp.protocol).topics);
      }
      // Start accepting live events before historical recovery. The pre-ready queue is replayed
      // in arrival order; recoverPool's block/log position checks prevent older backfill from
      // overwriting newer live state.
      for (const tp of rec.pools) { tp.ready = true; for (const q of tp.pre.splice(0)) processLog(rec.chain, q.log, q.recvAt, q.recvPerf, { silent: true }); }
      rec.discoveredAt = now(); rec.status = 'live'; rec.reason = null;

      // Start the supply read before publish(): publish() also requests a refresh, and the
      // single-flight guard must attach to this same in-flight read rather than suppress it.
      const supplyTask = Promise.resolve(refreshSupply(rec, true)).then(() => {
        if (tokens.has(rec.key) && rec.status === 'live') publish(rec, 'metadata', {});
      });
      publish(rec, 'snapshot', {});
      metrics?.observe('discovery_ms', perf() - t0);

      // Supply/FDV and history recovery are deliberately non-blocking.
      const recoveryTasks = rec.pools.map(async tp => {
        const before = tp.lastPos && tp.lastPos.join(':');
        await recoverPool(tp, { silent: true });
        return before !== (tp.lastPos && tp.lastPos.join(':'));
      });
      Promise.allSettled([supplyTask, ...recoveryTasks]).then(results => {
        const recovered = results.slice(1).some(r => r.status === 'fulfilled' && r.value);
        if (recovered && tokens.has(rec.key) && rec.status === 'live') publish(rec, 'recovered', {});
      });
    } catch (e) {
      log('discovery_failed', rec.key, e && e.message);
      metrics?.inc('discovery_errors');
      if (tokens.has(rec.key)) emitStatus(rec, 'error', String(e && e.message || 'discovery_failed').slice(0, 60));
    }
  }
  async function discoverPools(rec) {
    const cfg = CHAIN_CONFIG[rec.chain];
    try { await registry.decimalsOf(rec.chain, rec.token); } catch { return []; }   // not an ERC-20 we can read
    const qs = quoteAssets(cfg).filter(q => q.address !== rec.token);
    const found = (await Promise.all(qs.map(q => registry.findPools(rec.chain, rec.token, q.address).catch(e => { if (String(e.message).startsWith('chain_unavailable')) throw e; return []; })))).flat();
    const pricedResults = await Promise.all(found.map(async p => {
      const q = await quotes.get(rec.chain, p.quote);
      if (!q) { metrics?.inc('pool_rejected_quote_unpriced'); return null; }
      const tvlUsd = p.tvlQuote == null ? null : p.tvlQuote * q.usd;
      // V4 StateView exposes active liquidity, not per-pool token balances; never fabricate a TVL.
      if (p.family !== 'v4' && !(tvlUsd >= O.minPoolTvlUsd)) { metrics?.inc('pool_rejected_low_liquidity'); return null; }
      if (p.family === 'v4' && !(p.activeLiquidity > 0n)) return null;
      return { ...p, tvlUsd, tvlAt: tvlUsd == null ? null : now() };
    }));
    const priced = pricedResults.filter(Boolean);
    priced.sort((a, b) => b.tvlUsd - a.tvlUsd);
    return priced;
  }
  function makeTokenPool(rec, p, startBlock) {
    return { ...p, rec, ready: false, pre: [], history: [], lastPos: null, lastEventAt: null, startBlock, swaps: 0, lastTrade: null,
      cur: { price: p.state.price, reserve0: p.state.reserve0, reserve1: p.state.reserve1, sqrtPriceX96: p.state.sqrtPriceX96 }, reorgs: 0 };
  }
  const ctxOf = tp => ({ tokenIsToken0: tp.tokenIsToken0, dec0: tp.dec0, dec1: tp.dec1, tokenDecimals: tp.tokenDecimals, quoteDecimals: tp.quoteDecimals, poolId: tp.poolId });

  /* ---------------- supply / FDV ---------------- */
  function refreshSupply(rec, force) {
    const age = rec.supply ? now() - rec.supply.at : Infinity;
    if (!force && age < O.supplyTtlMs) return null;
    if (rec.supplyBusy) return null; rec.supplyBusy = true;
    return registry.totalSupplyOf(rec.chain, rec.token, { force: true }).then(s => { rec.supply = s; }, e => { metrics?.inc('supply_errors'); rec.supplyErr = String(e && e.message || '').slice(0, 40); }).finally(() => { rec.supplyBusy = false; });
  }

  /* ---------------- log ingestion ---------------- */
  /* Called by the upstream transport for every eth_subscription log. Never throws. */
  function onLog(chain, log) {
    const recvAt = now(), recvPerf = perf();
    try { processLog(chain, log, recvAt, recvPerf, {}); } catch (e) { metrics?.inc('log_errors'); }
  }
  function processLog(chain, log, recvAt, recvPerf, { silent = false, source = 'live' } = {}) {
    metrics?.inc('logs_received');
    if (!log || typeof log !== 'object' || !isAddr(log.address || '') || !Array.isArray(log.topics)) { metrics?.inc('logs_malformed'); return; }
    const set = poolIndex.get(pkey(chain, log.address));
    if (!set || !set.size) { metrics?.inc('logs_unknown_pool'); return; }
    if (!HASH_RE.test(log.blockHash || '') || !HASH_RE.test(log.transactionHash || '')) { metrics?.inc('logs_malformed'); return; }
    let li; try { li = Number(BigInt(log.logIndex)); } catch { metrics?.inc('logs_malformed'); return; }
    const id = chain + ':' + lc(log.blockHash) + ':' + lc(log.transactionHash) + ':' + li;
    if (log.removed === true) { for (const tp of set) handleRemoved(tp, id, log); return; }
    if (seen.has(id)) { metrics?.inc('logs_duplicate'); return; }
    let any = false;
    for (const tp of set) {
      const h = handlerFor(tp.protocol);
      if (h.matches && !h.matches(log, ctxOf(tp))) continue;
      if (!tp.ready) { if (tp.pre.length < O.preReadyMax) tp.pre.push({ log, recvAt, recvPerf }); else metrics?.inc('pre_ready_dropped'); continue; }
      if (applyLog(tp, id, log, recvAt, recvPerf, silent, source)) any = true;
    }
    if (any) seen.set(id, true);
  }
  function applyLog(tp, id, log, recvAt, recvPerf, silent, source) {
    const h = handlerFor(tp.protocol);
    let ev;
    try { ev = h.decode(log, ctxOf(tp)); } catch (e) { metrics?.inc('logs_malformed'); return false; }
    const tDecoded = perf();
    const pos = [ev.blockNumber, ev.logIndex];
    if (tp.lastPos && !posGt(pos, tp.lastPos)) { metrics?.inc('logs_late'); return true; }
    const entry = { id, pos, blockHash: lc(log.blockHash), txHash: lc(log.transactionHash), snapshot: null, trade: null };
    let changed = false;
    if (ev.kind === 'state') {            // V2 Sync: reserves after any pool update
      const price = h.spotFromReserves(ev.reserve0, ev.reserve1, ctxOf(tp));
      if (price != null && price > 0) { tp.cur = { price, reserve0: ev.reserve0, reserve1: ev.reserve1, sqrtPriceX96: null }; entry.snapshot = { ...tp.cur }; changed = true; }
    } else if (ev.kind === 'swap') {
      entry.trade = { ...ev.trade, txHash: entry.txHash, pool: tp.address };
      tp.swaps++; tp.lastTrade = entry.trade;
      if (ev.price != null && ev.price > 0) { tp.cur = { price: ev.price, reserve0: tp.cur.reserve0, reserve1: tp.cur.reserve1, sqrtPriceX96: ev.sqrtPriceX96 }; entry.snapshot = { ...tp.cur }; changed = true; }
      changed = true; // a swap is always publishable (carries trade info)
    }
    tp.history.push(entry); if (tp.history.length > O.historySize) tp.history.shift();
    tp.lastPos = pos; tp.lastEventAt = now(); tp.rec && (tp.rec.lastEventAt = tp.lastEventAt);
    if (changed && !silent) publish(tp.rec, ev.kind === 'swap' ? 'swap' : 'sync', { tp, entry, timing: { recvAt, recvPerf, decodedPerf: tDecoded }, source });
    return true;
  }
  /* Reorg: a removed log reverts the pool to the latest remaining snapshot, or re-reads on-chain state if the ring is exhausted. */
  function handleRemoved(tp, id, log) {
    metrics?.inc('logs_removed');
    seen.delete(id);
    const idx = tp.history.findIndex(e => e.id === id);
    if (idx < 0) { // not applied (or older than the ring): only act if it could have affected state
      if (tp.lastPos && Number(BigInt(log.blockNumber || 0)) <= tp.lastPos[0]) resync(tp, 'reorg_unknown_log').catch(() => {});
      return;
    }
    tp.history.splice(idx, 1);
    // everything after a removed log in the same orphaned block is also invalid; the node sends their removals too, we only trim state here.
    const last = [...tp.history].reverse().find(e => e.snapshot);
    tp.lastPos = tp.history.length ? tp.history[tp.history.length - 1].pos : null;
    tp.reorgs++; metrics?.inc('reorgs');
    if (last) { tp.cur = { ...last.snapshot }; publish(tp.rec, 'reorg', { tp, reorg: true }); }
    else resync(tp, 'reorg_ring_exhausted').catch(() => {});
  }

  /* ---------------- recovery / reconcile ---------------- */
  async function resync(tp, reason, { silent = false, resetPos = /^reorg/.test(reason) } = {}) {
    const st = await registry.readPoolState(tp);
    if (st.empty) { metrics?.inc('resync_empty'); return false; }
    const drift = tp.cur.price && Math.abs(st.price - tp.cur.price) / tp.cur.price;
    tp.cur = { price: st.price, reserve0: st.reserve0 ?? tp.cur.reserve0, reserve1: st.reserve1 ?? tp.cur.reserve1, sqrtPriceX96: st.sqrtPriceX96 ?? null };
    if (resetPos) { tp.history = []; tp.lastPos = null; }
    metrics?.inc('resyncs');
    if (reason === 'reconcile' && drift > 1e-9) metrics?.inc('reconcile_drift');
    if (!silent && (reason !== 'reconcile' || drift > 1e-9)) publish(tp.rec, reason === 'reconcile' ? 'reconcile' : 'resync', { tp });
    return true;
  }
  /* Fetch missed logs since the pool's last processed block (or its discovery block). Falls back to a state re-read when the gap is large or getLogs fails. */
  async function recoverPool(tp, { silent = false } = {}) {
    const from = tp.lastPos ? Math.max(0, tp.lastPos[0] - 2) : tp.startBlock;
    if (from == null) return resync(tp, 'recover_no_block', { silent: true });
    let latest; try { latest = await rpc.blockNumber(tp.chain); } catch { metrics?.inc('recover_errors'); return false; }
    if (latest - from > O.maxBackfillBlocks) { metrics?.inc('recover_large_gap'); const ok = await resync(tp, 'recover_gap', { silent }); if (ok) tp.startBlock = latest; return ok; }
    try {
      const logs = await rpc.getLogs(tp.chain, { address: tp.address, topics: [handlerFor(tp.protocol).topics], fromBlock: from, toBlock: latest });
      logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
      const wasReady = tp.ready; tp.ready = true;
      for (const l of logs) processLog(tp.chain, { ...l, removed: false }, now(), perf(), { silent: true, source: 'backfill' });
      tp.ready = wasReady; tp.startBlock = latest;
      metrics?.inc('backfilled_logs', logs.length); metrics?.inc('recoveries');
      if (!silent && logs.length) publish(tp.rec, 'backfill', { tp });
      return true;
    } catch (e) { metrics?.inc('recover_errors'); return resync(tp, 'recover_getlogs_failed', { silent }).catch(() => false); }
  }
  /* Upstream hooks */
  function onUpstreamDown(chain) { for (const rec of tokens.values()) if (rec.chain === chain && rec.status === 'live') for (const fn of rec.subs.values()) { try { fn({ type: 'evm_token_status', v: 1, chain, chainId: CHAIN_CONFIG[chain].chainId, token: rec.token, status: 'degraded', reason: 'upstream_disconnected' }); } catch {} } }
  async function onUpstreamUp(chain) {
    const work = [];
    for (const rec of tokens.values()) if (rec.chain === chain && rec.status === 'live') for (const tp of rec.pools) work.push(recoverPool(tp, { silent: true }).then(() => publish(rec, 'recovered', { tp })).catch(() => {}));
    await Promise.all(work);
  }
  async function reconcileAll() {
    for (const rec of [...tokens.values()]) {
      if (rec.status !== 'live' || !rec.subs.size) continue;
      refreshSupply(rec, false);
      for (const tp of rec.pools) { try { await resync(tp, 'reconcile'); await refreshTvl(tp); } catch { metrics?.inc('reconcile_errors'); } }
    }
  }
  async function refreshTvl(tp) {
    if (tp.family === 'v4') return; // PoolManager balances are shared across all V4 pools; they cannot be attributed to one pool.
    const bal = await rpc.batch(tp.chain, [tp.token, tp.quote].map(t => ({ method: 'eth_call', params: [{ to: t, data: encodeCall(SEL.balanceOf, tp.address) }, 'latest'] })));
    if (!bal[0].ok || !bal[1].ok) return;
    tp.tokenBal = Number(BigInt(bal[0].result)) / Math.pow(10, tp.tokenDecimals); tp.quoteBal = Number(BigInt(bal[1].result)) / Math.pow(10, tp.quoteDecimals);
    const q = quotes.peek(tp.chain, tp.quote); if (q) { tp.tvlUsd = (tp.quoteBal + tp.tokenBal * tp.cur.price) * q.usd; tp.tvlAt = now(); }
  }
  function startReconcile() { if (reconcileTimer || !O.reconcileMs) return; reconcileTimer = setInterval(() => { reconcileAll().catch(() => {}); }, O.reconcileMs); reconcileTimer.unref?.(); }

  /* ---------------- publishing ---------------- */
  function publish(rec, trigger, { tp = null, entry = null, timing = null, reorg = false, source = 'live' } = {}) {
    if (!rec || !rec.pools.length) return null;
    const tPrice0 = perf();
    const cfg = CHAIN_CONFIG[rec.chain];
    const usable = rec.pools.filter(p => p.ready && p.cur && p.cur.price > 0);
    if (!usable.length) return null;
    const primary = usable.reduce((b, p) => { const av = p.tvlUsd ?? Number(p.activeLiquidity || 0n); const bv = b.tvlUsd ?? Number(b.activeLiquidity || 0n); return av > bv ? p : b; }, usable[0]);
    const qp = quotes.peek(rec.chain, primary.quote);
    const priceQuote = primary.cur.price;
    const priceUsd = qp ? priceQuote * qp.usd : null;
    const tPriced = perf();
    refreshSupply(rec, false);
    const sup = rec.supply;
    const fdvUsd = priceUsd != null && sup ? priceUsd * sup.supply : null;
    const tMc = perf();
    rec.seq++;
    const trade = entry && entry.trade ? { ...entry.trade, usd: (() => { const q = quotes.peek(rec.chain, tp.quote); return q ? entry.trade.quoteAmount * q.usd : null; })() } : null;
    const msg = {
      type: 'evm_market', v: 1, chain: rec.chain, chainId: cfg.chainId, token: rec.token, seq: rec.seq, trigger, snapshot: trigger === 'snapshot', reorg, source,
      priceUsd, priceQuote, quoteToken: primary.quote, quoteUsd: qp ? qp.usd : null, quoteUsdBasis: qp ? qp.basis : null, quoteUsdAgeMs: qp ? qp.ageMs : null,
      priceBasis: primary.family === 'v2' ? 'v2_reserves_after_update' : primary.family === 'v4' ? 'v4_poolmanager_sqrt_price_after_swap' : 'v3_sqrt_price_after_swap',
      totalSupply: sup ? sup.supply : null, supplyStale: !!(sup && sup.stale),
      fdvUsd, mcKind: 'fdv',
      circulatingSupply: null, circulatingMarketCapUsd: null, circulatingStatus: 'unavailable',
      liquidityUsd: primary.tvlUsd ?? null, liquidityAt: primary.tvlAt ?? null,
      primaryPool: { address: primary.address, poolId: primary.poolId || null, protocol: primary.protocol, fee: primary.fee, quote: primary.quote },
      pools: usable.map(p => { const q = quotes.peek(rec.chain, p.quote); return { address: p.address, protocol: p.protocol, fee: p.fee, quote: p.quote, priceQuote: p.cur.price, priceUsd: q ? p.cur.price * q.usd : null, tvlUsd: p.tvlUsd ?? null, lastEventAt: p.lastEventAt }; }),
      trade, block: tp && tp.lastPos ? { number: tp.lastPos[0], logIndex: tp.lastPos[1] } : null,
      usdAvailable: priceUsd != null,
      timing: { receivedAt: timing ? timing.recvAt : null, decodeMs: timing ? +(timing.decodedPerf - timing.recvPerf).toFixed(3) : null, priceMs: +(tPriced - tPrice0).toFixed(3), mcMs: +(tMc - tPriced).toFixed(3), serverMs: timing ? +(perf() - timing.recvPerf).toFixed(3) : null }
    };
    if (timing) { metrics?.observe('decode_ms', msg.timing.decodeMs); metrics?.observe('price_ms', msg.timing.priceMs); metrics?.observe('mc_ms', msg.timing.mcMs); metrics?.observe('server_total_ms', msg.timing.serverMs); }
    metrics?.inc('market_updates');
    emit(rec, msg);
    return msg;
  }

  function stats() {
    const toks = [...tokens.values()];
    return { tokens: toks.length, pools: poolIndex.size, seen: seen.size, discoveryCache: discoveryCache.size, byStatus: toks.reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {}), subscribers: toks.reduce((n, t) => n + t.subs.size, 0) };
  }
  function shutdown() { clearInterval(reconcileTimer); reconcileTimer = null; for (const t of timers) clearTimeout(t); timers.clear(); }
  return Object.freeze({ track, untrack, onLog, onUpstreamUp, onUpstreamDown, reconcileAll, startReconcile, stats, shutdown, _tokens: tokens, _poolIndex: poolIndex, _seen: seen, _discoveryCache: discoveryCache, _recoverPool: recoverPool, _publish: publish });
}
