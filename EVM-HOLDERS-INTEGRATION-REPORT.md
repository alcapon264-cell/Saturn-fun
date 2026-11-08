# Saturn backend — EVM holders route integration

## Changes made
- Added `GET /api/evm-holders` to the existing shared Vercel API router (`api/[route].js`).
- Wired the route into `lib/app.js` using Saturn's existing CORS/origin guard and per-IP rate limiter.
- Kept holder lookup public (no sign-in required), as market holder data is public, while keeping the Moralis API key server-side.
- Added `tests/evm-holders.test.js` to the existing `npm test` command without removing any prior tests.
- Documented the required Vercel environment variables in `SETUP.md`.

## Required Vercel environment variables
- `EVM_HOLDERS_PROVIDER=moralis`
- `EVM_HOLDERS_API_KEY=<your Moralis API key>`

Enter the API key directly in Vercel → Project → Settings → Environment Variables. Do not put it in GitHub, the frontend HTML, or this ZIP. Redeploy after adding it.

## Verification
- `npm test`: **158 passed, 0 failed**.
- `node --check` across all JavaScript files: passed.
- Tests use mocked provider responses. No live Moralis request, wallet operation, blockchain transaction, deployment, or GitHub change was performed.
- The provider adapter's live response shape remains to be verified after deployment with a valid EVM token contract.

## Scope preserved
No existing route, Firestore rule, auth/session policy, wallet flow, trading code, Solana RPC code, or deployment setting was intentionally changed. Existing backend files are retained in this ZIP.
