/* Minimal Keccak-256 (Ethereum variant, 0x01 padding). Used only to derive event topics and
 * function selectors from signatures, so no ABI constant is hand-typed without a derivation.
 * Verified against published vectors in tests/keccak-abi.test.js. */
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]
];
const M = (1n << 64n) - 1n;
const rol = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;

function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const C = new Array(5), D = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rol(C[(x + 1) % 5], 1);
    for (let i = 0; i < 25; i++) s[i] ^= D[i % 5];
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rol(s[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ (~B[(x + 1) % 5 + 5 * y] & M & B[(x + 2) % 5 + 5 * y]);
    s[0] ^= RC[r];
  }
}

export function keccak256(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : Uint8Array.from(input);
  const rate = 136, s = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data); padded[data.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n;
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= v;
    }
    keccakF(s);
  }
  let out = '';
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  return '0x' + out;
}
export const topic0 = sig => keccak256(sig);
export const selector = sig => keccak256(sig).slice(0, 10);
