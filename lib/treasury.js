'use strict';
// Saturn treasury WSOL -> native SOL sweep. Zero npm dependencies (Node crypto + fetch only).
// SECURITY: the private key is read ONLY from process.env.SATURN_TREASURY_PRIVATE_KEY, only inside a sweep request,
// and is never logged, returned, or placed in an error message. The destination is hard-wired to TREASURY.
const crypto = require('crypto');

const TREASURY = '7XGVo8SdqUeTP7dFgj3xC7PcmMA6wet4srqnSqnjCSSv';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// ---------- base58 ----------
function b58encode(buf) {
  let n = 0n; for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = ''; while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
function b58decode(str) {
  let n = 0n; for (const c of str) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error('bad_base58'); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  let z = 0; for (const c of str) { if (c === '1') z++; else break; }
  return Uint8Array.from([...new Array(z).fill(0), ...out]);
}

// ---------- ed25519 helpers ----------
const P = (1n << 255n) - 19n, D = (P - (121665n * modpow(121666n, P - 2n, P)) % P) % P;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function isOnCurve(bytes32) {
  const b = Uint8Array.from(bytes32); b[31] &= 0x7f;
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = y * y % P, num = (y2 - 1n + P) % P, den = (D * y2 + 1n) % P;
  const v = num * modpow(den, P - 2n, P) % P;
  return v === 0n || modpow(v, (P - 1n) / 2n, P) === 1n;
}
function findPda(seeds, programId) {
  const pid = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.from([bump])); h.update(pid); h.update('ProgramDerivedAddress');
    const out = h.digest();
    if (!isOnCurve(out)) return { address: b58encode(out), bump };
  }
  throw new Error('no_pda');
}
function deriveAta(owner, mint = WSOL_MINT) {
  return findPda([b58decode(owner), b58decode(TOKEN_PROGRAM), b58decode(mint)], ATA_PROGRAM).address;
}
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
function privFromSeed(seed32) { return crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed32)]), format: 'der', type: 'pkcs8' }); }
function pubFromPriv(priv) { return Uint8Array.from(crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).slice(-32)); }

// ---------- key loading (fail closed) ----------
// Accepted formats: base58 of the 64-byte secret key (Phantom/Solflare export), OR a JSON array of 64 numbers (solana-keygen).
function loadTreasuryKey(raw, expectedPub = TREASURY) {
  const bad = (code) => { const e = new Error(code); e.code = code; return e; };
  if (typeof raw !== 'string' || !raw.trim()) throw bad('treasury_key_missing');
  let bytes;
  try {
    const t = raw.trim();
    bytes = t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : b58decode(t);
  } catch (e) { throw bad('treasury_key_unreadable'); }
  if (bytes.length !== 64) throw bad('treasury_key_unreadable');
  let priv, pub;
  try { priv = privFromSeed(bytes.slice(0, 32)); pub = pubFromPriv(priv); } catch (e) { throw bad('treasury_key_unreadable'); }
  if (Buffer.compare(Buffer.from(pub), Buffer.from(bytes.slice(32))) !== 0) throw bad('treasury_key_inconsistent');
  if (b58encode(pub) !== expectedPub) throw bad('treasury_key_mismatch'); // derived public key must EXACTLY equal the treasury
  return { priv, pub, address: expectedPub };
}

// ---------- RPC ----------
function makeRpc(url, fetchFn = fetch) {
  let id = 0;
  return async function rpc(method, params) {
    let r;
    try { r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }); }
    catch (e) { const er = new Error('rpc_unreachable'); er.code = 'rpc_unreachable'; throw er; }
    let j; try { j = await r.json(); } catch (e) { const er = new Error('rpc_bad_response'); er.code = 'rpc_bad_response'; throw er; }
    if (j.error) { const er = new Error('rpc_error'); er.code = 'rpc_error'; er.rpcMessage = String(j.error.message || '').slice(0, 160); throw er; }
    return j.result;
  };
}

