/* OFFLINE TEST HELPERS. Nothing here talks to a network. The "world" is a deterministic in-memory EVM that answers exactly the read calls the
 * relay makes (factory lookups, token0/1, decimals, supply, balances, getReserves/slot0/liquidity, getLogs). Log payloads are ABI-faithful
 * encodings of the real Swap/Sync event layouts, but they are SYNTHETIC fixtures - not captured mainnet transactions. */
import { SEL, TOPIC, wordHex, addrWord, lc, strip0x, ZERO_ADDR } from '../src/abi.js';
import { CHAIN_CONFIG } from '../src/chains.js';

export const addr = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
export const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hex = n => '0x' + BigInt(n).toString(16);
const enc = (...ws) => '0x' + ws.map(w => wordHex(w)).join('');

export function sqrtPFromHumanPrice(priceToken1PerToken0, dec0, dec1) {
  /* independent construction: 16 significant digits of sqrt(raw ratio) scaled to Q96 with BigInt */
  const raw = priceToken1PerToken0 * Math.pow(10, dec1 - dec0);
  const [m, e] = Math.sqrt(raw).toExponential(15).split('e');
  const digits = BigInt(m.replace('.', '')), exp = Number(e) - 15, Q96 = 1n << 96n;
  return exp >= 0 ? digits * Q96 * 10n ** BigInt(exp) : (digits * Q96) / 10n ** BigInt(-exp);
}

