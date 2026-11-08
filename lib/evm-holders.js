// Routescan-backed EVM token holders. The keyless Routescan Data API is free;
// ROUTESCAN_API_KEY is optional and must remain server-side if configured.
// Routescan's currently published supported-chain catalog confirms Ethereum.
// Saturn's Base, Arbitrum, Polygon and BNB aliases are intentionally reported
// unsupported until Routescan lists/indexes them for this endpoint.
const CHAINS = Object.freeze({ eth: '1' });
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const BASE = 'https://api.routescan.io/v2/network/mainnet/evm';

function cursorFrom(link) {
  if (!link || typeof link !== 'object') return null;
  if (typeof link.nextToken === 'string' && link.nextToken) return link.nextToken;
  if (typeof link.next === 'string' && link.next) {
    try {
      const u = new URL(link.next, BASE);
      return u.searchParams.get('next') || u.searchParams.get('nextToken') || link.next;
    } catch {
      return link.next;
    }
  }
  return null;
}

export async function evmHolders({ chain, token, limit, cursor }, { env = process.env, fetchImpl = fetch } = {}) {
  if (!Object.prototype.hasOwnProperty.call(CHAINS, chain)) {
    return { status: 200, body: { ok: false, error: 'unsupported_chain' } };
  }
  if (!ADDR.test(token || '')) return { status: 400, body: { ok: false, error: 'bad_token' } };

  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const q = new URLSearchParams({ limit: String(lim) });
  if (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048) q.set('next', cursor);
  const url = `${BASE}/${CHAINS[chain]}/erc20/${token}/holders?${q}`;
  const headers = { accept: 'application/json' };
  if (typeof env.ROUTESCAN_API_KEY === 'string' && env.ROUTESCAN_API_KEY.trim()) {
    headers.apikey = env.ROUTESCAN_API_KEY.trim();
  }

  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    return { status: 200, body: { ok: false, error: 'provider_unreachable' } };
  }
  if (!response || !response.ok) {
    return { status: 200, body: { ok: false, error: response && response.status === 429 ? 'provider_rate_limited' : 'provider_error' } };
  }

  let data;
  try { data = await response.json(); }
  catch { return { status: 200, body: { ok: false, error: 'provider_bad_response' } }; }
  if (!data || !Array.isArray(data.items)) {
    return { status: 200, body: { ok: false, error: 'provider_bad_response' } };
  }

  const holders = [];
  for (const item of data.items) {
    if (!item || !ADDR.test(item.address || '') || typeof item.balance !== 'string' || !/^\d+$/.test(item.balance)) {
      return { status: 200, body: { ok: false, error: 'provider_bad_response' } };
    }
    const holder = { address: item.address, balance: item.balance };
    if (typeof item.percentage === 'number' && Number.isFinite(item.percentage)) holder.percentage = item.percentage;
    holders.push(holder);
  }

  return {
    status: 200,
    body: {
      ok: true,
      holders,
      nextCursor: cursorFrom(data.link)
    }
  };
}
