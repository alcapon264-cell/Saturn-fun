# Saturn BNB holders — shared-guard backend patch

This patch adds BNB Chain token-holder data to the existing Saturn backend without a standalone API handler or a second CORS/authentication implementation.

## Changes
- Adds `lib/bnbHolders.js`, a GoldRush/Covalent BNB mainnet adapter.
- Adds `/api/bnb-holders` to `api/[route].js`.
- Calls the adapter from `lib/app.js` through Saturn's existing `guard()`.
- Reuses `SATURN_ALLOWED_ORIGINS` and `SATURN_EXTRA_ALLOWED_ORIGINS`.
- Uses the same public-data policy and per-IP request limit as `/api/evm-holders`. This is public on-chain holder data, not private account data.
- Adds mocked tests and appends them to the existing `npm test` command without removing current tests.

## Apply
1. Copy `lib/bnbHolders.js` into the backend repository's `lib/` folder.
2. Copy `tests/bnbHolders.test.js` into `tests/`.
3. Run `node scripts/apply-bnb-holders-integration.mjs` from the repository root. It makes targeted changes to `lib/app.js`, `api/[route].js`, and `package.json`, and stops if its expected anchors are missing.
4. Review the diff. Confirm the route is exported from `createApp()` and mapped in `api/[route].js`.
5. Run `npm test`.
6. Commit and deploy only after the diff and tests pass.

## Vercel environment
Set `GOLDRUSH_API_KEY` in the **Production** environment for `saturn-backend`, then redeploy. Never put this key in HTML, GitHub, a query string, or a public frontend variable.

No `ALLOWED_ORIGINS` variable is required. The route uses Saturn's shared `SATURN_ALLOWED_ORIGINS` / `SATURN_EXTRA_ALLOWED_ORIGINS` CORS policy. The shared guard handles OPTIONS and permits `Authorization` and `X-Saturn-Session`.

## Endpoint
`GET /api/bnb-holders?token=0x...&limit=50&cursor=0`

The route uses GoldRush `bsc-mainnet`, validates provider rows, and returns only real provider metadata. It does not fabricate holders, supply, or percentages.

## Test scope
Mocked tests cover missing key, address/cursor validation, endpoint selection, server-side key handling, pagination, zero-balance filtering, malformed provider data, provider auth/rate-limit/network errors, deduplication, and cache reuse. They do not verify the live GoldRush key entitlement or deployed Vercel route. After deployment, verify one known BNB token with a Saturn session and inspect Vercel function logs.
