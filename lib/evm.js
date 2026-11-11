/* Saturn EVM service.
 * Uses BlockVectra's fixed RPC endpoints and server-side API key.
 * Routes remain behind Saturn's existing CORS/auth/session/ban/rate-limit guards in lib/app.js.
 * This module never signs transactions, holds wallet keys, or launches tokens.
 */
export const CHAINS = Object.freeze({
  eth:       Object.freeze({ chainId: 1,     slug: 'eth_mainnet' }),
  base:      Object.freeze({ chainId: 8453,  slug: 'base_mainnet' }),
  arb:       Object.freeze({ chainId: 42161, slug: 'arb_mainnet' }),
  poly:      Object.freeze({ chainId: 137,   slug: 'polygon_mainnet' }),
  robinhood: Object.freeze({ chainId: 4663,  slug: 'robinhood_mainnet' }),
  bsc:       Object.freeze({ chainId: 56,    slug: 'bsc_mainnet' })
});

// All six chains above are listed by 0x for Swap API v2.
export const SWAP_CHAINS = Object.freeze(new Set([1, 8453, 42161, 137, 4663, 56]));
export const RPC_ALLOW = Object.freeze(new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_call',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_estimateGas',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_getCode',
  'eth_sendRawTransaction'
]));
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const LIMITS = Object.freeze({ cfg: [60, 60000], rpc: [120, 60000], quote: [40, 60000], market: [30, 60000] });
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]{1,78}$/;
const RH_V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const RH_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const SEL = Object.freeze({ token0:'0x0dfe1681', token1:'0xd21220a7', decimals:'0x313ce567', totalSupply:'0x18160ddd', slot0:'0x3850c7bd' });
const hexWord = n => BigInt(n).toString(16).padStart(64, '0');
const wordAddress = h => '0x' + String(h || '').replace(/^0x/, '').slice(-40).toLowerCase();
const readWord = h => { const x=String(h||'').replace(/^0x/,''); if(x.length<64) throw new Error('bad_abi_word'); return BigInt('0x'+x.slice(0,64)); };
const readAddress = h => wordAddress(h);
const ADDR_ZERO = '0x0000000000000000000000000000000000000000';
const BLOCKVECTRA_BASE = 'https://api.blockvectra.com/v1/';
// Fixed public Polygon PoS fallback. Never accept an RPC URL from a request or client.
const POLYGON_FALLBACK = 'https://polygon-bor-rpc.publicnode.com';

const out = (status, body) => ({ status, body });

export function memoryLimiter() {
  const hits = new Map();
  return (key, ip, max, windowMs, now = Date.now()) => {
    const k = key + '|' + (ip || 'x');
    const a = (hits.get(k) || []).filter(t => now - t < windowMs);
    a.push(now);
    hits.set(k, a);
    if (hits.size > 5000) hits.clear();
    return a.length > max;
  };
}

