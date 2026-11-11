/* Protocol-specific swap handlers. There is deliberately NO universal decoder: Uniswap V2 / V3 / PancakeSwap V3 swap events have different
 * ABIs (and different topic0 hashes), so each family decodes only its own event and is selected from the pool's verified protocol.
 *
 * Orientation: a pool stores token0 < token1 (by address). `tokenIsToken0` says which side the tracked token is on, and every handler
 * returns amounts and prices from the TRACKED TOKEN's point of view: priceQuotePerToken = quote units per 1 token, decimals-normalised.
 */
import { TOPIC, SEL, EVENT_SIG, words, wordUint, wordInt, topicAddr, readUint, HASH_RE } from './abi.js';

const Q96 = 1n << 96n;
const POW10 = n => 10n ** BigInt(n);

/* Exact ratio -> JS number with ~18 significant digits of integer arithmetic before the final conversion. */
export function ratioToNumber(num, den) {
  if (den === 0n) throw new Error('zero_denominator');
  if (num === 0n) return 0;
  const SCALE = 10n ** 36n;
  const q = (num * SCALE) / den;
  return Number(q) / 1e36;
}
const normAmt = (raw, dec) => ratioToNumber(raw < 0n ? -raw : raw, POW10(dec));

/* price of the tracked token in quote tokens, from raw reserves/price of token0 & token1 (raw units): token1Raw/token0Raw adjusted for decimals. */
export function priceFromRawRatio({ rawToken1PerToken0Num, rawToken1PerToken0Den, dec0, dec1, tokenIsToken0 }) {
  // price(token1 per token0, human) = raw ratio * 10^(dec0-dec1)
  const exp = dec0 - dec1;
  let num = rawToken1PerToken0Num, den = rawToken1PerToken0Den;
  if (exp >= 0) num *= POW10(exp); else den *= POW10(-exp);
  if (tokenIsToken0) return ratioToNumber(num, den);        // quote per token = token1/token0
  return ratioToNumber(den, num);                            // quote per token = token0/token1
}

function requireLog(log) {
  if (!log || !Array.isArray(log.topics) || typeof log.data !== 'string') throw new Error('malformed_log');
  if (!HASH_RE.test(log.blockHash || '') || !HASH_RE.test(log.transactionHash || '')) throw new Error('malformed_log');
  const bn = Number(BigInt(log.blockNumber)), li = Number(BigInt(log.logIndex));
  if (!Number.isSafeInteger(bn) || !Number.isSafeInteger(li) || bn < 0 || li < 0) throw new Error('malformed_log');
  return { blockNumber: bn, logIndex: li };
}

/* ---------- Uniswap V2 style (Uniswap V2, PancakeSwap V2, QuickSwap V2, SushiSwap V2 ...) ---------- */
export const v2 = Object.freeze({
  family: 'v2',
  topics: Object.freeze([TOPIC.v2Swap, TOPIC.v2Sync]),
  /* V2 needs pool state (reserves). Sync carries post-swap reserves; Swap carries the trade amounts. */
  decode(log, ctx) {
    const pos = requireLog(log);
    const t0 = log.topics[0];
    if (t0 === TOPIC.v2Sync) {
      if (log.topics.length !== 1) throw new Error('malformed_log');
      const w = words(log.data); if (w.length !== 2) throw new Error('malformed_log');
      const r0 = wordUint(w[0]), r1 = wordUint(w[1]);
      return { kind: 'state', ...pos, reserve0: r0, reserve1: r1 };
    }
    if (t0 === TOPIC.v2Swap) {
      if (log.topics.length !== 3) throw new Error('malformed_log');
      topicAddr(log.topics[1]); topicAddr(log.topics[2]);
      const w = words(log.data); if (w.length !== 4) throw new Error('malformed_log');
      const [a0in, a1in, a0out, a1out] = w.map(wordUint);
      const tokenIn = ctx.tokenIsToken0 ? a0in : a1in, tokenOut = ctx.tokenIsToken0 ? a0out : a1out;
      const quoteIn = ctx.tokenIsToken0 ? a1in : a0in, quoteOut = ctx.tokenIsToken0 ? a1out : a0out;
      // buy = pool pays out the tracked token and receives quote
      let side = null, tokenRaw = 0n, quoteRaw = 0n;
      if (tokenOut > 0n && quoteIn > 0n && tokenIn === 0n) { side = 'buy'; tokenRaw = tokenOut; quoteRaw = quoteIn; }
      else if (tokenIn > 0n && quoteOut > 0n && tokenOut === 0n) { side = 'sell'; tokenRaw = tokenIn; quoteRaw = quoteOut; }
      else side = 'other'; // flash swaps / mixed legs: counted, never used for the execution price
      const trade = { side, tokenAmount: normAmt(tokenRaw, ctx.tokenDecimals), quoteAmount: normAmt(quoteRaw, ctx.quoteDecimals) };
      trade.execPriceQuote = side !== 'other' && tokenRaw > 0n ? ratioToNumber(quoteRaw * POW10(ctx.tokenDecimals), tokenRaw * POW10(ctx.quoteDecimals)) : null;
      return { kind: 'swap', ...pos, trade };
    }
    throw new Error('unknown_event');
  },
  /* Spot price (quote per token) from reserves. */
  spotFromReserves(reserve0, reserve1, ctx) {
    if (reserve0 <= 0n || reserve1 <= 0n) return null;
    return priceFromRawRatio({ rawToken1PerToken0Num: reserve1, rawToken1PerToken0Den: reserve0, dec0: ctx.dec0, dec1: ctx.dec1, tokenIsToken0: ctx.tokenIsToken0 });
  },
  /* State read used at discovery, reconcile and reorg recovery. */
  stateCalls: pool => [{ method: 'eth_call', params: [{ to: pool, data: SEL.getReserves }, 'latest'] }],
  parseState(results, ctx) {
    if (!results[0]?.ok) throw new Error('state_read_failed');
    const w = words(results[0].result); if (w.length < 2) throw new Error('state_read_failed');
    const reserve0 = wordUint(w[0]), reserve1 = wordUint(w[1]);
    const price = this.spotFromReserves(reserve0, reserve1, ctx);
    return { price, reserve0, reserve1, empty: price == null };
  }
});

