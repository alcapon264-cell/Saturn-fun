import crypto from 'node:crypto';

const TREASURY = '7XGVo8SdqUeTP7dFgj3xC7PcmMA6wet4srqnSqnjCSSv';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error('bad_base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  let z = 0;
  for (const c of str) { if (c === '1') z++; else break; }
  return Uint8Array.from([...new Array(z).fill(0), ...out]);
}

const P = (1n << 255n) - 19n;
function modpow(b, e, m) { let r = 1n; b %= m; while (e) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
const D = (P - (121665n * modpow(121666n, P - 2n, P)) % P) % P;
function isOnCurve(bytes32) {
  const b = Uint8Array.from(bytes32); b[31] &= 0x7f;
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = y * y % P, num = (y2 - 1n + P) % P, den = (D * y2 + 1n) % P;
  const v = num * modpow(den, P - 2n, P) % P;
  return v === 0n || modpow(v, (P - 1n) / 2n, P) === 1n;
}
function deriveAta(owner, mint = WSOL_MINT) {
  const seeds = [b58decode(owner), b58decode(TOKEN_PROGRAM), b58decode(mint)];
  const pid = b58decode(ATA_PROGRAM);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.from([bump]));
    h.update(pid);
    h.update('ProgramDerivedAddress');
    const out = h.digest();
    if (!isOnCurve(out)) return b58encode(out);
  }
  throw new Error('no_ata');
}

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
export function loadTreasuryKey(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('treasury_key_missing');
  let bytes;
  try { bytes = raw.trim().startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : b58decode(raw.trim()); }
  catch { throw new Error('treasury_key_unreadable'); }
  if (bytes.length !== 64) throw new Error('treasury_key_unreadable');
  let priv, pub;
  try {
    priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(bytes.slice(0, 32))]), format: 'der', type: 'pkcs8' });
    pub = Uint8Array.from(crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).slice(-32));
  } catch { throw new Error('treasury_key_unreadable'); }
  if (Buffer.compare(Buffer.from(pub), Buffer.from(bytes.slice(32))) !== 0) throw new Error('treasury_key_inconsistent');
  if (b58encode(pub) !== TREASURY) throw new Error('treasury_key_mismatch');
  return { priv, pub };
}

function rpc(url, method, params) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    .then(r => r.json()).then(j => { if (j.error) throw new Error('rpc_error'); return j.result; });
}

function buildCloseTx(ata, blockhash, signerPub, priv) {
  // keys: 0 payer(w,s) 1 ata(w) 2 wsol mint(r) 3 system(r) 4 token program(r) 5 ata program(r)
  const keys = [signerPub, b58decode(ata), b58decode(WSOL_MINT), b58decode(SYSTEM_PROGRAM), b58decode(TOKEN_PROGRAM), b58decode(ATA_PROGRAM)];
  const header = Uint8Array.from([1, 0, 4]);
  // 1) CloseAccount(ata -> treasury, owner treasury)  2) ATA CreateIdempotent, so the fee account exists again for the next trader
  const close = Uint8Array.from([4, 3, 1, 0, 0, 1, 9]);
  const create = Uint8Array.from([5, 6, 0, 1, 0, 2, 3, 4, 1, 1]);
  const msg = Buffer.concat([Buffer.from(header), Buffer.from([6]), ...keys.map(Buffer.from), Buffer.from(b58decode(blockhash)), Buffer.from([2]), Buffer.from(close), Buffer.from(create)]);
  const sig = crypto.sign(null, msg, priv);
  return { wire: Buffer.concat([Buffer.from([1]), sig, msg]), signature: b58encode(sig) };
}

async function getWsolAta(rpcCall) {
  const ata = deriveAta(TREASURY);
  const result = await rpcCall('getAccountInfo', [ata, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const v = result?.value;
  if (!v) return { ata, exists: false, amount: 0n };
  const info = v.data?.parsed?.info;
  if (v.owner !== TOKEN_PROGRAM || info?.mint !== WSOL_MINT || info?.owner !== TREASURY || info?.isNative !== true) throw new Error('treasury_wsol_ata_invalid');
  return { ata, exists: true, amount: BigInt(info.tokenAmount.amount), lamports: BigInt(v.lamports) };
}

const failed = new Map();
function authorized(req) {
  const secret = process.env.SATURN_ADMIN_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const f = failed.get(ip);
  if (f && Date.now() - f.time < 600000 && f.count >= 5) return false;
  if (!crypto.timingSafeEqual(a, b)) { failed.set(ip, { count: (f?.count || 0) + 1, time: Date.now() }); return false; }
  failed.delete(ip);
  return true;
}

let busy = false;
export async function sweep(req, res) {
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  if (!authorized(req)) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (busy) { res.statusCode = 409; return res.end(JSON.stringify({ ok: false, error: 'sweep_in_progress' })); }
  busy = true;
  try {
    const key = loadTreasuryKey(process.env.SATURN_TREASURY_PRIVATE_KEY);
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!rpcUrl) throw new Error('rpc_not_configured');
    const call = (method, params) => rpc(rpcUrl, method, params);
    const acct = await getWsolAta(call);
    if (!acct.exists || acct.amount === 0n) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, swept: false, reason: 'no_wsol', treasury: TREASURY, wsolAccount: acct.ata })); }
    const bh = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = buildCloseTx(acct.ata, bh.value.blockhash, key.pub, key.priv);
    const sent = await call('sendTransaction', [tx.wire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    if (sent !== tx.signature) throw new Error('signature_mismatch');
    for (let i = 0; i < 30; i++) {
      const st = await call('getSignatureStatuses', [[tx.signature]]);
      const s = st?.value?.[0];
      if (s?.err) throw new Error('transaction_failed');
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, swept: true, amountLamports: acct.amount.toString(), signature: tx.signature, treasury: TREASURY, wsolAccount: acct.ata }));
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'confirmation_timeout', signature: tx.signature }));
  } catch (e) {
    console.error('[treasury-sweep]', e?.message || 'sweep_failed');
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: e?.message || 'sweep_failed' }));
  } finally { busy = false; }
             }
             
