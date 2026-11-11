import test from 'node:test';
import assert from 'node:assert/strict';
import { v2, uniswapV3, pancakeV3, HANDLERS, handlerFor, ratioToNumber } from '../src/protocols.js';
import { addr, v2SwapLog, v2SyncLog, v3SwapLog, pancakeV3SwapLog, sqrtPFromHumanPrice } from './helpers.js';

const close = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel, `${a} !~ ${b}`);
const POOL = addr(0x9001);

/* token has 18 decimals, quote has 6 (USDC-like): the classic decimals-mismatch case */
const ctx = (tokenIsToken0, tokenDecimals = 18, quoteDecimals = 6) => ({ tokenIsToken0, tokenDecimals, quoteDecimals, dec0: tokenIsToken0 ? tokenDecimals : quoteDecimals, dec1: tokenIsToken0 ? quoteDecimals : tokenDecimals });

test('V2: buy/sell direction and decimal normalisation, token = token0', () => {
  // buy 1000 tokens (18d) for 25 quote (6d): pool receives quote (amount1In) and pays tokens (amount0Out)
  const buy = v2.decode(v2SwapLog({ pool: POOL, block: 5, a1in: 25_000_000n, a0out: 1000n * 10n ** 18n }), ctx(true));
  assert.equal(buy.trade.side, 'buy'); close(buy.trade.tokenAmount, 1000); close(buy.trade.quoteAmount, 25); close(buy.trade.execPriceQuote, 0.025);
  const sell = v2.decode(v2SwapLog({ pool: POOL, block: 6, a0in: 400n * 10n ** 18n, a1out: 9_800_000n }), ctx(true));
  assert.equal(sell.trade.side, 'sell'); close(sell.trade.tokenAmount, 400); close(sell.trade.execPriceQuote, 0.0245);
});
test('V2: orientation - the same economic trade decodes identically when the token is token1', () => {
  // token is token1 now, quote is token0
  const buy = v2.decode(v2SwapLog({ pool: POOL, block: 5, a0in: 25_000_000n, a1out: 1000n * 10n ** 18n }), ctx(false));
  assert.equal(buy.trade.side, 'buy'); close(buy.trade.tokenAmount, 1000); close(buy.trade.quoteAmount, 25); close(buy.trade.execPriceQuote, 0.025);
  const sell = v2.decode(v2SwapLog({ pool: POOL, block: 6, a1in: 400n * 10n ** 18n, a0out: 9_800_000n }), ctx(false));
  assert.equal(sell.trade.side, 'sell'); close(sell.trade.execPriceQuote, 0.0245);
});
test('V2: spot price from Sync reserves handles both orientations and decimals', () => {
  // 2,000,000 tokens (18d) vs 50,000 quote (6d) => 0.025 quote per token
  const t0 = v2.decode(v2Sync(2_000_000n * 10n ** 18n, 50_000_000_000n), ctx(true));
  close(v2.spotFromReserves(t0.reserve0, t0.reserve1, ctx(true)), 0.025);
  // swapped: token1 = token, so reserve0 = quote, reserve1 = token
  const t1 = v2.decode(v2Sync(50_000_000_000n, 2_000_000n * 10n ** 18n), ctx(false));
  close(v2.spotFromReserves(t1.reserve0, t1.reserve1, ctx(false)), 0.025);
  assert.equal(v2.spotFromReserves(0n, 5n, ctx(true)), null);
});
function v2Sync(r0, r1) { return v2SyncLog({ pool: POOL, block: 7, r0, r1 }); }

