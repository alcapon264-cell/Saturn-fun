// Saturn BNB Chain holders adapter. Called only behind lib/app.js shared guard.
// Public on-chain holder data follows the same public-access policy as /api/evm-holders.
// GOLDRUSH_API_KEY is server-side only.
const CHAIN_NAME = 'bsc-mainnet';
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const BASE = 'https://api.covalenthq.com/v1';
const cache = new Map();
const inflight = new Map();
const TTL_MS = 30_000;
const MAX_PAGE = 2000;

const result = (status, body, headers = {}) => ({ status, body, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', ...headers
} });
const digits = value => typeof value === 'string' && /^\d+$/.test(value);

function parseProvider(payload) {
  const data = payload && payload.data;
  if (!data || !Array.isArray(data.items)) return null;
  const holders = [];
  for (const item of data.items) {
    if (!item || !ADDR.test(item.address || '') || !digits(String(item.balance ?? ''))) return null;
    if (BigInt(String(item.balance)) > 0n) holders.push({ address: item.address, balance: String(item.balance) });
  }
  const first = data.items[0] || {};
  const pagination = data.pagination || {};
  return {
    holders,
    decimals: Number.isInteger(first.contract_decimals) && first.contract_decimals >= 0 && first.contract_decimals <= 36 ? first.contract_decimals : null,
    totalSupply: digits(String(first.total_supply ?? '')) ? String(first.total_supply) : null,
    totalHolders: Number.isInteger(pagination.total_count) && pagination.total_count >= 0 ? pagination.total_count : null,
    hasMore: pagination.has_more === true
  };
}

export async function bnbHolders({ query = {}, env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const key = typeof env.GOLDRUSH_API_KEY === 'string' ? env.GOLDRUSH_API_KEY.trim() : '';
  if (!key) return result(503, { ok: false, error: 'not_configured' });
  const token = String(query.token || '');
  if (!ADDR.test(token)) return result(400, { ok: false, error: 'invalid_token' });
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 50));
  let page = 0;
  if (query.cursor != null && query.cursor !== '') {
    if (!/^\d{1,4}$/.test(String(query.cursor))) return result(400, { ok: false, error: 'invalid_cursor' });
    page = Number(query.cursor);
    if (page > MAX_PAGE) return result(400, { ok: false, error: 'invalid_cursor' });
  }
  const cacheKey = `${token.toLowerCase()}:${page}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && now() - cached.at < TTL_MS) return cached.value;
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const task = (async () => {
    const url = `${BASE}/${CHAIN_NAME}/tokens/${token}/token_holders_v2/?page-size=${limit}&page-number=${page}&no-spam=false`;
    let response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: controller.signal
        });
      } finally { clearTimeout(timeout); }
    } catch {
      return result(502, { ok: false, error: 'provider_unreachable' });
    }
    if (response.status === 429) {
      const raw = Number.parseInt(response.headers?.get?.('retry-after') || '5', 10);
      return result(429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(Number.isFinite(raw) ? Math.min(60, Math.max(1, raw)) : 5) });
    }
    if (response.status === 401 || response.status === 403) return result(502, { ok: false, error: 'provider_auth' });
    if (response.status === 404) return result(404, { ok: false, error: 'unsupported_token' });
    if (response.status >= 500) return result(502, { ok: false, error: 'provider_error' });
    if (!response.ok) return result(502, { ok: false, error: 'provider_error' });
    let payload;
    try { payload = await response.json(); } catch { return result(502, { ok: false, error: 'bad_provider_response' }); }
    const parsed = parseProvider(payload);
    if (!parsed) return result(502, { ok: false, error: 'bad_provider_response' });
    const value = result(200, {
      ok: true, chain: 'bsc', token: token.toLowerCase(), holders: parsed.holders,
      decimals: parsed.decimals, totalSupply: parsed.totalSupply,
      totalHolders: parsed.totalHolders, nextCursor: parsed.hasMore ? String(page + 1) : null
    });
    cache.set(cacheKey, { at: now(), value });
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return value;
  })();
  inflight.set(cacheKey, task);
  try { return await task; }
  finally { if (inflight.get(cacheKey) === task) inflight.delete(cacheKey); }
}

export const _test = { cache, inflight, parseProvider, CHAIN_NAME };
