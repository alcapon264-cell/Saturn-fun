/* Saturn LI.FI proxy.
 * Quotes and transfer status only. This service never signs, submits, or holds wallet keys.
 * All requests are routed through Saturn's authenticated/CORS/rate-limit guard in lib/app.js.
 */
const BASE = 'https://li.quest/v1/';
const SOLANA_CHAIN_ID = '1151111081099710';
const EVM_CHAINS = new Set(['1', '8453', '42161', '137', '4663', '56']);
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]{1,78}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOL_TX = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const out = (status, body) => ({ status, body });

export const LIFI_CHAIN_IDS = Object.freeze({
  solana: SOLANA_CHAIN_ID,
  ethereum: '1',
  base: '8453',
  arbitrum: '42161',
  polygon: '137',
  robinhood: '4663',
  bnb: '56'
});

function validAddress(chain, address) {
  return chain === SOLANA_CHAIN_ID
    ? SOLANA_ADDRESS.test(address)
    : (EVM_CHAINS.has(chain) && EVM_ADDRESS.test(address));
}

export function createLifi({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, limiter = () => false } = {}) {
  async function request(path, params) {
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const headers = { accept: 'application/json' };
      if (env.LIFI_API_KEY) headers['x-lifi-api-key'] = env.LIFI_API_KEY;
      const response = await fetchImpl(url.toString(), { method: 'GET', headers, signal: controller.signal });
      let payload;
      try { payload = await response.json(); } catch { return out(502, { ok: false, error: 'invalid_provider_response' }); }
      if (!response.ok) {
        const message = String(payload?.message || payload?.error || 'LI.FI request failed').slice(0, 180);
        if (response.status === 400 || response.status === 404) return out(200, { ok: false, error: 'no_route', message });
        if (response.status === 429) return out(429, { ok: false, error: 'provider_rate_limited' });
        return out(502, { ok: false, error: 'provider_unavailable', message });
      }
      return out(200, payload);
    } catch (error) {
      return out(502, { ok: false, error: error?.name === 'AbortError' ? 'provider_timeout' : 'provider_unavailable' });
    } finally {
      clearTimeout(timer);
    }
  }

  async function quote(req) {
    if (req.method !== 'GET') return out(405, { ok: false, error: 'method_not_allowed' });
    if (limiter('lifi-quote', req.ip || '', 30, 60000, now())) return out(429, { ok: false, error: 'rate_limited' });
    const q = req.query || {};
    const fromChain = String(q.fromChain || '');
    const toChain = String(q.toChain || '');
    const fromToken = String(q.fromToken || '');
    const toToken = String(q.toToken || '');
    const fromAddress = String(q.fromAddress || '');
    const toAddress = String(q.toAddress || '');
    const fromAmount = String(q.fromAmount || '');
    if ((!EVM_CHAINS.has(fromChain) && fromChain !== SOLANA_CHAIN_ID) ||
        (!EVM_CHAINS.has(toChain) && toChain !== SOLANA_CHAIN_ID)) {
      return out(400, { ok: false, error: 'unsupported_chain' });
    }
    if (fromChain === toChain) return out(400, { ok: false, error: 'cross_chain_only' });
    if (!validAddress(fromChain, fromAddress) || !validAddress(toChain, toAddress)) {
      return out(400, { ok: false, error: 'invalid_wallet_address' });
    }
    const nativeSol = '11111111111111111111111111111111';
    const nativeEvm = '0x0000000000000000000000000000000000000000';
    if (!(fromChain === SOLANA_CHAIN_ID ? (SOLANA_ADDRESS.test(fromToken) || fromToken === nativeSol) : (EVM_ADDRESS.test(fromToken) || fromToken === nativeEvm)) ||
        !(toChain === SOLANA_CHAIN_ID ? (SOLANA_ADDRESS.test(toToken) || toToken === nativeSol) : (EVM_ADDRESS.test(toToken) || toToken === nativeEvm))) {
      return out(400, { ok: false, error: 'invalid_token_address' });
    }
    if (!UINT.test(fromAmount) || BigInt(fromAmount) <= 0n) return out(400, { ok: false, error: 'invalid_amount' });
    const slippage = q.slippage == null || q.slippage === '' ? '0.03' : String(q.slippage);
    const slip = Number(slippage);
    if (!Number.isFinite(slip) || slip < 0.001 || slip > 0.5) return out(400, { ok: false, error: 'invalid_slippage' });
    const result = await request('quote', {
      fromChain, toChain, fromToken, toToken, fromAddress, toAddress,
      fromAmount, slippage, integrator: String(env.LIFI_INTEGRATOR || 'Saturn'), fee: '0.01'
    });
    if (result.status !== 200) return result;
    const data = result.body;
    if (data && data.ok === false) return result;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.transactionRequest || !data.estimate) {
      return out(200, { ok: false, error: 'no_executable_route', message: 'LI.FI did not return an executable route for this selection.' });
    }
    return out(200, { ok: true, provider: 'LI.FI', quote: data, receivedAt: now() });
  }

  async function status(req) {
    if (req.method !== 'GET') return out(405, { ok: false, error: 'method_not_allowed' });
    if (limiter('lifi-status', req.ip || '', 90, 60000, now())) return out(429, { ok: false, error: 'rate_limited' });
    const q = req.query || {};
    const txHash = String(q.txHash || '');
    const fromChain = String(q.fromChain || '');
    const toChain = String(q.toChain || '');
    if (!(TX_HASH.test(txHash) || SOL_TX.test(txHash))) return out(400, { ok: false, error: 'invalid_transaction_hash' });
    if ((!EVM_CHAINS.has(fromChain) && fromChain !== SOLANA_CHAIN_ID) ||
        (!EVM_CHAINS.has(toChain) && toChain !== SOLANA_CHAIN_ID) || fromChain === toChain) {
      return out(400, { ok: false, error: 'unsupported_chain' });
    }
    return request('status', { txHash, fromChain, toChain, bridge: q.bridge || undefined });
  }

  return Object.freeze({ quote, status });
}
