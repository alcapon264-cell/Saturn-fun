/* Small, strict ABI helpers (words only: addresses, uints, ints). No dynamic types are needed by the pipeline. */
import { selector, topic0 } from './keccak.js';

export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
export const isAddr = v => typeof v === 'string' && ADDR_RE.test(v);
export const lc = v => String(v).toLowerCase();

export const SIG = Object.freeze({
  token0: 'token0()', token1: 'token1()', decimals: 'decimals()', totalSupply: 'totalSupply()',
  balanceOf: 'balanceOf(address)', getReserves: 'getReserves()', slot0: 'slot0()', liquidity: 'liquidity()',
  getPair: 'getPair(address,address)', getPool: 'getPool(address,address,uint24)', factory: 'factory()', fee: 'fee()'
});
export const SEL = Object.freeze(Object.fromEntries(Object.entries(SIG).map(([k, v]) => [k, selector(v)])));
export const EVENT_SIG = Object.freeze({
  v2Swap: 'Swap(address,uint256,uint256,uint256,uint256,address)',
  v2Sync: 'Sync(uint112,uint112)',
  v3Swap: 'Swap(address,address,int256,int256,uint160,uint128,int24)',
  pancakeV3Swap: 'Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'
});
export const TOPIC = Object.freeze(Object.fromEntries(Object.entries(EVENT_SIG).map(([k, v]) => [k, topic0(v)])));

export const strip0x = h => String(h || '').replace(/^0x/, '');
export const wordHex = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
export const addrWord = a => lc(strip0x(a)).padStart(64, '0');
export function encodeCall(sel, ...words) { return sel + words.map(w => (typeof w === 'string' && isAddr(w)) ? addrWord(w) : wordHex(w)).join(''); }

export function words(data) {
  const x = strip0x(data);
  if (x.length % 64 !== 0) throw new Error('abi_bad_length');
  const out = [];
  for (let i = 0; i < x.length; i += 64) out.push(x.slice(i, i + 64));
  return out;
}
export const wordUint = w => BigInt('0x' + w);
export const wordInt = w => BigInt.asIntN(256, BigInt('0x' + w));
export const wordAddr = w => '0x' + w.slice(24).toLowerCase();
export function readUint(data, i = 0) { const w = words(data); if (w.length <= i) throw new Error('abi_short'); return wordUint(w[i]); }
export function readAddr(data, i = 0) { const w = words(data); if (w.length <= i) throw new Error('abi_short'); return wordAddr(w[i]); }
export function topicAddr(t) { if (!HASH_RE.test(String(t || ''))) throw new Error('abi_bad_topic'); return '0x' + String(t).slice(26).toLowerCase(); }
