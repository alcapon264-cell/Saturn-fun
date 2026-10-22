# Saturn backend — setup

Deploy this folder as its own Vercel project (same way as the Irys backend). Needs Node >= 20; `npm install` pulls firebase-admin.

## Environment variables (Vercel → Settings → Environment Variables, Production)
| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | the full service-account JSON (Firebase Console → Project settings → Service accounts → Generate new private key). SERVER-SIDE ONLY. |
| `SOLANA_RPC_URL` | your QuickNode mainnet URL (server-side only) |
| `SATURN_ALLOWED_ORIGINS` | comma-separated exact origins, e.g. `https://thunderous-marshmallow-0bceda.netlify.app` (the owner page must be on an allowed origin too) |
| `OWNER_UIDS` | comma-separated Firebase UIDs of the owner(s). Empty = nobody is owner (fail closed). |
| `PLATFORM_TREASURY_WALLET` | `7XGVo8SdqUeTP7dFgj3xC7PcmMA6wet4srqnSqnjCSSv` (public address; used to measure fee/treasury movement on-chain) |

## Firebase console, once
1. Build → Firestore Database → Create database (production mode).
2. Firestore → Rules → paste `firestore.rules` → Publish.
3. Authentication → Settings → Authorized domains → add your Netlify domain (and the backend/owner page domain if different).
4. Find your owner UID: sign in once at `owner.html` (it will say "not authorized"), then Firebase Console → Authentication → Users → copy your UID → put it in `OWNER_UIDS` → redeploy.

## Frontend
Set `BACKEND_URL` (one line) in BOTH `index-14.html` and `owner.html` to the deployed backend origin. While it is empty the sync code does nothing and the account page hides the Saturn-account section.

## Collections (all written only by the backend)
`users/{uid}`, `walletLinks/{wallet}`, `events/{signature}` (trade | launch | signup | wallet_link), `errors/{signature}`.

## Privy tokens (added)
The backend now accepts EITHER a Firebase ID token or a Privy access token on `/api/account`, `/api/link-wallet`, `/api/events` and `/api/owner`.
- Privy tokens are verified locally (ES256 JWT, `iss=privy.io`, `aud` = your App ID, `exp` required) with node:crypto against your app's PUBLIC verification key. **No Privy secret is used or needed.**
- The Privy user's identity (`uid`) is their DID, e.g. `did:privy:cm...`. Firebase users keep their existing uid and data unchanged. A Firebase uid starting with `did:privy:` is rejected.
- Add two environment variables (Vercel → Production), then redeploy:
  | Name | Value |
  |---|---|
  | `PRIVY_APP_ID` | your Privy App ID (public; the page already contains it) |
  | `PRIVY_VERIFICATION_KEY` | Privy dashboard → your app → Settings → Basics → **Verification key** (the PEM public key; pasting it with `\n` escapes is fine) |
- Until BOTH are set (and the key is a P-256 EC public key), every Privy token is rejected (fail closed).
- To make a Privy account the owner, put its DID in `OWNER_UIDS` (comma-separated, alongside any Firebase uid).
- NOT done: the same person using Firebase AND Privy has two separate accounts (two uids). Merging them needs a deliberate identity-linking step with a proof from both sides; it is not automatic.

## Public profile registry (r12) — search traders, public profiles
New routes (all `POST`, same CORS/rate-limit guard as the others): `/api/profile-save` (sign-in required), `/api/profile-get`, `/api/profile-search` (public).
- **No new environment variables.** Uses the same Firebase Admin / Firestore / Privy verification already configured.
- **Ownership:** `profile-save` requires a verified token (Firebase or Privy) AND `walletLinks/{wallet}.uid` equal to that account's uid — i.e. the wallet was linked through the existing signed `/api/link-wallet` flow. The browser's wallet value alone is never trusted.
- **Collections (written only by the backend):** `profiles/{wallet}` = `{wallet, username, displayName, nameLower, bio, avatar, uid, createdAt, updatedAt}`; `usernames/{lowercase username}` = `{wallet, uid, claimedAt}` (the uniqueness claim). `uid` is private and never returned.
- **Atomicity:** `profileUpsert` / `profileRemove` are Firestore transactions (read profile + username claim, then release old name / claim new / write profile).
- **Search:** prefix range queries on `profiles.username` and `profiles.nameLower` (`>= q` and `< q+''`, limit 16) + exact wallet doc lookup. These use Firestore's automatic single-field indexes: **no composite index is required.**
- **Firestore rules:** no change. The existing catch-all (`allow read, write: if false`) already blocks clients from `profiles` and `usernames`; the Admin SDK bypasses it.
- **Not stored:** followers, following, P&L, trades (not real server data). Avatar = JPEG data URL ≤32 KB only (no URLs); no image hosting is introduced.
- **Frontend flag:** `SYNC_CONFIG.PROFILES` ('off' → 'on') after deploying this backend.
- **Tests:** `npm test` (adds `tests/profiles.test.js`; uses `tests/fake-firestore.js`, a Firestore-SHAPED fake — it does not prove real-Firestore behaviour).
