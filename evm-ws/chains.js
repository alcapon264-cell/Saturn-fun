/* Static EVM chain / protocol configuration.
 *
 * IMPORTANT: addresses below are configuration, not proof. At startup the engine checks every chain's eth_chainId and
 * eth_getCode for every factory and wrapped-native token; an entry that fails is DISABLED and reported by /healthz.
 * Pool addresses are never taken from this file or from the browser: each pool is re-derived from the factory
 * (getPair/getPool) and cross-checked against the pool's own token0()/token1().
 *
 * Only the Robinhood Chain factory/WETH come from the existing Saturn backend (lib/evm.js). All other addresses were
 * entered from public protocol deployment docs and have NOT been confirmed against a live RPC from the build sandbox.
 */
const a = s => s.toLowerCase();
const V3_FEES_UNI = Object.freeze([100, 500, 3000, 10000]);
const V3_FEES_PANCAKE = Object.freeze([100, 500, 2500, 10000]);

export const CHAIN_CONFIG = Object.freeze({
  eth: {
    key: 'eth', chainId: 1, slug: 'eth_mainnet', native: { symbol: 'ETH', wrapped: a('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), coinbase: 'ETH-USD' },
    stables: { [a('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')]: 'USDC', [a('0xdAC17F958D2ee523a2206206994597C13D831ec7')]: 'USDT', [a('0x6B175474E89094C44Da98b954EedeAC495271d0F')]: 'DAI' },
    protocols: [
      { id: 'uniswap_v3', family: 'v3', swap: 'v3Swap', factory: a('0x1F98431c8aD98523631AE4a59f267346ea31F984'), fees: V3_FEES_UNI },
      { id: 'uniswap_v2', family: 'v2', factory: a('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f') },
      { id: 'pancake_v3', family: 'v3', swap: 'pancakeV3Swap', factory: a('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'), fees: V3_FEES_PANCAKE },
      { id: 'pancake_v2', family: 'v2', factory: a('0x1097053Fd2ea711dad45caCcc45EfF7548fCB362') }
    ]
  },
  bsc: {
    key: 'bsc', chainId: 56, slug: 'bsc_mainnet', native: { symbol: 'BNB', wrapped: a('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'), coinbase: 'BNB-USD' },
    stables: { [a('0x55d398326f99059fF775485246999027B3197955')]: 'USDT', [a('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d')]: 'USDC', [a('0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3')]: 'DAI' },
    protocols: [
      { id: 'pancake_v3', family: 'v3', swap: 'pancakeV3Swap', factory: a('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'), fees: V3_FEES_PANCAKE },
      { id: 'pancake_v2', family: 'v2', factory: a('0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73') },
      { id: 'uniswap_v3', family: 'v3', swap: 'v3Swap', factory: a('0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7'), fees: V3_FEES_UNI },
      { id: 'uniswap_v2', family: 'v2', factory: a('0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6') }
    ]
  },
  base: {
    key: 'base', chainId: 8453, slug: 'base_mainnet', native: { symbol: 'ETH', wrapped: a('0x4200000000000000000000000000000000000006'), coinbase: 'ETH-USD' },
    stables: { [a('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')]: 'USDC', [a('0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb')]: 'DAI' },
    protocols: [
      { id: 'uniswap_v3', family: 'v3', swap: 'v3Swap', factory: a('0x33128a8fC17869897dcE68Ed026d694621f6FDfD'), fees: V3_FEES_UNI },
      { id: 'uniswap_v2', family: 'v2', factory: a('0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6') },
      { id: 'pancake_v3', family: 'v3', swap: 'pancakeV3Swap', factory: a('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'), fees: V3_FEES_PANCAKE },
      { id: 'pancake_v2', family: 'v2', factory: a('0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E') }
    ]
  },
  arb: {
    key: 'arb', chainId: 42161, slug: 'arb_mainnet', native: { symbol: 'ETH', wrapped: a('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'), coinbase: 'ETH-USD' },
    stables: { [a('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')]: 'USDC', [a('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9')]: 'USDT', [a('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1')]: 'DAI' },
    protocols: [
      { id: 'uniswap_v3', family: 'v3', swap: 'v3Swap', factory: a('0x1F98431c8aD98523631AE4a59f267346ea31F984'), fees: V3_FEES_UNI },
      { id: 'uniswap_v2', family: 'v2', factory: a('0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9') },
      { id: 'pancake_v3', family: 'v3', swap: 'pancakeV3Swap', factory: a('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'), fees: V3_FEES_PANCAKE },
      { id: 'pancake_v2', family: 'v2', factory: a('0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E') }
    ]
  },
  poly: {
    key: 'poly', chainId: 137, slug: 'polygon_mainnet', native: { symbol: 'POL', wrapped: a('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'), coinbase: 'POL-USD' },
    stables: { [a('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359')]: 'USDC', [a('0xc2132D05D31c914a87C6611C10748AEb04B58e8F')]: 'USDT', [a('0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063')]: 'DAI' },
    protocols: [
      { id: 'uniswap_v3', family: 'v3', swap: 'v3Swap', factory: a('0x1F98431c8aD98523631AE4a59f267346ea31F984'), fees: V3_FEES_UNI },
      { id: 'quickswap_v2', family: 'v2', factory: a('0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32') },
      { id: 'uniswap_v2', family: 'v2', factory: a('0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C') }
    ]
  },
  robinhood: {
    key: 'robinhood', chainId: 4663, slug: 'robinhood_mainnet', native: { symbol: 'ETH', wrapped: a('0x0bd7d308f8e1639fab988df18a8011f41eacad73'), coinbase: 'ETH-USD' },
    /* No stablecoin address for Robinhood Chain is known to this codebase, so no stable quote and no on-chain USD reference pool
       is configured: ETH/USD on this chain comes from the same Coinbase spot source the existing /api/evm-market route uses. */
    stables: {},
    protocols: [
      { id: 'uniswap_v3', family: 'v3', swap: 'v3Swap', factory: a('0x1f7d7550b1b028f7571e69a784071f0205fd2efa'), fees: V3_FEES_UNI }
    ]
  }
});

export const CHAIN_KEYS = Object.freeze(Object.keys(CHAIN_CONFIG));
export const CHAIN_ALIASES = Object.freeze({ ethereum: 'eth', arbitrum: 'arb', polygon: 'poly', bnb: 'bsc', 'bnb-chain': 'bsc', 'binance-smart-chain': 'bsc' });
export function chainKey(v) {
  const s = String(v || '').toLowerCase();
  const k = CHAIN_ALIASES[s] || s;
  return Object.prototype.hasOwnProperty.call(CHAIN_CONFIG, k) ? k : null;
}
/* Quote assets Saturn will price against, in preference order: stablecoins first (direct USD), then the wrapped native token. */
export function quoteAssets(cfg) {
  return [...Object.keys(cfg.stables).map(addr => ({ address: addr, kind: 'stable', symbol: cfg.stables[addr] })), { address: cfg.native.wrapped, kind: 'native', symbol: 'W' + cfg.native.symbol }];
}
