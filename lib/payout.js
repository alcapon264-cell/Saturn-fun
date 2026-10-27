// Saturn reward payouts: builds and signs ONE System-Program transfer (treasury -> a user's verified wallet).
// The treasury private key is read from the server environment only (via loadTreasuryKey, which refuses a key that does not match the treasury address)
// and never leaves this process. Nothing here is reachable without the authenticated claim flow in lib/rewards.js.
import crypto from 'node:crypto';
import { loadTreasuryKey, b58encode, b58decode } from './treasury.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// Legacy transaction: 1 signer (treasury, fee payer), accounts [treasury, recipient, system program], one Transfer instruction.
export function buildTransfer({ fromPub, to, lamports, blockhash, priv }) {
  const l = BigInt(lamports);
  if (l <= 0n || l > 0xffffffffffffffffn) throw new Error('bad_amount');
  const dest = b58decode(to);
  if (dest.length !== 32) throw new Error('bad_destination');
  const bh = b58decode(blockhash);
  if (bh.length !== 32) throw new Error('bad_blockhash');
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // SystemInstruction::Transfer
  data.writeBigUInt64LE(l, 4);
  const msg = Buffer.concat([
    Buffer.from([1, 0, 1]),                         // header: 1 signature, 0 readonly signed, 1 readonly unsigned (system program)
    Buffer.from([3]),                               // account count
    Buffer.from(fromPub), Buffer.from(dest), Buffer.from(b58decode(SYSTEM_PROGRAM)),
    Buffer.from(bh),
    Buffer.from([1]),                               // instruction count
    Buffer.from([2, 2, 0, 1, 12]), data             // program idx 2, 2 accounts [0,1], 12 data bytes
  ]);
  const sig = crypto.sign(null, msg, priv);
  return { wire: Buffer.concat([Buffer.from([1]), sig, msg]).toString('base64'), signature: b58encode(sig) };
}

// Production payout adapter. `call(method, params)` is a JSON-RPC function bound to SOLANA_RPC_URL.
export function makePayout({ call, env }) {
  let cachedKey = null;
  const key = () => cachedKey || (cachedKey = loadTreasuryKey(env.SATURN_TREASURY_PRIVATE_KEY));
  return {
    ready() { try { key(); return true; } catch { return false; } },
    address() { return b58encode(key().pub); },
    async balance() {
      const r = await call('getBalance', [b58encode(key().pub), { commitment: 'confirmed' }]);
      return BigInt(r && typeof r === 'object' ? r.value : r);
    },
    async latestBlockhash() {
      const r = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      return { blockhash: r.value.blockhash, lastValidBlockHeight: Number(r.value.lastValidBlockHeight) };
    },
    async blockHeight() { return Number(await call('getBlockHeight', [{ commitment: 'confirmed' }])); },
    build(to, lamports, blockhash) { const k = key(); return buildTransfer({ fromPub: k.pub, to, lamports, blockhash, priv: k.priv }); },
    async send(wire) { return call('sendTransaction', [wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]); },
    async status(sig, { history = false } = {}) {
      const r = await call('getSignatureStatuses', [[sig], { searchTransactionHistory: !!history }]);
      return (r && r.value && r.value[0]) || null;
    }
  };
}
