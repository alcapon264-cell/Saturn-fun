# Saturn EVM market-data relay (separate Render service) — v2

Standalone service. It does not change the Vercel HTTP API, the Solana WebSocket service, or any wallet/trading/signing flow.

## What it does now

```
swap log (BlockVectra WS, address+topic filtered)
 → protocol-specific decoder (Uniswap V2-style / Uniswap V3 / PancakeSwap V3)   src/protocols.js
 → pool state + token/quote price (decimals + token0/token1 orientation)         src/engine.js
 → quote-token USD (stable / on-chain reference pool / labelled Coinbase spot)   src/quote.js
 → FDV = price × totalSupply  (circulating market cap is reported "unavailable")  src/engine.js
 → evm_market message to browsers subscribed to that token only                  src/hub.js
```

Browsers subscribe by **token** (`chain` + `token`). The relay discovers pools itself and accepts a pool only if the chain's factory
returns it for the (token, quote[, fee]) pair, the pool's own `token0()/token1()` match, and its state is non-empty. Browsers can never
name a pool, RPC URL or RPC method, and raw logs are never sent to browsers.

| File | Role |
|---|---|
| `server.js` | entry point (reads env, starts `createApp`) |
| `src/app.js` | wiring, `/healthz`, WebSocket upgrade, origin + per-IP limits |
| `src/chains.js` | per-chain config (factories, wrapped native, stables) — **verified at startup, see below** |
| `src/rpc.js` | server-side JSON-RPC (read-only allowlist, batching) |
| `src/registry.js` | chain verification, decimals/supply caches, pool discovery + verification |
| `src/protocols.js` | V2 / V3 / Pancake V3 decoders and price math |
| `src/quote.js` | quote-token → USD with TTL cache and fallbacks |
| `src/engine.js` | dedupe, reorg, backfill/recovery, reconcile, FDV, publish |
| `src/upstream.js` | BlockVectra WebSocket per chain, reconnect + resubscribe |
| `src/hub.js` | validation, limits, coalescing, backpressure |
| `scripts/live-check.mjs` | **live** read-only RPC verification (run it yourself, needs the key) |
| `tests/*.test.js` | **offline** tests (mocked RPC / fake sockets) |

## Client contract (`wss://<host>/live`)

Browser → relay
- `{"type":"subscribe_token","chain":"eth|bsc|base|arb|poly|robinhood","token":"0x…"}` (max 8 per client)
- `{"type":"unsubscribe_token","chain":"…","token":"0x…"}`, `{"type":"ping"}`
- `subscribe_pool` (old contract) is answered with `evm_error: subscribe_pool_deprecated`.

Relay → browser
- `evm_hello`, `evm_ws_snapshot`, `evm_ws_status` (unchanged names), `evm_subscribed {status: live|no_pools|error}`.
- `evm_market`: `priceUsd, priceQuote, quoteToken, quoteUsd, quoteUsdBasis, fdvUsd, mcKind:"fdv", totalSupply, circulatingMarketCapUsd:null, circulatingStatus:"unavailable", liquidityUsd, primaryPool, pools[], trade, block, seq, trigger, reorg, usdAvailable, timing{receivedAt,decodeMs,priceMs,mcMs,serverMs}, sentAt`.
- `evm_token_status {status:"degraded"|…}` when the chain feed is down (clients fall back to HTTP).
- `evm_head` only to clients watching a token on that chain, at most 1/s/chain. `evm_error {code}`.

## Startup verification (important)
Addresses in `src/chains.js` are configuration, not proof. At boot the relay checks `eth_chainId` and `eth_getCode` for every factory and
wrapped-native token; failures disable that protocol/chain and show in `/healthz → verification`. Only the Robinhood factory/WETH come from
the existing Saturn backend; the rest were entered from public deployment docs and were **not** confirmed live during development.
Run `node scripts/live-check.mjs` once before relying on a chain.

## Render setup
New or existing Web Service from this folder. Build `npm install`, start `npm start`, health check `/healthz`.

Required env: `BLOCKVECTRA_API_KEY` (secret), `ALLOWED_ORIGINS` (exact frontend origins, comma-separated).
Optional env (defaults in parentheses): `EVM_MAX_TOKENS_PER_CLIENT` (8), `EVM_MAX_TOKENS` (500), `EVM_MIN_POOL_TVL_USD` (1000),
`EVM_RECONCILE_MS` (120000, 0 = off), `EVM_MAX_BACKFILL_BLOCKS` (2000), `EVM_QUOTE_TTL_MS` (15000), `EVM_REF_POOL_MIN_USD` (100000), `EVM_MAX_CONN_PER_IP` (20).

## Tests
`npm test` (offline). `npm run live-check` (live, read-only, needs `BLOCKVECTRA_API_KEY`).