export function createEvm({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, limiter = memoryLimiter() } = {}) {
  const verifiedCache = new Map();
  let polygonUseFallback = false;
  const over = (name, req) => limiter(name, req.ip || '', LIMITS[name][0], LIMITS[name][1]);

  async function timedFetch(url, opt, ms = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetchImpl(url, { ...opt, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestRpc(url, headers, method, params) {
    const response = await timedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    }, 10000);
    if (!response.ok) {
      const error = new Error('rpc_upstream_' + response.status);
      error.code = 'upstream_error';
      throw error;
    }
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_upstream_response');
    if (payload.error) {
      const error = new Error('rpc_json_error');
      error.code = 'rpc_json_error';
      throw error;
    }
    return payload;
  }

  function primaryRpcConfig(key) {
    const chain = CHAINS[key];
    if (!chain) {
      const error = new Error('unknown_chain');
      error.code = 'unknown_chain';
      throw error;
    }
    if (!env.BLOCKVECTRA_API_KEY) {
      const error = new Error('rpc_not_configured');
      error.code = 'rpc_not_configured';
      throw error;
    }
    return {
      url: BLOCKVECTRA_BASE + chain.slug,
      headers: { 'x-api-key': env.BLOCKVECTRA_API_KEY }
    };
  }

  async function upstreamRpc(key, method, params) {
    const chain = CHAINS[key];
    if (!chain) {
      const error = new Error('unknown_chain');
      error.code = 'unknown_chain';
      throw error;
    }

    if (key !== 'poly') {
      const primary = primaryRpcConfig(key);
      return requestRpc(primary.url, primary.headers, method, params);
    }

    // Polygon only: prefer the last verified provider, but recover immediately if it fails.
    const primary = env.BLOCKVECTRA_API_KEY ? primaryRpcConfig(key) : null;
    const fallback = { url: POLYGON_FALLBACK, headers: {} };
    const first = polygonUseFallback ? fallback : primary;
    const second = polygonUseFallback ? primary : fallback;
    let firstError;
    if (first) {
      try {
        const payload = await requestRpc(first.url, first.headers, method, params);
        polygonUseFallback = first.url === POLYGON_FALLBACK;
        return payload;
      } catch (error) { firstError = error; }
    }
    if (second) {
      try {
        const payload = await requestRpc(second.url, second.headers, method, params);
        polygonUseFallback = second.url === POLYGON_FALLBACK;
        return payload;
      } catch (error) { if (!firstError) firstError = error; }
    }
    throw firstError || new Error('polygon_rpc_unavailable');
  }

  async function polygonProviderHealthy(provider) {
    try {
      const chainPayload = await requestRpc(provider.url, provider.headers, 'eth_chainId', []);
      const actual = typeof chainPayload.result === 'string' ? Number.parseInt(chainPayload.result, 16) : NaN;
      if (actual !== CHAINS.poly.chainId) return { ok: false, reason: 'chain_id_mismatch' };
      const syncPayload = await requestRpc(provider.url, provider.headers, 'eth_syncing', []);
      if (syncPayload.result !== false) return { ok: false, reason: 'polygon_node_syncing' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'rpc_unreachable' };
    }
  }

  async function verified(key) {
    const chain = Object.prototype.hasOwnProperty.call(CHAINS, key) ? CHAINS[key] : null;
    if (!chain) return { ok: false, reason: 'unknown_chain' };
    if (!env.BLOCKVECTRA_API_KEY && key !== 'poly') return { ok: false, reason: 'rpc_not_configured' };
    const cached = verifiedCache.get(key);
    const cacheTtl = key === 'poly' ? 30000 : 300000;
    if (cached && now() - cached.at < cacheTtl) return cached.value;

    let value;
    if (key === 'poly') {
      const primary = env.BLOCKVECTRA_API_KEY
        ? { url: BLOCKVECTRA_BASE + chain.slug, headers: { 'x-api-key': env.BLOCKVECTRA_API_KEY } }
        : null;
      const fallback = { url: POLYGON_FALLBACK, headers: {} };
      const primaryHealth = primary
        ? await polygonProviderHealthy(primary)
        : { ok: false, reason: 'rpc_not_configured' };
      if (primaryHealth.ok) {
        polygonUseFallback = false;
        value = { ok: true };
      } else {
        const fallbackHealth = await polygonProviderHealthy(fallback);
        if (fallbackHealth.ok) {
          polygonUseFallback = true;
          value = { ok: true };
        } else {
          polygonUseFallback = false;
          value = { ok: false, reason: primaryHealth.reason === 'chain_id_mismatch' ? primaryHealth.reason : fallbackHealth.reason };
        }
      }
    } else {
      try {
        const payload = await upstreamRpc(key, 'eth_chainId', []);
        const actual = payload && typeof payload.result === 'string' ? Number.parseInt(payload.result, 16) : NaN;
        value = actual === chain.chainId ? { ok: true } : { ok: false, reason: 'chain_id_mismatch' };
      } catch {
        value = { ok: false, reason: 'rpc_unreachable' };
      }
    }
    verifiedCache.set(key, { at: now(), value });
    return value;
  }

  async function config(req) {
    if (req.method !== 'GET') return out(405, { error: 'method_not_allowed' });
    if (over('cfg', req)) return out(429, { error: 'rate_limited' });
    const chains = {};
    await Promise.all(Object.keys(CHAINS).map(async key => {
      const chain = CHAINS[key];
      const check = await verified(key);
      chains[key] = {
        chainId: chain.chainId,
        rpc: check.ok,
        swap: !!(check.ok && env.ZEROX_API_KEY && SWAP_CHAINS.has(chain.chainId)),
        reason: check.ok ? '' : check.reason
      };
    }));
    return out(200, { ok: true, chains });
  }

  async function rpc(req) {
    if (req.method !== 'POST') return out(405, { error: 'method_not_allowed' });
    if (over('rpc', req)) return out(429, { error: 'rate_limited' });
    const key = String((req.query && req.query.chain) || '');
    if (!Object.prototype.hasOwnProperty.call(CHAINS, key)) return out(400, { error: 'unknown_chain' });
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string') {
      return out(400, { error: 'bad_request' });
    }
    if (!RPC_ALLOW.has(body.method)) return out(403, { error: 'method_not_allowed', method: body.method });
    const params = Array.isArray(body.params) ? body.params : [];
    if (JSON.stringify(params).length > 70000) return out(413, { error: 'too_large' });
    const check = await verified(key);
    if (!check.ok) return out(503, { error: 'chain_unavailable', reason: check.reason });
    try {
      const payload = await upstreamRpc(key, body.method, params);
      return out(200, {
        jsonrpc: '2.0',
        id: body.id == null ? 1 : body.id,
        ...(payload.result !== undefined ? { result: payload.result } : {}),
        ...(payload.error !== undefined ? { error: payload.error } : {})
      });
    } catch {
      return out(502, { error: 'upstream_failed' });
    }
  }

  async function market(req) {
    if (req.method !== 'GET') return out(405, { error: 'method_not_allowed' });
    if (over('market', req)) return out(429, { error: 'rate_limited' });
    const q=req.query||{}, key=String(q.chain||''), token=String(q.token||''), pair=String(q.pair||'');
    if(key!=='robinhood') return out(400,{error:'unsupported_chain_market'});
    if(!ADDR.test(token)||!ADDR.test(pair)||token.toLowerCase()===ADDR_ZERO) return out(400,{error:'bad_params'});
    const check=await verified(key); if(!check.ok) return out(503,{error:'chain_unavailable',reason:check.reason});
    const call=async(to,data)=>{const p=await upstreamRpc(key,'eth_call',[{to,data},'latest']);if(typeof p.result!=='string'||!/^0x[0-9a-fA-F]+$/.test(p.result))throw new Error('bad_call_result');return p.result};
    try {
      const [t0h,t1h]=await Promise.all([call(pair,SEL.token0),call(pair,SEL.token1)]);
      const t0=readAddress(t0h),t1=readAddress(t1h),ta=token.toLowerCase();
      if(t0!==ta&&t1!==ta) return out(400,{error:'token_not_in_pool'});
      const quote=t0===ta?t1:t0;
      if(quote!==RH_WETH) return out(200,{ok:false,error:'unsupported_quote_asset',message:'Only verified WETH-quoted Robinhood V3 pools are currently supported.'});
      // Verify the supplied pool against the canonical factory at each supported fee tier.
      let verifiedPool=false;
      for(const fee of [100,500,3000,10000]){
        const a=t0,b=t1; /* the pool's own token0/token1 are already sorted; deriving the pair from the requested token broke the lookup when that token was token1 */
        const data='0x1698ee82'+a.slice(2).padStart(64,'0')+b.slice(2).padStart(64,'0')+hexWord(fee);
        const result=await call(RH_V3_FACTORY,data);
        if(readAddress(result)===pair.toLowerCase()){verifiedPool=true;break;}
      }
      if(!verifiedPool)return out(403,{error:'unverified_pool'});
      const [d0h,d1h,supplyH,slotH]=await Promise.all([call(t0,SEL.decimals),call(t1,SEL.decimals),call(token,SEL.totalSupply),call(pair,SEL.slot0)]);
      const d0=Number(readWord(d0h)),d1=Number(readWord(d1h));
      if(!Number.isInteger(d0)||!Number.isInteger(d1)||d0>36||d1>36)return out(502,{error:'invalid_token_decimals'});
      const raw=readWord(slotH),sqrt=raw & ((1n<<160n)-1n);
      if(sqrt===0n)return out(200,{ok:false,error:'empty_pool'});
      // Uniswap V3 sqrtPriceX96 gives token1/token0; use integer arithmetic until final conversion.
      const Q192=1n<<192n, ratio=Number((sqrt*sqrt*1000000000000000000n)/Q192)/1e18;
      const price1Per0=ratio*Math.pow(10,d0-d1);
      const priceTokenWeth=t0===ta?price1Per0:1/price1Per0;
      if(!Number.isFinite(priceTokenWeth)||priceTokenWeth<=0)return out(502,{error:'invalid_pool_price'});
      const ethRes=await timedFetch('https://api.coinbase.com/v2/prices/ETH-USD/spot',{headers:{accept:'application/json'}},7000);
      if(!ethRes.ok)throw new Error('quote_price_unavailable');
      const ethJson=await ethRes.json(),ethUsd=Number(ethJson?.data?.amount);
      if(!Number.isFinite(ethUsd)||ethUsd<=0)throw new Error('quote_price_invalid');
      const tokenDecimals=t0===ta?d0:d1;
      const price=priceTokenWeth*ethUsd,supply=Number(readWord(supplyH))/Math.pow(10,tokenDecimals);
      const fdv=price*supply;
      if(!Number.isFinite(price)||!Number.isFinite(fdv)||price<=0||fdv<=0)return out(502,{error:'invalid_market_value'});
      return out(200,{ok:true,chain:key,token:ta,pair:pair.toLowerCase(),price,mc:fdv,fdv:true,mcKind:'fdv',supply,source:'robinhood-v3-onchain',quoteAsset:RH_WETH,quoteUsd:ethUsd,updatedAt:new Date(now()).toISOString()});
    } catch(e) { return out(502,{error:'market_unavailable',reason:String(e?.message||'market_read_failed').slice(0,100)}); }
  }

  async function quote(req) {
    if (req.method !== 'GET') return out(405, { error: 'method_not_allowed' });
    if (over('quote', req)) return out(429, { error: 'rate_limited' });
    const query = req.query || {};
    const key = String(query.chain || '');
    if (!Object.prototype.hasOwnProperty.call(CHAINS, key)) return out(400, { error: 'unknown_chain' });
    const chain = CHAINS[key];
    if (!env.ZEROX_API_KEY) return out(503, { error: 'swap_not_configured' });
    if (!SWAP_CHAINS.has(chain.chainId)) return out(503, { error: 'swap_not_supported' });

    const normalizeToken = value => String(value).toUpperCase() === 'NATIVE' ? NATIVE : String(value);
    const sellToken = normalizeToken(query.sellToken || '');
    const buyToken = normalizeToken(query.buyToken || '');
    const taker = String(query.taker || '');
    const sellAmount = String(query.sellAmount || '');
    if (!ADDR.test(sellToken) || !ADDR.test(buyToken) || !ADDR.test(taker) ||
        !UINT.test(sellAmount) || BigInt(sellAmount) <= 0n) {
      return out(400, { error: 'bad_params' });
    }
    if (sellToken.toLowerCase() === buyToken.toLowerCase()) return out(400, { error: 'same_token' });

    const slippageBps = Math.max(1, Math.min(1000, Number.parseInt(query.slippageBps, 10) || 100));
    const mode = query.mode === 'quote' ? 'quote' : 'price';
    const check = await verified(key);
    if (!check.ok) return out(503, { error: 'chain_unavailable', reason: check.reason });

    const url = new URL('https://api.0x.org/swap/allowance-holder/' + mode);
    url.searchParams.set('chainId', String(chain.chainId));
    url.searchParams.set('sellToken', sellToken);
    url.searchParams.set('buyToken', buyToken);
    url.searchParams.set('sellAmount', sellAmount);
    url.searchParams.set('taker', taker);
    url.searchParams.set('slippageBps', String(slippageBps));

    let response, payload;
    try {
      response = await timedFetch(url.toString(), {
        headers: { '0x-api-key': env.ZEROX_API_KEY, '0x-version': 'v2' }
      }, 12000);
      payload = await response.json();
    } catch {
      return out(502, { error: 'quote_upstream_failed' });
    }
    if (!response.ok) {
      return out(200, {
        ok: false,
        error: 'no_route',
        message: String((payload && (payload.reason || payload.message || payload.data?.message)) || 'No route found').slice(0, 200)
      });
    }
    if (payload.liquidityAvailable === false) {
      return out(200, { ok: false, error: 'no_liquidity', message: 'No liquidity found for this token on this network.' });
    }

    const transaction = payload.transaction || null;
    const allowance = payload.issues?.allowance || null;
    return out(200, {
      ok: true,
      mode,
      chain: key,
      chainId: chain.chainId,
      sellToken,
      buyToken,
      sellAmount: String(payload.sellAmount || sellAmount),
      buyAmount: String(payload.buyAmount || ''),
      minBuyAmount: String(payload.minBuyAmount || ''),
      totalNetworkFee: payload.totalNetworkFee == null ? null : String(payload.totalNetworkFee),
      allowance: allowance ? { spender: String(allowance.spender || '') } : null,
      balanceIssue: payload.issues?.balance ? {
        actual: String(payload.issues.balance.actual),
        expected: String(payload.issues.balance.expected)
      } : null,
      transaction: mode === 'quote' && transaction ? {
        to: transaction.to,
        data: transaction.data,
        value: String(transaction.value || '0'),
        gas: transaction.gas == null ? null : String(transaction.gas),
        gasPrice: transaction.gasPrice == null ? null : String(transaction.gasPrice)
      } : null
    });
  }

  return Object.freeze({ config, rpc, quote, market, verified, _clear: () => verifiedCache.clear() });
}
