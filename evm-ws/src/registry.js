/* Token metadata + pool discovery/verification with bounded caches.
 * A pool is accepted only if ALL of these hold:
 *   1. the chain's factory (verified to have code at startup) returns exactly that pool for the (token, quote[, fee]) pair,
 *   2. the pool's own token0()/token1() equal the sorted (token, quote) pair,
 *   3. its protocol state can be read and is non-empty (V2 reserves > 0; V3 sqrtPrice > 0 and liquidity > 0).
 * The browser can suggest a token, never a pool or an RPC URL. */
import { CHAIN_CONFIG, quoteAssets } from './chains.js';
import { SEL, encodeCall, isAddr, lc, readUint, readAddr, ZERO_ADDR, words } from './abi.js';
import { handlerFor } from './protocols.js';

export class LRU {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) { if (!this.m.has(k)) return undefined; const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v; }
  peek(k) { return this.m.get(k); }
  set(k, v) { if (this.m.has(k)) this.m.delete(k); this.m.set(k, v); while (this.m.size > this.max) this.m.delete(this.m.keys().next().value); return v; }
  delete(k) { return this.m.delete(k); }
  has(k) { return this.m.has(k); }
  get size() { return this.m.size; }
  clear() { this.m.clear(); }
}

export function createRegistry({ rpc, metrics = null, now = Date.now, supplyTtlMs = 600000, chainVerifyTtlMs = 60000 } = {}) {
  const decimalsCache = new LRU(5000), supplyCache = new LRU(2000), inflight = new Map(), chainHealth = new Map();
  const once = (key, fn) => { let p = inflight.get(key); if (!p) { p = fn().finally(() => inflight.delete(key)); inflight.set(key, p); } return p; };

  /* ---- chain verification (chain id + code at every configured factory / wrapped native) ---- */
  async function verifyChain(chain, { force = false } = {}) {
    const cfg = CHAIN_CONFIG[chain]; if (!cfg) return { ok: false, reason: 'unknown_chain' };
    const c = chainHealth.get(chain);
    if (!force && c && now() - c.at < chainVerifyTtlMs) return c.value;
    return once('verify:' + chain, async () => {
      let value;
      try {
        const id = Number(BigInt(await rpc.call(chain, 'eth_chainId')));
        if (id !== cfg.chainId) value = { ok: false, reason: 'chain_id_mismatch', protocols: [] };
        else {
          const targets = [...cfg.protocols.map(p => p.factory), cfg.native.wrapped];
          const res = await rpc.batch(chain, targets.map(t => ({ method: 'eth_getCode', params: [t, 'latest'] })));
          const hasCode = r => r.ok && typeof r.result === 'string' && r.result.length > 4;
          const protocols = cfg.protocols.filter((p, i) => hasCode(res[i])).map(p => p.id);
          const wrappedOk = hasCode(res[res.length - 1]);
          value = { ok: protocols.length > 0 && wrappedOk, reason: !wrappedOk ? 'wrapped_native_missing' : protocols.length ? '' : 'no_verified_factory', protocols, disabled: cfg.protocols.filter(p => !protocols.includes(p.id)).map(p => p.id), chainId: id };
        }
      } catch (e) { value = { ok: false, reason: 'rpc_unreachable', protocols: [] }; }
      chainHealth.set(chain, { at: now(), value });
      return value;
    });
  }
  const chainStatus = () => Object.fromEntries([...chainHealth].map(([k, v]) => [k, { ...v.value, checkedAt: v.at }]));

  /* ---- token metadata ---- */
  async function decimalsOf(chain, token) {
    const k = chain + ':' + lc(token), hit = decimalsCache.get(k);
    if (hit !== undefined) return hit;
    return once('dec:' + k, async () => {
      const d = Number(readUint(await rpc.ethCall(chain, token, SEL.decimals)));
      if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error('invalid_token_decimals');
      return decimalsCache.set(k, d);
    });
  }
  async function totalSupplyOf(chain, token, { force = false } = {}) {
    const k = chain + ':' + lc(token), hit = supplyCache.peek(k);
    if (!force && hit && now() - hit.at < supplyTtlMs) return hit;
    return once('sup:' + k, async () => {
      const [dec, raw] = await Promise.all([decimalsOf(chain, token), rpc.ethCall(chain, token, SEL.totalSupply)]);
      const total = readUint(raw);
      const rec = { raw: total, decimals: dec, supply: Number(total) / Math.pow(10, dec), at: now() };
      if (!(rec.supply > 0) || !Number.isFinite(rec.supply)) throw new Error('invalid_total_supply');
      return supplyCache.set(k, rec);
    }).catch(e => { if (hit) { metrics?.inc('supply_stale_served'); return { ...hit, stale: true }; } throw e; });
  }

  /* ---- pool discovery for one (token, quote) pair across every verified protocol of the chain ---- */
  async function findPools(chain, token, quote) {
    const cfg = CHAIN_CONFIG[chain]; token = lc(token); quote = lc(quote);
    if (token === quote) return [];
    const health = await verifyChain(chain);
    if (!health.ok) throw new Error('chain_unavailable:' + health.reason);
    const protos = cfg.protocols.filter(p => health.protocols.includes(p.id));
    const lookups = [];
    for (const p of protos) {
      if (p.family === 'v2') lookups.push({ p, fee: null, call: { method: 'eth_call', params: [{ to: p.factory, data: encodeCall(SEL.getPair, token, quote) }, 'latest'] } });
      else for (const fee of p.fees) lookups.push({ p, fee, call: { method: 'eth_call', params: [{ to: p.factory, data: encodeCall(SEL.getPool, token, quote, fee) }, 'latest'] } });
    }
    const res = await rpc.batch(chain, lookups.map(l => l.call));
    const seen = new Set(), cands = [];
    lookups.forEach((l, i) => {
      if (!res[i].ok) return;
      let addr; try { addr = readAddr(res[i].result); } catch { return; }
      if (addr === ZERO_ADDR || seen.has(addr)) return;
      seen.add(addr); cands.push({ ...l, address: addr });
    });
    if (!cands.length) return [];
    const [tokenDec, quoteDec] = await Promise.all([decimalsOf(chain, token), decimalsOf(chain, quote)]);
    const sortedToken0 = token < quote ? token : quote, sortedToken1 = token < quote ? quote : token;
    const tokenIsToken0 = token === sortedToken0;
    // one batch: token0, token1, protocol state, both balances for every candidate
    const per = c => [
      { method: 'eth_call', params: [{ to: c.address, data: SEL.token0 }, 'latest'] },
      { method: 'eth_call', params: [{ to: c.address, data: SEL.token1 }, 'latest'] },
      ...handlerFor(c.p.id).stateCalls(c.address),
      { method: 'eth_call', params: [{ to: token, data: encodeCall(SEL.balanceOf, c.address) }, 'latest'] },
      { method: 'eth_call', params: [{ to: quote, data: encodeCall(SEL.balanceOf, c.address) }, 'latest'] }
    ];
    const flat = []; const spans = cands.map(c => { const calls = per(c); const start = flat.length; flat.push(...calls); return { start, n: calls.length }; });
    const out = await rpc.batch(chain, flat);
    const verified = [];
    cands.forEach((c, i) => {
      try {
        const r = out.slice(spans[i].start, spans[i].start + spans[i].n);
        if (!r[0].ok || !r[1].ok) return;
        if (readAddr(r[0].result) !== sortedToken0 || readAddr(r[1].result) !== sortedToken1) { metrics?.inc('pool_rejected_pair_mismatch'); return; }
        const ctx = { tokenIsToken0, dec0: tokenIsToken0 ? tokenDec : quoteDec, dec1: tokenIsToken0 ? quoteDec : tokenDec, tokenDecimals: tokenDec, quoteDecimals: quoteDec };
        const h = handlerFor(c.p.id), nState = h.stateCalls(c.address).length;
        const st = h.parseState(r.slice(2, 2 + nState), ctx);
        if (st.empty || !(st.price > 0)) { metrics?.inc('pool_rejected_empty'); return; }
        const tb = r[2 + nState], qb = r[3 + nState];
        if (!tb.ok || !qb.ok) return;
        const tokenBal = Number(readUint(tb.result)) / Math.pow(10, tokenDec), quoteBal = Number(readUint(qb.result)) / Math.pow(10, quoteDec);
        verified.push({
          chain, address: c.address, protocol: c.p.id, family: c.p.family, fee: c.fee, factory: c.p.factory, token, quote,
          token0: sortedToken0, token1: sortedToken1, tokenIsToken0, tokenDecimals: tokenDec, quoteDecimals: quoteDec, dec0: ctx.dec0, dec1: ctx.dec1,
          state: st, tokenBal, quoteBal, tvlQuote: quoteBal + tokenBal * st.price
        });
      } catch (e) { metrics?.inc('pool_rejected_error'); }
    });
    return verified;
  }

  /* Re-read live state for a verified pool (used by reconcile, reorg recovery, reconnect gaps). */
  async function readPoolState(pool) {
    const h = handlerFor(pool.protocol);
    const res = await rpc.batch(pool.chain, h.stateCalls(pool.address));
    return h.parseState(res, pool);
  }
  const clear = () => { decimalsCache.clear(); supplyCache.clear(); chainHealth.clear(); };
  return Object.freeze({ verifyChain, chainStatus, decimalsOf, totalSupplyOf, findPools, readPoolState, clear, _caches: { decimalsCache, supplyCache } });
}
export { quoteAssets, isAddr, words };