/* ---------- Uniswap V3 style (Uniswap V3 and compatible forks that keep the same 7-field Swap event) ---------- */
function v3Handler(familyName, eventKey) {
  const topic = TOPIC[eventKey]; // 5 data words (+2 protocol-fee words on the Pancake variant)
  const dataWords = eventKey === 'pancakeV3Swap' ? 7 : 5;
  return Object.freeze({
    family: familyName,
    topics: Object.freeze([topic]),
    decode(log, ctx) {
      const pos = requireLog(log);
      if (log.topics[0] !== topic || log.topics.length !== 3) throw new Error('malformed_log');
      topicAddr(log.topics[1]); topicAddr(log.topics[2]);
      const w = words(log.data); if (w.length !== dataWords) throw new Error('malformed_log');
      const amount0 = wordInt(w[0]), amount1 = wordInt(w[1]), sqrtP = wordUint(w[2]);
      if (sqrtP <= 0n || sqrtP >= (1n << 160n)) throw new Error('malformed_log');
      // Signed amounts are from the POOL's point of view: positive = pool received, negative = pool paid out.
      const tokenAmt = ctx.tokenIsToken0 ? amount0 : amount1, quoteAmt = ctx.tokenIsToken0 ? amount1 : amount0;
      let side = 'other';
      if (tokenAmt < 0n && quoteAmt > 0n) side = 'buy';
      else if (tokenAmt > 0n && quoteAmt < 0n) side = 'sell';
      const abs = x => x < 0n ? -x : x;
      const trade = { side, tokenAmount: normAmt(abs(tokenAmt), ctx.tokenDecimals), quoteAmount: normAmt(abs(quoteAmt), ctx.quoteDecimals) };
      trade.execPriceQuote = side !== 'other' ? ratioToNumber(abs(quoteAmt) * POW10(ctx.tokenDecimals), abs(tokenAmt) * POW10(ctx.quoteDecimals)) : null;
      const price = this.spotFromSqrt(sqrtP, ctx);
      return { kind: 'swap', ...pos, trade, sqrtPriceX96: sqrtP, price };
    },
    /* sqrtPriceX96 -> token1/token0 raw ratio = (sqrtP/2^96)^2 */
    spotFromSqrt(sqrtP, ctx) {
      return priceFromRawRatio({ rawToken1PerToken0Num: sqrtP * sqrtP, rawToken1PerToken0Den: Q96 * Q96, dec0: ctx.dec0, dec1: ctx.dec1, tokenIsToken0: ctx.tokenIsToken0 });
    },
    stateCalls: pool => { const addr = typeof pool === 'string' ? pool : pool.address; return [{ method: 'eth_call', params: [{ to: addr, data: SEL.slot0 }, 'latest'] }, { method: 'eth_call', params: [{ to: addr, data: SEL.liquidity }, 'latest'] }]; },
    parseState(results, ctx) {
      if (!results[0]?.ok) throw new Error('state_read_failed');
      const sqrtP = readUint(results[0].result, 0) & ((1n << 160n) - 1n);
      const liquidity = results[1]?.ok ? readUint(results[1].result, 0) : null;
      if (sqrtP === 0n) return { price: null, sqrtPriceX96: 0n, liquidity, empty: true };
      return { price: this.spotFromSqrt(sqrtP, ctx), sqrtPriceX96: sqrtP, liquidity, empty: liquidity === 0n };
    }
  });
}
export const uniswapV3 = v3Handler('v3', 'v3Swap');
export const pancakeV3 = v3Handler('v3', 'pancakeV3Swap');



