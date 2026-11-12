# Saturn LI.FI backend proxy — Stage 1

This patch adds **authenticated quote and transfer-status proxy endpoints only**. It does not execute or sign transactions.

## New environment variable

- `LIFI_API_KEY` — optional LI.FI API key. Keep it in Vercel project environment variables only; never add it to the HTML or commit it to GitHub. LI.FI currently permits limited unauthenticated requests, but an API key is recommended for higher limits. If omitted, the proxy calls LI.FI without the key.

## New API endpoints

Both endpoints require Saturn authentication and a valid Saturn session, and use the existing origin allowlist, ban enforcement and route rate limiting.

- `GET /api/lifi-quote?fromChain=...&toChain=...&fromToken=...&toToken=...&fromAddress=...&toAddress=...&fromAmount=...&slippage=0.03`
- `GET /api/lifi-status?txHash=...&fromChain=...&toChain=...&bridge=...`

These are handled by Saturn's existing `api/[route].js` dynamic route.

Chain IDs accepted by the proxy:

| Network | LI.FI chain ID |
|---|---:|
| Solana | 1151111081099710 |
| Ethereum | 1 |
| Base | 8453 |
| Arbitrum | 42161 |
| Polygon | 137 |
| Robinhood Chain | 4663 |
| BNB Chain | 56 |

Token addresses must be supplied in LI.FI format. Native SOL uses `11111111111111111111111111111111`; native EVM assets use `0x0000000000000000000000000000000000000000`.

## Important limitations

- Stage 1 does not add frontend integration.
- Stage 1 does not sign, submit, approve, or execute transactions.
- The quote endpoint returns a route only when LI.FI supplies both an executable `transactionRequest` and an `estimate`.
- A quote is not proof that the wallet has sufficient funds or that execution will succeed.
- The status endpoint only relays LI.FI transfer status; the frontend must not mark a transfer complete until LI.FI reports destination delivery.
- LI.FI support is determined by real quote availability. A chain accepted by Saturn's input validator is not necessarily supported by LI.FI liquidity.

## Tests

Run `npm test` from the backend root. The added LI.FI tests use mocked provider responses and do not make live network or blockchain calls.