export function createWorld() {
  const chains = {};
  const calls = { total: 0, byMethod: {}, batches: 0, sel: {} };
  const ch = key => chains[key] || (chains[key] = { id: CHAIN_CONFIG[key].chainId, code: new Set(), erc20: new Map(), factories: new Map(), pools: new Map(), v4Pools: new Map(), logs: [], block: 1000, failGetLogs: false, down: false });
  const w = {
    chains, calls, ch,
    deploy(key, a) { ch(key).code.add(lc(a)); },
    deployConfig(key) { const c = CHAIN_CONFIG[key]; c.protocols.forEach(p => { const target = p.factory || p.manager; if (target) { w.deploy(key, target); if (p.factory) ch(key).factories.set(lc(p.factory), new Map()); } if (p.stateView) w.deploy(key, p.stateView); }); w.deploy(key, c.native.wrapped); },
    token(key, a, { decimals = 18, supply = 10n ** 27n } = {}) { ch(key).erc20.set(lc(a), { decimals, supply, bal: new Map() }); w.deploy(key, a); },
    setBalance(key, tokenAddr, holder, v) { ch(key).erc20.get(lc(tokenAddr)).bal.set(lc(holder), BigInt(v)); },
    /* V2-style pool registered in the given protocol's factory */
    v2Pool(key, protocolId, pool, tokenA, tokenB, r0, r1) {
      const c = ch(key), p = CHAIN_CONFIG[key].protocols.find(x => x.id === protocolId);
      const [t0, t1] = lc(tokenA) < lc(tokenB) ? [lc(tokenA), lc(tokenB)] : [lc(tokenB), lc(tokenA)];
      const [a0, a1] = lc(tokenA) < lc(tokenB) ? [r0, r1] : [r1, r0];
      c.pools.set(lc(pool), { kind: 'v2', t0, t1, r0: BigInt(a0), r1: BigInt(a1) }); w.deploy(key, pool);
      c.factories.get(p.factory).set(t0 + ':' + t1, lc(pool));
      w.setBalance(key, t0, pool, a0); w.setBalance(key, t1, pool, a1);
    },
    v3Pool(key, protocolId, pool, tokenA, tokenB, fee, sqrtP, liquidity, balances = {}) {
      const c = ch(key), p = CHAIN_CONFIG[key].protocols.find(x => x.id === protocolId);
      const [t0, t1] = lc(tokenA) < lc(tokenB) ? [lc(tokenA), lc(tokenB)] : [lc(tokenB), lc(tokenA)];
      c.pools.set(lc(pool), { kind: 'v3', t0, t1, sqrtP: BigInt(sqrtP), liquidity: BigInt(liquidity) }); w.deploy(key, pool);
      c.factories.get(p.factory).set(t0 + ':' + t1 + ':' + fee, lc(pool));
      w.setBalance(key, t0, pool, balances[t0] ?? 0n); w.setBalance(key, t1, pool, balances[t1] ?? 0n);
    },
    /* world-level chain mutation helpers */
    setV2Reserves(key, pool, r0, r1) { const p = ch(key).pools.get(lc(pool)); p.r0 = BigInt(r0); p.r1 = BigInt(r1); },
    setV3Price(key, pool, sqrtP) { ch(key).pools.get(lc(pool)).sqrtP = BigInt(sqrtP); },
    v4Pool(key, poolId, token, quoteCurrency, sqrtP, liquidity = 10n ** 18n) {
      const cfg = CHAIN_CONFIG[key], proto = cfg.protocols.find(x => x.id === 'uniswap_v4');
      const token0 = lc(quoteCurrency) < lc(token) ? lc(quoteCurrency) : lc(token), token1 = lc(quoteCurrency) < lc(token) ? lc(token) : lc(quoteCurrency);
      ch(key).v4Pools.set(poolId.toLowerCase(), { token0, token1, sqrtP: BigInt(sqrtP), liquidity: BigInt(liquidity) });
      w.deploy(key, proto.manager); w.deploy(key, proto.stateView);
      w.pushLog(key, v4InitializeLog({ manager: proto.manager, poolId, currency0: token0, currency1: token1, block: 900, sqrtP }));
    },
    setV4Price(key, poolId, sqrtP) { ch(key).v4Pools.get(poolId.toLowerCase()).sqrtP = BigInt(sqrtP); },
    pushLog(key, log) { ch(key).logs.push(log); },
    mine(key, n = 1) { ch(key).block += n; return ch(key).block; }
  };

  function execCall(key, to, data) {
    const c = ch(key); to = lc(to); const sel = data.slice(0, 10), body = strip0x(data.slice(10));
    const word = i => body.slice(i * 64, i * 64 + 64), wa = i => '0x' + word(i).slice(24);
    const erc = c.erc20.get(to), pool = c.pools.get(to), fac = c.factories.get(to);
    const v4Proto = CHAIN_CONFIG[key].protocols.find(x => x.id === 'uniswap_v4');
    if (v4Proto && to === lc(v4Proto.stateView)) {
      const id = '0x' + word(0), v4 = c.v4Pools.get(id);
      if (!v4) throw new Error('v4_pool_not_found');
      if (sel === SEL.v4GetSlot0) return enc(v4.sqrtP, 0, 0, 3000);
      if (sel === SEL.v4GetLiquidity) return enc(v4.liquidity);
    }
    if (fac) {
      if (sel === SEL.getPair) { const [a, b] = [lc(wa(0)), lc(wa(1))].sort(); return enc(BigInt(fac.get(a + ':' + b) || 0)); }
      if (sel === SEL.getPool) { const [a, b] = [lc(wa(0)), lc(wa(1))].sort(); const fee = BigInt('0x' + word(2)); return enc(BigInt(fac.get(a + ':' + b + ':' + fee) || 0)); }
    }
    if (erc) {
      if (sel === SEL.decimals) return enc(erc.decimals);
      if (sel === SEL.totalSupply) return enc(erc.supply);
      if (sel === SEL.balanceOf) return enc(erc.bal.get(lc(wa(0))) ?? 0n);
    }
    if (pool) {
      if (sel === SEL.token0) return enc(BigInt(pool.t0));
      if (sel === SEL.token1) return enc(BigInt(pool.t1));
      if (pool.kind === 'v2' && sel === SEL.getReserves) return enc(pool.r0, pool.r1, 0);
      if (pool.kind === 'v3' && sel === SEL.slot0) return enc(pool.sqrtP, 0, 0, 0, 0, 0, 1);
      if (pool.kind === 'v3' && sel === SEL.liquidity) return enc(pool.liquidity);
    }
    throw new Error('execution_reverted');
  }
  function single(key, method, params) {
    calls.total++; calls.byMethod[method] = (calls.byMethod[method] || 0) + 1;
    if (method === 'eth_call') { const sl = params[0].data.slice(0, 10); calls.sel[sl] = (calls.sel[sl] || 0) + 1; }
    const c = ch(key);
    if (c.down) throw new Error('rpc_down');
    switch (method) {
      case 'eth_chainId': return hex(c.id);
      case 'eth_blockNumber': return hex(c.block);
      case 'eth_getCode': return c.code.has(lc(params[0])) ? '0x6080604052' : '0x';
      case 'eth_call': return execCall(key, params[0].to, params[0].data);
      case 'eth_getLogs': {
        if (c.failGetLogs) throw new Error('getLogs_failed');
        const f = params[0], from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
        const topics = f.topics || [];
        return c.logs.filter(l => lc(l.address) === lc(f.address) && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to && topics.every((want, i) => want == null || (Array.isArray(want) ? want.some(x => lc(x) === lc(l.topics[i] || '')) : lc(want) === lc(l.topics[i] || ''))));
      }
      default: throw new Error('method_not_mocked:' + method);
    }
  }
  const rpc = {
    async call(key, method, params = []) { return single(key, method, params); },
    async ethCall(key, to, data) { return single(key, 'eth_call', [{ to, data }, 'latest']); },
    async blockNumber(key) { return Number(BigInt(single(key, 'eth_blockNumber', []))); },
    async batch(key, list) { calls.batches++; return list.map(c => { try { return { ok: true, result: single(key, c.method, c.params || []) }; } catch (e) { return { ok: false, error: e.message }; } }); },
    async getLogs(key, f) { const hx = n => '0x' + n.toString(16); return single(key, 'eth_getLogs', [{ address: f.address, topics: f.topics, fromBlock: hx(f.fromBlock), toBlock: hx(f.toBlock) }]); }
  };
  w.rpc = rpc;
  return w;
}

