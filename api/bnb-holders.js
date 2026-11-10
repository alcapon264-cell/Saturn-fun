// Saturn BNB Chain token holders adapter (Vercel serverless function).
// Required server-side environment variables:
//   GOLDRUSH_API_KEY  - GoldRush/Covalent API key; never expose this in the HTML.
//   ALLOWED_ORIGINS   - comma-separated exact Saturn web origins.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 24;
const rate = new Map();

function send(res, status, body) {
  res.status(status).json(body);
}
function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || '')
    .split(/[,;\s]+/).map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
}
function cors(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  const allowed = allowedOrigins();
  if (!origin || !allowed.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Saturn-Session');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}
function rateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let r = rate.get(ip);
  if (!r || now - r.start >= WINDOW_MS) r = { start: now, count: 0 };
  r.count += 1;
  rate.set(ip, r);
  if (rate.size > 5000) {
    for (const [k, v] of rate) if (now - v.start >= WINDOW_MS) rate.delete(k);
  }
  return r.count <= MAX_REQUESTS;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    if (!cors(req, res)) return send(res, 403, { ok: false, error: 'origin_not_allowed' });
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  if (!cors(req, res)) return send(res, 403, { ok: false, error: 'origin_not_allowed' });
  if (!rateLimit(req)) return send(res, 429, { ok: false, error: 'rate_limited' });

  const apiKey = String(process.env.GOLDRUSH_API_KEY || '').trim();
  if (!apiKey) return send(res, 503, { ok: false, error: 'provider_not_configured' });

  const token = String(req.query?.token || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return send(res, 400, { ok: false, error: 'invalid_token_address' });
  }
  // GoldRush returns fixed pages of 100. Saturn displays 50 holders per page,
  // so the cursor carries both the upstream page and the offset within it.
  const rawCursor = String(req.query?.cursor || '0:0');
  if (!/^\d{1,3}:\d{1,3}$/.test(rawCursor)) {
    return send(res, 400, { ok: false, error: 'invalid_cursor' });
  }
  const [page, offset] = rawCursor.split(':').map(Number);
  if (!Number.isSafeInteger(page) || page < 0 || page > 999 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 99) {
    return send(res, 400, { ok: false, error: 'invalid_cursor' });
  }

  const url = new URL(
    `https://api.covalenthq.com/v1/bsc-mainnet/tokens/${token}/token_holders_v2/`
  );
  url.searchParams.set('page-number', String(page));
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let upstream;
    try {
      upstream = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    let payload = null;
    try { payload = await upstream.json(); } catch (_) {}
    if (!upstream.ok || !payload || payload.error || !payload.data) {
      const status = upstream.status === 429 ? 503 : 502;
      return send(res, status, {
        ok: false,
        error: upstream.status === 429 ? 'provider_rate_limited' : 'provider_error'
      });
    }

    const data = payload.data;
    const items = Array.isArray(data.items) ? data.items : [];
    const holders = [];
    const visibleItems = items.slice(offset, offset + 50);
    for (const item of visibleItems) {
      const address = String(item?.address || '');
      const balance = String(item?.balance ?? '');
      if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^\d+$/.test(balance)) continue;
      if (BigInt(balance) > 0n) holders.push({ address, balance });
    }

    const first = items.find(x => x && typeof x === 'object') || {};
    const pagination = data.pagination && typeof data.pagination === 'object' ? data.pagination : {};
    const decimals = Number(first.contract_decimals);
    const totalSupply = /^\d+$/.test(String(first.total_supply || '')) ? String(first.total_supply) : null;
    const totalHolders = Number.isSafeInteger(Number(pagination.total_count))
      ? Number(pagination.total_count) : null;
    const hasMore = offset + 50 < items.length || pagination.has_more === true;
    const nextCursor = offset + 50 < items.length
      ? `${page}:${offset + 50}`
      : (pagination.has_more === true ? `${page + 1}:0` : null);
    return send(res, 200, {
      ok: true,
      holders,
      totalSupply,
      decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null,
      totalHolders,
      nextCursor: hasMore ? nextCursor : null
    });
  } catch (error) {
    return send(res, 502, {
      ok: false,
      error: error?.name === 'AbortError' ? 'provider_timeout' : 'provider_unavailable'
    });
  }
};