test('V2: flash-swap style mixed legs are classified "other" and never produce an execution price', () => {
  const t = v2.decode(v2SwapLog({ pool: POOL, block: 5, a0in: 5n * 10n ** 18n, a1in: 3_000_000n, a0out: 1n * 10n ** 18n, a1out: 2_000_000n }), ctx(true));
  assert.equal(t.trade.side, 'other'); assert.equal(t.trade.execPriceQuote, null);
});
test('V3: signed amounts + sqrtPriceX96 price, both orientations, 18d token vs 6d quote', () => {
  const price = 0.025;
  // token = token0 (18d), quote = token1 (6d): token1/token0 human price = 0.025
  const sqrtP0 = sqrtPFromHumanPrice(price, 18, 6);
  const buy0 = uniswapV3.decode(v3SwapLog({ pool: POOL, block: 9, amount0: -(1000n * 10n ** 18n), amount1: 25_000_000n, sqrtP: sqrtP0 }), ctx(true));
  assert.equal(buy0.trade.side, 'buy'); close(buy0.trade.execPriceQuote, 0.025); close(buy0.price, price, 1e-9);
  const sell0 = uniswapV3.decode(v3SwapLog({ pool: POOL, block: 9, logIndex: 1, amount0: 400n * 10n ** 18n, amount1: -9_800_000n, sqrtP: sqrtP0 }), ctx(true));
  assert.equal(sell0.trade.side, 'sell'); close(sell0.trade.execPriceQuote, 0.0245);
  // token = token1 (18d), quote = token0 (6d): token1/token0 human price = 1/0.025 = 40
  const sqrtP1 = sqrtPFromHumanPrice(1 / price, 6, 18);
  const buy1 = uniswapV3.decode(v3SwapLog({ pool: POOL, block: 9, amount1: -(1000n * 10n ** 18n), amount0: 25_000_000n, sqrtP: sqrtP1 }), ctx(false));
  assert.equal(buy1.trade.side, 'buy'); close(buy1.price, price, 1e-9); close(buy1.trade.execPriceQuote, 0.025);
});
test('V3: state read (slot0 + liquidity) gives the same price as the event path', () => {
  const sqrtP = sqrtPFromHumanPrice(0.025, 18, 6);
  const word = n => BigInt(n).toString(16).padStart(64, '0');
  const slot0 = '0x' + word(sqrtP) + word(0) + word(0) + word(0) + word(0) + word(0) + word(1);
  const st = uniswapV3.parseState([{ ok: true, result: slot0 }, { ok: true, result: '0x' + word(123456) }], ctx(true));
  close(st.price, 0.025); assert.equal(st.empty, false);
  const empty = uniswapV3.parseState([{ ok: true, result: slot0 }, { ok: true, result: '0x' + word(0) }], ctx(true));
  assert.equal(empty.empty, true); // zero in-range liquidity => rejected as unusable
  assert.equal(uniswapV3.parseState([{ ok: true, result: '0x' + word(0).repeat(7) }, { ok: true, result: '0x' + word(5) }], ctx(true)).empty, true);
});
test('PancakeSwap V3 uses its OWN 9-field event: the Uniswap decoder rejects it and vice versa', () => {
  const sqrtP = sqrtPFromHumanPrice(0.025, 18, 6);
  const uniLog = v3SwapLog({ pool: POOL, block: 9, amount0: -(10n ** 18n), amount1: 25_000n, sqrtP });
  const panLog = pancakeV3SwapLog({ pool: POOL, block: 9, amount0: -(10n ** 18n), amount1: 25_000n, sqrtP });
  assert.notEqual(uniLog.topics[0], panLog.topics[0]);
  assert.equal(pancakeV3.decode(panLog, ctx(true)).trade.side, 'buy');
  assert.equal(uniswapV3.decode(uniLog, ctx(true)).trade.side, 'buy');
  assert.throws(() => uniswapV3.decode(panLog, ctx(true)), /malformed_log/);
  assert.throws(() => pancakeV3.decode(uniLog, ctx(true)), /malformed_log/);
});
test('handlers are chosen per verified protocol id (no universal decoder)', () => {
  assert.equal(handlerFor('pancake_v3'), pancakeV3); assert.equal(handlerFor('uniswap_v3'), uniswapV3);
  assert.equal(handlerFor('uniswap_v2'), v2); assert.equal(handlerFor('pancake_v2'), v2); assert.equal(handlerFor('quickswap_v2'), v2);
  assert.throws(() => handlerFor('solidly_cl'), /unsupported_protocol/);
  assert.deepEqual([...v2.topics].length, 2); assert.equal(uniswapV3.topics.length, 1);
});
test('malformed logs throw (and are caught by the engine) instead of producing a price', () => {
  const good = v2SwapLog({ pool: POOL, block: 5, a1in: 1n, a0out: 1n });
  assert.throws(() => v2.decode({ ...good, data: good.data.slice(0, -2) }, ctx(true)), /abi_bad_length|malformed_log/);
  assert.throws(() => v2.decode({ ...good, topics: [good.topics[0]] }, ctx(true)), /malformed_log/);
  assert.throws(() => v2.decode({ ...good, blockHash: '0x12' }, ctx(true)), /malformed_log/);
  assert.throws(() => v2.decode(null, ctx(true)), /malformed_log/);
  assert.throws(() => uniswapV3.decode(v3SwapLog({ pool: POOL, block: 1, amount0: 1n, amount1: -1n, sqrtP: 0n }), ctx(true)), /malformed_log/);
});
test('ratioToNumber keeps precision for tiny prices', () => { close(ratioToNumber(1n, 10n ** 12n), 1e-12); assert.throws(() => ratioToNumber(1n, 0n)); });
