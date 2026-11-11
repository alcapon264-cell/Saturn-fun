/* Quote-token -> USD service.
 *  - Stablecoins listed in chains.js: 1 USD (basis "stable_peg_assumed"; a depeg is NOT detected - documented limitation).
 *  - Wrapped native token: price of the deepest verified on-chain stable/native reference pool (min liquidity enforced),
 *    cached with a short TTL; Coinbase spot (the source the existing /api/evm-market route already uses) is the labelled fallback
 *    and the only source on Robinhood Chain, where no stablecoin address is configured.
 *  - Never one HTTP/RPC call per swap: hot-path reads are synchronous cache peeks; refreshes are deduplicated and rate-bounded.
 *  - No price is ever invented: when nothing verified is available the result is null and consumers publish no USD value. */
import { CHAIN_CONFIG } from './chains.js';
import { lc } from './abi.js';
import { LRU } from './registry.js';

export function createQuoteService({ registry, fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 15000, staleMs = 300000, minRefLiqUsd = 100000, metrics = null, coinbaseTimeoutMs = 6000 } = {}) {
  const cache = new LRU(200), inflight = new Map(), refPools = new LRU(50);
  const stableOf = (chain, addr) => CHAIN_CONFIG[chain].stables[lc(addr)] || null;

  async function onchainNative(chain) {
    const cfg = CHAIN_CONFIG[chain], stables = Object.keys(cfg.stables);
    if (!stables.length) return null;
    let ref = refPools.peek(chain);
    if (!ref || now() - ref.at > 1800000) {
      let best = null;
      for (const s of stables) {
        let pools = [];
        try { pools = await registry.findPools(chain, cfg.native.wrapped, s); } catch { continue; }
        for (const p of pools) if (p.quoteBal >= minRefLiqUsd && (!best || p.quoteBal > best.quoteBal)) best = p;
      }
      ref = { at: now(), pool: best }; refPools.set(chain, ref);
    }
    if (!ref.pool) return null;
    const st = await registry.readPoolState(ref.pool);
    if (st.empty || !(st.price > 0) || !Number.isFinite(st.price)) return null;
    return { usd: st.price, basis: 'onchain_reference_pool', source: ref.pool.protocol + ':' + ref.pool.address };
  }
  async function coinbase(chain) {
    const pair = CHAIN_CONFIG[chain].native.coinbase;
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), coinbaseTimeoutMs);
    try {
      metrics?.inc('quote_http_requests');
      const r = await fetchImpl('https://api.coinbase.com/v2/prices/' + pair + '/spot', { headers: { accept: 'application/json' }, signal: ac.signal });
      if (!r.ok) return null;
      const usd = Number((await r.json())?.data?.amount);
      return Number.isFinite(usd) && usd > 0 ? { usd, basis: 'coinbase_spot', source: 'coinbase:' + pair } : null;
    } catch { return null; } finally { clearTimeout(t); }
  }
  async function refresh(chain, quote) {
    const k = chain + ':' + lc(quote);
    let p = inflight.get(k);
    if (p) return p;
    p = (async () => {
      let v = null;
      try { v = await onchainNative(chain); } catch { v = null; }
      if (!v) v = await coinbase(chain);
      if (v) { const rec = { ...v, at: now() }; cache.set(k, rec); metrics?.inc('quote_refreshes'); return rec; }
      metrics?.inc('quote_refresh_failures');
      return null;
    })().finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  }
  /* Synchronous hot-path read. Returns {usd,basis,source,at,ageMs,stale} or null. Starts a background refresh when older than ttl. */
  function peek(chain, quote) {
    if (stableOf(chain, quote)) return { usd: 1, basis: 'stable_peg_assumed', source: 'stable:' + stableOf(chain, quote), at: now(), ageMs: 0, stale: false };
    if (lc(quote) !== CHAIN_CONFIG[chain].native.wrapped) return null; // unverified quote asset: never priced
    const rec = cache.peek(chain + ':' + lc(quote));
    const age = rec ? now() - rec.at : Infinity;
    if (!rec || age > ttlMs) refresh(chain, quote).catch(() => {});
    if (!rec || age > staleMs) return null;
    return { ...rec, ageMs: age, stale: age > ttlMs * 2 };
  }
  async function get(chain, quote) {
    const p = peek(chain, quote);
    if (p) return p;
    if (stableOf(chain, quote) || lc(quote) !== CHAIN_CONFIG[chain].native.wrapped) return null;
    const rec = await refresh(chain, quote);
    return rec ? { ...rec, ageMs: 0, stale: false } : null;
  }
  return Object.freeze({ peek, get, refresh, clear: () => { cache.clear(); refPools.clear(); } });
}
