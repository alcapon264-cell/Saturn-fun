/* Saturn EVM service (ES module). Framework-neutral on purpose: every handler takes a plain request object and returns {status, body},
 * so lib/app.js can run it behind Saturn's EXISTING CORS, authentication, session verification and request guards.
 * This module never signs, never holds keys, never spends funds, and cannot create or launch tokens.
 *
 *   req = { method: 'GET'|'POST', query: {...}, body: <parsed JSON or string>, ip: '1.2.3.4' }
 *   res = { status: number, body: object }
 *
 * Secrets (provider RPC URLs, 0x key) are read from environment variables only and are never returned to the browser. */

// Chain IDs: 0x docs (docs.0x.org/docs/introduction/supported-chains); Robinhood Chain 4663 also per Alchemy, Uniswap and 1inch docs.
// A chain is only reported usable when its upstream RPC answers eth_chainId with EXACTLY this id.
export const CHAINS = Object.freeze({
  eth:       Object.freeze({ chainId: 1,     env: 'EVM_RPC_URL_ETH' }),
  base:      Object.freeze({ chainId: 8453,  env: 'EVM_RPC_URL_BASE' }),
  arb:       Object.freeze({ chainId: 42161, env: 'EVM_RPC_URL_ARB' }),
  op:        Object.freeze({ chainId: 10,    env: 'EVM_RPC_URL_OP' }),
  poly:      Object.freeze({ chainId: 137,   env: 'EVM_RPC_URL_POLY' }),
  robinhood: Object.freeze({ chainId: 4663,  env: 'EVM_RPC_URL_ROBINHOOD' }),
  bsc:       Object.freeze({ chainId: 56,    env: 'EVM_RPC_URL_BSC' }),
  avax:      Object.freeze({ chainId: 43114, env: 'EVM_RPC_URL_AVAX' }),
  hyper:     Object.freeze({ chainId: 999,   env: 'EVM_RPC_URL_HYPER' })
});
export const SWAP_CHAINS = Object.freeze(new Set([1, 8453, 42161, 10, 137, 4663, 56, 43114, 999]));
// Methods the browser may use. Everything else (admin, debug, trace, personal_*, eth_sign*, eth_accounts, batches...) is refused.
export const RPC_ALLOW = Object.freeze(new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_call', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getTransactionCount',
  'eth_getBlockByNumber', 'eth_getCode', 'eth_sendRawTransaction']));
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ADDR = /^0x[0-9a-fA-F]{40}$/, UINT = /^[0-9]{1,78}$/;
export const LIMITS = Object.freeze({ cfg: [60, 60000], rpc: [120, 60000], quote: [40, 60000] });

const out = (status, body) => ({ status, body });

/** Best-effort in-memory limiter (per server instance). app.js should pass its own shared limiter when it has one. */
export function memoryLimiter() {
  const hits = new Map();
  return (key, ip, max, windowMs, now = Date.now()) => {
    const k = key + '|' + (ip || 'x'), a = (hits.get(k) || []).filter(t => now - t < windowMs);
    a.push(now); hits.set(k, a); if (hits.size > 5000) hits.clear();
    return a.length > max;
  };
}

/**
 * createEvm({ env, fetchImpl, now, limiter })
 *  - limiter(key, ip, max, windowMs) -> true when the caller is OVER the limit. Defaults to an in-memory limiter.
 *    Pass Saturn's existing limiter from lib/app.js so EVM traffic shares the same abuse protection.
 */
