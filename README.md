# Saturn EVM WebSocket relay (separate Render service)

This is an additive, standalone service. It does not change the Vercel HTTP API, existing EVM RPC routes, frontend, or Solana WebSocket service.

## What it does

- Uses the existing server-side `BLOCKVECTRA_API_KEY`.
- Reads `GET https://api.blockvectra.com/v1/chains` and only connects to chains explicitly reporting `ws: true` and `subscriptions` containing `newHeads`.
- Maintains at most one upstream BlockVectra WebSocket connection per supported Saturn EVM chain (ETH, Base, Arbitrum, Polygon, Robinhood, BNB).
- Broadcasts read-only block-head notifications to downstream clients at `/live`.
- Provides `/healthz`, heartbeat pings, jittered reconnects, and connection status snapshots.
- Does not expose the BlockVectra API key, accept client RPC commands, or modify trading/signing/launch flows.

## Render setup

Create a **new Web Service** from this folder (`evm-ws`) in the Saturn backend repository. Do not replace the existing Solana WS service.

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Environment variables:
  - `BLOCKVECTRA_API_KEY`: existing BlockVectra key (secret)
  - `ALLOWED_ORIGINS`: comma-separated exact Saturn frontend origins, e.g. `https://saturn-fun.netlify.app`
  - `NODE_ENV`: `production`

Render supplies `PORT`. Health check path: `/healthz`.

## Client contract

Connect from the Saturn frontend to `wss://<new-render-service-host>/live`.

Messages:
- `evm_ws_snapshot`: initial per-chain support/connection state.
- `evm_ws_status`: connection/subscription changes.
- `evm_head`: `{ chain, chainId, number, hash, parentHash, timestamp, receivedAt }`.

Use `evm_head` as a signal to coalesce/trigger the existing authoritative market-data refresh for that chain. Do not calculate market cap from block headers. Keep the existing HTTP/DexScreener/GeckoTerminal data path as the source of truth and fallback. Debounce/coalesce refreshes (one in-flight refresh per chain) to avoid CU/API overload.

## Important scope boundary

This first service streams new block heads only. It deliberately does not subscribe to all logs: BlockVectra requires an address or `topic0` filter, and Saturn's current backend package does not contain the token/pool address registry needed to create precise per-token subscriptions. Adding broad/unfiltered logs is invalid and wasteful. Token/pool-specific logs can be added once the frontend/backend supplies verified pool addresses and event topics.

The service is not active until deployed and the frontend is separately connected to its `/live` URL. No production deployment or frontend change is performed by this ZIP.
