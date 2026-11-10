// Saturn BNB Chain holders adapter. Called only behind lib/app.js shared guard.
// Public on-chain holder data follows the same public-access policy as /api/evm-holders.
// GOLDRUSH_API_KEY is server-side only.
const CHAIN_NAME = 'bsc-mainnet';
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const BASE = 'https://api.covalenthq.com/v1';
const UPSTREAM_PAGE_SIZE = 100; // GoldRush Token Holders V2 supports 100 or 1,000 rows per page.
const cache = new Map();
const inflight = new Map();
const TTL_MS = 30_000;
const MAX_PAGE = 2000;

const result = (status, body, headers = {}) => ({ status, body, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', ...headers
} });
const digits = value => typeof value === 'string' && /^\d+$/.test(value);

function parseCursor(value) {
  if (value == null || value === '') return { page: 0, offset: 0 };
  const raw = String(value);
  // Numeric cursors from the previous adapter remain valid (start at that GoldRush page).
  if (/^\d{1,4}$/.test(raw)) {
    const page = Number(raw);
    return page <= MAX_PAGE ? { page, offset: 0 } : null;
  }
  // New cursor: "page:offset". Offset divides GoldRush's 100 rows into Saturn's 50-row pages.
  const match = /^(\d{1,4}):(\d{1,3})$/.exec(raw);
  if (!match) return null;
  const page = Number(match[1]), offset = Number(match[2]);
  if (page > MAX_PAGE || offset >= UPSTREAM_PAGE_SIZE) return null;
  return { page, offset };
}

function parseProvider(payload) {
  const data = payload && payload.data;
  if (!data || payload.error === true || !Array.isArray(data.items)) return null;
  const holders = [];
  for (const item of data.items) {
    if (!item || !ADDR.test(item.address || '') || !digits(String(item.balance ?? ''))) return null;
    // Preserve the provider's raw row order for offset-based paging; the browser filters zero balances.
    holders.push({ address: item.address, balance: String(item.balance) });
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
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 50));
  const cursor = parseCursor(query.cursor);
  if (!cursor) return result(400, { ok: false, error: 'invalid_cursor' });
  const { page, offset } = cursor;
  // Cache/in-flight keys are per upstream GoldRush page, not per Saturn slice.
  const cacheKey = `${token.toLowerCase()}:${page}`;
  let parsed = null;
  const cached = cache.get(cacheKey);
  if (cached && now() - cached.at < TTL_MS) {
    parsed = cached.parsed;
  } else {
    let task = inflight.get(cacheKey);
    if (!task) {
      task = (async () => {
        // Token Holders V2 supports page-size 100 or 1,000. `no-spam` is not a parameter for this endpoint.
        const url = `${BASE}/${CHAIN_NAME}/tokens/${token}/token_holders_v2/?page-size=${UPSTREAM_PAGE_SIZE}&page-number=${page}`;
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
          return { error: result(502, { ok: false, error: 'provider_unreachable' }) };
        }
        if (response.status === 429) {
          const raw = Number.parseInt(response.headers?.get?.('retry-after') || '5', 10);
          return { error: result(429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(Number.isFinite(raw) ? Math.min(60, Math.max(1, raw)) : 5) }) };
        }
        if (response.status === 401 || response.status === 403) return { error: result(502, { ok: false, error: 'provider_auth' }) };
        if (response.status === 404) return { error: result(404, { ok: false, error: 'unsupported_token' }) };
        if (response.status === 402) return { error: result(503, { ok: false, error: 'provider_credits_exhausted' }) };
        if (response.status === 400) return { error: result(502, { ok: false, error: 'provider_bad_request' }) };
        if (response.status >= 500) return { error: result(502, { ok: false, error: 'provider_unavailable' }) };
        if (!response.ok) return { error: result(502, { ok: false, error: 'provider_http_' + response.status }) };
        let payload;
        try { payload = await response.json(); } catch { return { error: result(502, { ok: false, error: 'bad_provider_response' }) }; }
        const data = parseProvider(payload);
        if (!data) return { error: result(502, { ok: false, error: 'bad_provider_response' }) };
        cache.set(cacheKey, { at: now(), parsed: data });
        if (cache.size > 400) cache.delete(cache.keys().next().value);
        return { parsed: data };
      })();
      inflight.set(cacheKey, task);
    }
    let fetched;
    try { fetched = await task; }
    finally { if (inflight.get(cacheKey) === task) inflight.delete(cacheKey); }
    if (fetched.error) return fetched.error;
    parsed = fetched.parsed;
  }

  const pageRows = parsed.holders.slice(offset, offset + limit);
  let nextCursor = null;
  if (offset + limit < parsed.holders.length) nextCursor = `${page}:${offset + limit}`;
  else if (parsed.hasMore) nextCursor = `${page + 1}:0`;
  return result(200, {
    ok: true, chain: 'bsc', token: token.toLowerCase(), holders: pageRows,
    decimals: parsed.decimals, totalSupply: parsed.totalSupply,
    totalHolders: parsed.totalHolders, nextCursor
  });
}

export const _test = { cache, inflight, parseProvider, parseCursor, CHAIN_NAME, UPSTREAM_PAGE_SIZE };