export function createEvm({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, limiter = memoryLimiter() } = {}) {
  const verifiedCache = new Map();
  const over = (name, req) => limiter(name, req.ip || '', LIMITS[name][0], LIMITS[name][1]);

  async function timedFetch(url, opt, ms) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 10000);
    try { return await fetchImpl(url, Object.assign({}, opt, { signal: c.signal })); } finally { clearTimeout(t); }
  }
  async function upstreamRpc(key, method, params) {
    const c = CHAINS[key], url = c && env[c.env];
    if (!url) { const e = new Error('chain_not_configured'); e.code = 'chain_not_configured'; throw e; }
    const r = await timedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 10000);
    if (!r.ok) { const e = new Error('upstream_' + r.status); e.code = 'upstream_error'; throw e; }
    return r.json();
  }
  /** Verified = the configured upstream really is this chain. Cached 5 minutes. */
  async function verified(key) {
    const c = Object.prototype.hasOwnProperty.call(CHAINS, key) ? CHAINS[key] : null; if (!c) return { ok: false, reason: 'unknown_chain' };
    if (!env[c.env]) return { ok: false, reason: 'rpc_not_configured' };
    const h = verifiedCache.get(key); if (h && now() - h.at < 300000) return h.v;
    let v;
    try {
      const j = await upstreamRpc(key, 'eth_chainId', []);
      const got = j && typeof j.result === 'string' ? parseInt(j.result, 16) : NaN;
      v = got === c.chainId ? { ok: true } : { ok: false, reason: 'chain_id_mismatch' };
    } catch (e) { v = { ok: false, reason: 'rpc_unreachable' }; }
    verifiedCache.set(key, { at: now(), v }); return v;
  }

  /** GET /api/evm-config - public: which chains this server can really serve right now. No secrets. */
  async function config(req) {
    if (req.method !== 'GET') return out(405, { error: 'method_not_allowed' });
    if (over('cfg', req)) return out(429, { error: 'rate_limited' });
    const chains = {};
    await Promise.all(Object.keys(CHAINS).map(async k => {
      const c = CHAINS[k], v = await verified(k);
      chains[k] = { chainId: c.chainId, rpc: !!v.ok, swap: !!(v.ok && env.ZEROX_API_KEY && SWAP_CHAINS.has(c.chainId)), reason: v.ok ? '' : v.reason };
    }));
    return out(200, { ok: true, chains });
  }

  /** POST /api/evm-rpc?chain=<key> - ONE allow-listed JSON-RPC request, verified chains only. */
  async function rpc(req) {
    if (req.method !== 'POST') return out(405, { error: 'method_not_allowed' });
    if (over('rpc', req)) return out(429, { error: 'rate_limited' });
    const key = String((req.query && req.query.chain) || '');
    if (!Object.prototype.hasOwnProperty.call(CHAINS, key)) return out(400, { error: 'unknown_chain' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string') return out(400, { error: 'bad_request' });
    if (!RPC_ALLOW.has(body.method)) return out(403, { error: 'method_not_allowed', method: body.method });
    const params = Array.isArray(body.params) ? body.params : [];
    if (JSON.stringify(params).length > 70000) return out(413, { error: 'too_large' });
    const v = await verified(key);
    if (!v.ok) return out(503, { error: 'chain_unavailable', reason: v.reason });
    try {
      const j = await upstreamRpc(key, body.method, params);
      return out(200, { jsonrpc: '2.0', id: body.id == null ? 1 : body.id, result: j.result, error: j.error });
    } catch (e) { return out(502, { error: 'upstream_failed' }); }
  }

  /** GET /api/evm-quote - proxies 0x Swap API v2 (AllowanceHolder); the 0x key stays here. The client re-validates before signing. */
  async function quote(req) {
    if (req.method !== 'GET') return out(405, { error: 'method_not_allowed' });
    if (over('quote', req)) return out(429, { error: 'rate_limited' });
    const q = req.query || {}, key = String(q.chain || '');
    if (!Object.prototype.hasOwnProperty.call(CHAINS, key)) return out(400, { error: 'unknown_chain' });
    const c = CHAINS[key];
    if (!env.ZEROX_API_KEY) return out(503, { error: 'swap_not_configured' });
    if (!SWAP_CHAINS.has(c.chainId)) return out(503, { error: 'swap_not_supported' });
    const norm = t => (String(t).toUpperCase() === 'NATIVE' ? NATIVE : t);
    const sell = norm(String(q.sellToken || '')), buy = norm(String(q.buyToken || '')), taker = String(q.taker || ''), amt = String(q.sellAmount || '');
    if (!ADDR.test(sell) || !ADDR.test(buy) || !ADDR.test(taker) || !UINT.test(amt) || BigInt(amt) <= 0n) return out(400, { error: 'bad_params' });
    if (sell.toLowerCase() === buy.toLowerCase()) return out(400, { error: 'same_token' });
    const bps = Math.max(1, Math.min(1000, parseInt(q.slippageBps, 10) || 100)), mode = q.mode === 'quote' ? 'quote' : 'price';
    const v = await verified(key);
    if (!v.ok) return out(503, { error: 'chain_unavailable', reason: v.reason });
    const u = new URL('https://api.0x.org/swap/allowance-holder/' + mode);
    u.searchParams.set('chainId', String(c.chainId)); u.searchParams.set('sellToken', sell); u.searchParams.set('buyToken', buy);
    u.searchParams.set('sellAmount', amt); u.searchParams.set('taker', taker); u.searchParams.set('slippageBps', String(bps));
    let r, j;
    try { r = await timedFetch(u.toString(), { headers: { '0x-api-key': env.ZEROX_API_KEY, '0x-version': 'v2' } }, 12000); j = await r.json(); }
    catch (e) { return out(502, { error: 'quote_upstream_failed' }); }
    if (!r.ok) return out(200, { ok: false, error: 'no_route', message: String((j && (j.reason || j.message || (j.data && j.data.message))) || 'No route found').slice(0, 200) });
    if (j.liquidityAvailable === false) return out(200, { ok: false, error: 'no_liquidity', message: 'No liquidity found for this token on this network.' });
    const t = j.transaction || null, al = j.issues && j.issues.allowance || null;
    return out(200, { ok: true, mode, chain: key, chainId: c.chainId, sellToken: sell, buyToken: buy, sellAmount: String(j.sellAmount || amt),
      buyAmount: String(j.buyAmount || ''), minBuyAmount: String(j.minBuyAmount || ''), totalNetworkFee: j.totalNetworkFee == null ? null : String(j.totalNetworkFee),
      allowance: al ? { spender: String(al.spender || '') } : null,
      balanceIssue: j.issues && j.issues.balance ? { actual: String(j.issues.balance.actual), expected: String(j.issues.balance.expected) } : null,
      transaction: mode === 'quote' && t ? { to: t.to, data: t.data, value: String(t.value || '0'), gas: t.gas == null ? null : String(t.gas), gasPrice: t.gasPrice == null ? null : String(t.gasPrice) } : null });
  }

  return Object.freeze({ config, rpc, quote, verified, _clear: () => verifiedCache.clear() });
}