/* ---------- log builders (ABI-faithful layouts) ---------- */
const meta = ({ pool, block, logIndex = 0, tx = block * 1000 + logIndex, blockHash = block, removed = false }) => ({ address: lc(pool), blockNumber: hex(block), blockHash: hash(blockHash), transactionHash: hash(tx), logIndex: hex(logIndex), removed });
export const v2SwapLog = ({ a0in = 0n, a1in = 0n, a0out = 0n, a1out = 0n, ...m }) => ({ ...meta(m), topics: [TOPIC.v2Swap, '0x' + addrWord(addr(0xaaa)), '0x' + addrWord(addr(0xbbb))], data: enc(a0in, a1in, a0out, a1out) });
export const v2SyncLog = ({ r0, r1, ...m }) => ({ ...meta(m), topics: [TOPIC.v2Sync], data: enc(r0, r1) });
export const v3SwapLog = ({ amount0, amount1, sqrtP, liquidity = 10n ** 18n, tick = 0, ...m }) => ({ ...meta(m), topics: [TOPIC.v3Swap, '0x' + addrWord(addr(0xaaa)), '0x' + addrWord(addr(0xbbb))], data: enc(amount0, amount1, sqrtP, liquidity, tick) });
export const pancakeV3SwapLog = ({ amount0, amount1, sqrtP, liquidity = 10n ** 18n, tick = 0, ...m }) => ({ ...meta(m), topics: [TOPIC.pancakeV3Swap, '0x' + addrWord(addr(0xaaa)), '0x' + addrWord(addr(0xbbb))], data: enc(amount0, amount1, sqrtP, liquidity, tick, 0, 0) });
export const v4InitializeLog = ({ manager, poolId, currency0, currency1, fee = 3000, tickSpacing = 60, hooks = ZERO_ADDR, sqrtP, tick = 0, ...m }) => ({ ...meta({ pool: manager, ...m }), topics: [TOPIC.v4Initialize, poolId, '0x' + addrWord(currency0), '0x' + addrWord(currency1)], data: enc(fee, tickSpacing, BigInt(hooks), sqrtP || 0n, tick) });
export const v4SwapLog = ({ manager, poolId, sender = addr(0xaaa), amount0, amount1, sqrtP, liquidity = 10n ** 18n, tick = 0, fee = 3000, ...m }) => ({ ...meta({ pool: manager, ...m }), topics: [TOPIC.v4Swap, poolId, '0x' + addrWord(sender)], data: enc(amount0, amount1, sqrtP, liquidity, tick, fee) });
export const asRemoved = l => ({ ...l, removed: true });