/* ---------- Uniswap V4 singleton PoolManager ----------
 * V4 pools are identified by a bytes32 poolId, not by individual pool contracts. Swap logs are emitted
 * by the shared PoolManager and carry poolId as indexed topic[1]. State is read through StateView. */
export const uniswapV4 = Object.freeze({
  family: 'v4',
  topics: Object.freeze([TOPIC.v4Swap]),
  matches(log, ctx) { return !!(log && Array.isArray(log.topics) && log.topics[1] && log.topics[1].toLowerCase() === String(ctx.poolId || '').toLowerCase()); },
  decode(log, ctx) {
    const pos = requireLog(log);
    if (log.topics[0] !== TOPIC.v4Swap || log.topics.length !== 3 || !this.matches(log, ctx)) throw new Error('malformed_log');
    topicAddr(log.topics[2]);
    const w = words(log.data); if (w.length !== 6) throw new Error('malformed_log');
    const amount0 = BigInt.asIntN(128, wordUint(w[0])), amount1 = BigInt.asIntN(128, wordUint(w[1]));
    const sqrtP = wordUint(w[2]);
    if (sqrtP <= 0n || sqrtP >= (1n << 160n)) throw new Error('malformed_log');
    const tokenAmt = ctx.tokenIsToken0 ? amount0 : amount1, quoteAmt = ctx.tokenIsToken0 ? amount1 : amount0;
    let side = 'other';
    if (tokenAmt < 0n && quoteAmt > 0n) side = 'buy';
    else if (tokenAmt > 0n && quoteAmt < 0n) side = 'sell';
    const abs = x => x < 0n ? -x : x;
    const trade = { side, tokenAmount: normAmt(abs(tokenAmt), ctx.tokenDecimals), quoteAmount: normAmt(abs(quoteAmt), ctx.quoteDecimals) };
    trade.execPriceQuote = side !== 'other' && tokenAmt !== 0n ? ratioToNumber(abs(quoteAmt) * POW10(ctx.tokenDecimals), abs(tokenAmt) * POW10(ctx.quoteDecimals)) : null;
    const price = this.spotFromSqrt(sqrtP, ctx);
    return { kind: 'swap', ...pos, trade, sqrtPriceX96: sqrtP, price };
  },
  spotFromSqrt(sqrtP, ctx) {
    return priceFromRawRatio({ rawToken1PerToken0Num: sqrtP * sqrtP, rawToken1PerToken0Den: Q96 * Q96, dec0: ctx.dec0, dec1: ctx.dec1, tokenIsToken0: ctx.tokenIsToken0 });
  },
  stateCalls(pool) {
    const id = typeof pool === 'string' ? null : pool.poolId;
    const view = typeof pool === 'string' ? null : pool.stateView;
    if (!id || !view) throw new Error('v4_pool_metadata_missing');
    return [
      { method: 'eth_call', params: [{ to: view, data: SEL.v4GetSlot0 + id.slice(2) }, 'latest'] },
      { method: 'eth_call', params: [{ to: view, data: SEL.v4GetLiquidity + id.slice(2) }, 'latest'] }
    ];
  },
  parseState(results, ctx) {
    if (!results[0]?.ok || !results[1]?.ok) throw new Error('state_read_failed');
    const sqrtP = readUint(results[0].result, 0) & ((1n << 160n) - 1n);
    const liquidity = readUint(results[1].result, 0);
    if (sqrtP === 0n) return { price: null, sqrtPriceX96: 0n, liquidity, empty: true };
    return { price: this.spotFromSqrt(sqrtP, ctx), sqrtPriceX96: sqrtP, liquidity, empty: liquidity === 0n };
  }
});

export const HANDLERS = Object.freeze({ uniswap_v2: v2, pancake_v2: v2, quickswap_v2: v2, uniswap_v3: uniswapV3, pancake_v3: pancakeV3, uniswap_v4: uniswapV4 });
export function handlerFor(protocolId) { const h = HANDLERS[protocolId]; if (!h) throw new Error('unsupported_protocol'); return h; }