// ---------- transaction (legacy message, one CloseAccount instruction) ----------
function buildCloseTx(ata, blockhash, signerPub, priv) {
  const keys = [signerPub, b58decode(ata), b58decode(TOKEN_PROGRAM)]; // 0 treasury (signer, writable, fee payer) | 1 wSOL account (writable) | 2 Token program (readonly)
  const header = Uint8Array.from([1, 0, 1]);
  const ix = Uint8Array.from([2, 3, 1, 0, 0, 1, 9]); // programIdx=2, 3 accounts [account=1, destination=0, owner=0], data len 1, data = [9] (CloseAccount)
  const msg = Buffer.concat([Buffer.from(header), Buffer.from([3]), ...keys.map(Buffer.from), Buffer.from(b58decode(blockhash)), Buffer.from([1]), Buffer.from(ix)]);
  const sig = crypto.sign(null, msg, priv);
  return { bytes: Buffer.concat([Buffer.from([1]), sig, msg]), signature: b58encode(sig) };
}

// ---------- account inspection ----------
async function readWsolAccount(rpc, treasury) {
  const ata = deriveAta(treasury);
  const info = await rpc('getAccountInfo', [ata, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const v = info && info.value;
  if (!v) {
    // Cross-check the derivation against the chain: if the treasury owns ANY wSOL token account, our derived address must be it.
    const list = await rpc('getTokenAccountsByOwner', [treasury, { mint: WSOL_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const others = ((list && list.value) || []).map(x => x.pubkey).filter(a => a !== ata);
    if (others.length) { const e = new Error('ata_mismatch'); e.code = 'ata_mismatch'; throw e; }
    return { ata, exists: false, amount: 0n, lamports: 0n };
  }
  const p = v.data && v.data.parsed && v.data.parsed.info;
  if (v.owner !== TOKEN_PROGRAM || !p || p.mint !== WSOL_MINT || p.owner !== treasury) { const e = new Error('ata_unexpected_state'); e.code = 'ata_unexpected_state'; throw e; }
  if (p.state !== 'initialized' || p.isNative !== true) { const e = new Error('ata_unexpected_state'); e.code = 'ata_unexpected_state'; throw e; }
  if (p.closeAuthority && p.closeAuthority !== treasury) { const e = new Error('ata_unexpected_state'); e.code = 'ata_unexpected_state'; throw e; }
  return { ata, exists: true, amount: BigInt(p.tokenAmount.amount), lamports: BigInt(v.lamports) };
}

async function confirm(rpc, signature, timeoutMs, sleep) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await rpc('getSignatureStatuses', [[signature]]);
    const s = r && r.value && r.value[0];
    if (s) { if (s.err) return { ok: false, err: true }; if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return { ok: true }; }
    await sleep(1500);
  }
  return { ok: false, timeout: true };
}

let sweeping = false; // one sweep at a time per server instance
async function sweep(deps) {
  const { rpc, env, treasury: T = TREASURY, log = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms)), timeoutMs = 45000 } = deps;
  if (sweeping) return { status: 409, body: { ok: false, error: 'sweep_in_progress' } };
  sweeping = true;
  try {
    let key; try { key = loadTreasuryKey(env.SATURN_TREASURY_PRIVATE_KEY, T); }
    catch (e) { log('key check failed: ' + e.code); return { status: 500, body: { ok: false, error: e.code || 'treasury_key_unreadable' } }; }
    const acct = await readWsolAccount(rpc, T);
    if (!acct.exists || acct.amount === 0n) { log('nothing to sweep'); return { status: 200, body: { ok: true, swept: false, reason: 'no_wsol' } }; }
    const bh = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = buildCloseTx(acct.ata, bh.value.blockhash, key.pub, key.priv);
    log('sending close-account ' + tx.signature + ' for ' + acct.amount + ' wSOL lamports');
    const sent = await rpc('sendTransaction', [tx.bytes.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    if (sent !== tx.signature) { return { status: 502, body: { ok: false, error: 'signature_mismatch' } }; }
    const c = await confirm(rpc, tx.signature, timeoutMs, sleep);
    if (!c.ok) { log('not confirmed: ' + (c.timeout ? 'timeout' : 'failed')); return { status: 502, body: { ok: false, swept: false, error: c.timeout ? 'confirmation_timeout' : 'transaction_failed', signature: tx.signature } }; }
    log('swept ' + acct.amount + ' lamports, sig ' + tx.signature);
    return { status: 200, body: { ok: true, swept: true, amountLamports: acct.amount.toString(), accountLamportsReturned: acct.lamports.toString(), signature: tx.signature } };
  } catch (e) {
    log('sweep error: ' + (e && e.code || 'unknown'));
    return { status: 502, body: { ok: false, error: (e && e.code) || 'sweep_failed' } };
  } finally { sweeping = false; }
}

async function status(deps) {
  const { rpc, treasury: T = TREASURY, log = () => {} } = deps;
  try {
    const bal = await rpc('getBalance', [T, { commitment: 'confirmed' }]);
    const acct = await readWsolAccount(rpc, T);
    let last = null;
    const sigs = (await rpc('getSignaturesForAddress', [acct.ata, { limit: 20, commitment: 'confirmed' }])) || [];
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      const ixs = (tx && tx.transaction && tx.transaction.message && tx.transaction.message.instructions) || [];
      if (ixs.some(i => i.parsed && i.parsed.type === 'closeAccount' && i.parsed.info && i.parsed.info.account === acct.ata && i.parsed.info.owner === T)) {
        last = { signature: s.signature, time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null }; break;
      }
    }
    return { status: 200, body: { ok: true, treasury: T, treasurySolLamports: String(bal && bal.value), wsolAccount: acct.ata, wsolAccountExists: acct.exists, wsolLamports: acct.amount.toString(), lastSweep: last, lastSweepNote: last ? null : 'none found in the 20 most recent transactions of the wSOL account' } };
  } catch (e) { log('status error: ' + (e && e.code || 'unknown')); return { status: 502, body: { ok: false, error: (e && e.code) || 'status_failed' } }; }
}

// ---------- admin auth (server-side secret; fails closed) ----------
const fails = new Map(); // ip -> {n, t}   (per server instance; a best-effort brake, not the only protection — the secret is)
function authorize(req, env, now = Date.now()) {
  const secret = env.SATURN_ADMIN_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return { ok: false, status: 503, error: 'admin_not_configured' };
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || 'unknown').trim();
  const f = fails.get(ip);
  if (f && now - f.t < 600000 && f.n >= 5) return { ok: false, status: 429, error: 'too_many_attempts' };
  const h = String(req.headers.authorization || ''), m = /^Bearer (.+)$/.exec(h);
  const a = crypto.createHash('sha256').update(m ? m[1] : '').digest(), b = crypto.createHash('sha256').update(secret).digest();
  if (!m || !crypto.timingSafeEqual(a, b)) { const n = f && now - f.t < 600000 ? f.n + 1 : 1; fails.set(ip, { n, t: now }); return { ok: false, status: 401, error: 'unauthorized' }; }
  fails.delete(ip);
  return { ok: true };
}

function handler(kind, env = process.env, rpcFactory = () => makeRpc(env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com')) {
  return async function (req, res) {
    const send = (s, b) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(b)); };
    const want = kind === 'sweep' ? 'POST' : 'GET';
    if (req.method !== want) return send(405, { ok: false, error: 'method_not_allowed' });
    const a = authorize(req, env);
    if (!a.ok) return send(a.status, { ok: false, error: a.error });
    const log = (m) => console.log('[treasury-' + kind + '] ' + m); // messages above never contain keys, secrets or RPC URLs
    const r = await (kind === 'sweep' ? sweep({ rpc: rpcFactory(), env, log }) : status({ rpc: rpcFactory(), log }));
    send(r.status, r.body);
  };
}

module.exports = { TREASURY, WSOL_MINT, b58encode, b58decode, isOnCurve, deriveAta, loadTreasuryKey, makeRpc, buildCloseTx, readWsolAccount, sweep, status, authorize, handler, pubFromPriv, privFromSeed, _fails: fails };