export const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
export async function until(fn, ms = 1500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await tick(5); } throw new Error('until_timeout'); }

/* ---------- scenario builders ---------- */
export const HIGH = '0x' + 'f'.repeat(40), LOW = addr(0x1234);
/* Create a pool where `price` = quote per 1 token (human units) and balances are human-unit amounts. */
export function buildPool(world, chain, { protocolId, pool, token, quote, price, tokenDec = 18, quoteDec = 18, tokenBal = 1_000_000, quoteBal, fee, supply }) {
  const c = world.ch(chain);
  if (!c.erc20.has(lc(token))) world.token(chain, token, { decimals: tokenDec, supply: supply ?? 10n ** BigInt(tokenDec) * 1_000_000_000n });
  if (!c.erc20.has(lc(quote))) world.token(chain, quote, { decimals: quoteDec });
  const raw = (h, d) => BigInt(Math.round(h * 1e6)) * 10n ** BigInt(d) / 1_000_000n;
  quoteBal = quoteBal ?? tokenBal * price;
  const proto = CHAIN_CONFIG[chain].protocols.find(p => p.id === protocolId), family = proto.family;
  if (fee == null && proto.fees) fee = proto.fees[1]; // a fee tier that exists for that protocol (Pancake has 2500, Uniswap 3000)
  const tokenIs0 = lc(token) < lc(quote);
  if (family === 'v2') {
    const rt = raw(tokenBal, tokenDec), rq = raw(quoteBal, quoteDec);
    world.v2Pool(chain, protocolId, pool, token, quote, rt, rq); // v2Pool sorts by address itself
  } else {
    const sqrtP = tokenIs0 ? sqrtPFromHumanPrice(price, tokenDec, quoteDec) : sqrtPFromHumanPrice(1 / price, quoteDec, tokenDec);
    world.v3Pool(chain, protocolId, pool, token, quote, fee, sqrtP, 10n ** 18n, { [lc(token)]: raw(tokenBal, tokenDec), [lc(quote)]: raw(quoteBal, quoteDec) });
  }
  return { tokenIs0 };
}
/* Deep wrapped-native/stable reference pool so the on-chain quote-USD path is exercised (stable decimals configurable). */
export function addRefPool(world, chain, nativeUsd, { stableDec = 6, liqUsd = 5_000_000 } = {}) {
  const cfg = CHAIN_CONFIG[chain], stable = Object.keys(cfg.stables)[0], p = cfg.protocols.find(x => x.family === 'v3');
  return buildPool(world, chain, { protocolId: p.id, pool: addr(0xdef0 + cfg.chainId), token: cfg.native.wrapped, quote: stable, price: nativeUsd, tokenDec: 18, quoteDec: stableDec, tokenBal: liqUsd / nativeUsd, quoteBal: liqUsd, fee: 500 });
}
export function makeFetch(map = {}) {
  const f = async (url) => { f.calls.push(url); const v = map[Object.keys(map).find(k => url.includes(k))]; if (v === undefined) return { ok: false, status: 404, json: async () => ({}) }; if (v instanceof Error) throw v; return { ok: true, status: 200, json: async () => v }; };
  f.calls = []; return f;
}
