// Saturn EVM market-data cache proxy.
// Public read-only endpoint. Provider responses are cached briefly and concurrent
// requests for the same chain/token are collapsed into one upstream request.
const CHAINS = Object.freeze({
  eth: "ethereum",
  base: "base",
  arb: "arbitrum",
  poly: "polygon",
  bsc: "bsc"
});
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CACHE_TTL = 8_000;
const STALE_TTL = 120_000;
const MAX_CACHE = 1500;
const cache = globalThis.__saturnEvmMarketCache || (globalThis.__saturnEvmMarketCache = new Map());
const inflight = globalThis.__saturnEvmMarketInflight || (globalThis.__saturnEvmMarketInflight = new Map());

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}
function allowedOrigins() {
  return new Set([
    ...(process.env.SATURN_ALLOWED_ORIGINS || "").split(","),
    ...(process.env.SATURN_EXTRA_ALLOWED_ORIGINS || "").split(",")
  ].map(x => x.trim()).filter(Boolean));
}
function originAllowed(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins().has(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type");
  return true;
}
async function loadPair(chain, token) {
  const url = `https://api.dexscreener.com/tokens/v1/${CHAINS[chain]}/${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("provider_invalid_shape");
    const matches = rows.filter(p =>
      p &&
      p.chainId === CHAINS[chain] &&
      p.baseToken &&
      String(p.baseToken.address || "").toLowerCase() === token.toLowerCase()
    );
    matches.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    if (!matches.length) throw new Error("pair_not_found");
    return matches[0];
  } finally {
    clearTimeout(timer);
  }
}
export default async function handler(req, res) {
  if (!originAllowed(req, res)) return send(res, 403, { ok: false, error: "origin_not_allowed" });
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });
  const chain = String(req.query?.chain || "");
  const token = String(req.query?.token || "");
  if (!Object.prototype.hasOwnProperty.call(CHAINS, chain) || !ADDRESS.test(token)) {
    return send(res, 400, { ok: false, error: "bad_params" });
  }
  const key = `${chain}:${token.toLowerCase()}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL) {
    return send(res, 200, { ok: true, chain, token: token.toLowerCase(), pair: cached.pair, updatedAt: new Date(cached.at).toISOString(), cache: "hit" });
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = loadPair(chain, token).then(pair => {
      const record = { pair, at: Date.now() };
      cache.set(key, record);
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      return record;
    });
    inflight.set(key, pending);
    pending.finally(() => { if (inflight.get(key) === pending) inflight.delete(key); }).catch(() => {});
  }
  try {
    const record = await pending;
    return send(res, 200, { ok: true, chain, token: token.toLowerCase(), pair: record.pair, updatedAt: new Date(record.at).toISOString(), cache: "miss" });
  } catch (error) {
    if (cached && now - cached.at < STALE_TTL) {
      return send(res, 200, { ok: true, chain, token: token.toLowerCase(), pair: cached.pair, updatedAt: new Date(cached.at).toISOString(), cache: "stale" });
    }
    return send(res, 502, { ok: false, error: "market_unavailable", reason: String(error?.message || "provider_failed").slice(0, 100) });
  }
}
