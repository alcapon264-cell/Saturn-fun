// Privy access-token verification, done locally with node:crypto against the app's PUBLIC verification key (no Privy secret is needed or used).
// Privy access tokens are ES256 JWTs: iss "privy.io", aud = your Privy App ID, sub = the user's Privy DID ("did:privy:...").
import crypto from 'node:crypto';
const dec = s => Buffer.from(s, 'base64url');
export function peekIssuer(token) { try { const p = String(token).split('.'); return p.length === 3 ? (JSON.parse(dec(p[1]).toString('utf8')).iss || null) : null; } catch { return null; } } // routing hint ONLY; every path fully verifies
export function loadVerificationKey(pem) { // fail closed on anything that is not a P-256 EC public key
  if (!pem) return null;
  try { const key = crypto.createPublicKey(String(pem).replace(/\\n/g, '\n')), d = key.asymmetricKeyDetails;
    return key.type === 'public' && key.asymmetricKeyType === 'ec' && d && d.namedCurve === 'prime256v1' ? key : null; } catch { return null; }
}
export function verifyPrivyToken(token, { appId, key, now = Date.now, leewaySec = 30 }) {
  try {
    const parts = String(token).split('.'); if (parts.length !== 3 || !appId || !key) return null;
    const header = JSON.parse(dec(parts[0]).toString('utf8')), p = JSON.parse(dec(parts[1]).toString('utf8'));
    if (header.alg !== 'ES256') return null;                                                    // no "none", no HS256 key-confusion
    const sig = dec(parts[2]); if (sig.length !== 64) return null;
    if (!crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key, dsaEncoding: 'ieee-p1363' }, sig)) return null;
    const t = Math.floor(now() / 1000), aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (p.iss !== 'privy.io' || !aud.includes(appId)) return null;
    if (typeof p.exp !== 'number' || p.exp + leewaySec <= t) return null;                      // expired (exp is required)
    if (typeof p.iat === 'number' && p.iat - leewaySec > t) return null;                       // issued in the future
    if (typeof p.sub !== 'string' || !/^did:privy:[A-Za-z0-9]+$/.test(p.sub)) return null;
    return { uid: p.sub, provider: 'privy', email: null, sid: p.sid || null };
  } catch { return null; }
}
