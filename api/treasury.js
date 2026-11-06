const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(value) {
  let n = 0n;
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error('invalid_base58');
    n = n * 58n + BigInt(digit);
  }

  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }

  let leadingZeros = 0;
  for (const char of value) {
    if (char !== '1') break;
    leadingZeros++;
  }
  return Uint8Array.from([...new Array(leadingZeros).fill(0), ...bytes]);
}

function getTreasuryWallet() {
  const value = process.env.PLATFORM_TREASURY_WALLET;
  if (typeof value !== 'string' || !value.trim()) return null;

  const address = value.trim();
  try {
    const decoded = decodeBase58(address);
    if (decoded.length !== 32) return null;
    return address;
  } catch {
    return null;
  }
}

function allowedOrigins() {
  const raw = [
    process.env.SATURN_ALLOWED_ORIGINS,
    process.env.SATURN_EXTRA_ALLOWED_ORIGINS
  ].filter(Boolean).join(',');

  return new Set(
    raw.split(',')
      .map(origin => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  );
}

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const origin = typeof req.headers.origin === 'string'
    ? req.headers.origin.replace(/\/+$/, '')
    : '';

  const origins = allowedOrigins();
  if (origin && origins.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    if (origin && !origins.has(origin)) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ ok: false, error: 'origin_not_allowed' }));
    }
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('allow', 'GET, OPTIONS');
    return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
  }

  const treasuryWallet = getTreasuryWallet();
  if (!treasuryWallet) {
    res.statusCode = 503;
    return res.end(JSON.stringify({
      ok: false,
      error: 'treasury_wallet_not_configured_or_invalid'
    }));
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, treasuryWallet }));
}
