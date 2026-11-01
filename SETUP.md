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


## Inbox notifications (added)
The shared `/api/[route]` router exposes two authenticated POST routes:
- `/api/notifications-list` returns up to 100 notifications belonging only to the verified account.
- `/api/notifications-read` accepts `{"ids":[...]}` or `{"all":true}` and marks only that account's records as read.

The backend creates welcome notifications when an account is first created, follow notifications when a linked wallet is followed, and trade notifications for accounts whose linked wallets follow a trader. Trade notifications are created only after `/api/events` has verified the transaction against Solana RPC. Inbox records are server-side Firestore documents in `notifications/`; clients cannot read or write them directly because the catch-all Firestore rule denies client access. These are in-app inbox notifications, not browser push notifications.

## Current frontend routes not implemented by this backend
The current `Saturn-INBOX-r2.html` also calls `/api/rewards` and `/api/copy-count`; neither is implemented in this ZIP. Do not enable reward claims or treat copy counts as server-confirmed until those backend contracts and their security/ledger rules are implemented and tested. `/api/link-nonce` is also not implemented, but the current frontend uses `LINK_MODE: 'legacy'` and the existing signed `/api/link-wallet` route; leave that mode unchanged.


## Inbox notifications (added)
The shared `/api/[route]` router exposes two authenticated POST routes:
- `/api/notifications-list` returns up to 100 notifications belonging only to the verified account.
- `/api/notifications-read` accepts `ids` or `all: true` and marks only that account's records as read.

The backend creates welcome notifications when an account is first created, follow notifications when a linked wallet is followed, and trade notifications for accounts whose linked wallets follow a trader. Trade notifications are created only after `/api/events` has verified the transaction against Solana RPC. Inbox records are server-side Firestore documents in `notifications/`; clients cannot read or write them directly because the catch-all Firestore rule denies client access. These are in-app inbox notifications, not browser push notifications.

## Current frontend routes not implemented by this backend
The current `Saturn-INBOX-r2.html` also calls `/api/rewards` and `/api/copy-count`; neither is implemented in this ZIP. Do not enable reward claims or treat copy counts as server-confirmed until those backend contracts and their security/ledger rules are implemented and tested. `/api/link-nonce` is also not implemented, but the current frontend uses `LINK_MODE: 'legacy'` and the existing signed `/api/link-wallet` route; leave that mode unchanged.

## Inbox notifications (added)
The shared `/api/[route]` router exposes two authenticated POST routes:
- `/api/notifications-list` returns up to 100 notifications belonging only to the verified account.
- `/api/notifications-read` accepts `ids` or `all: true` and marks only that account's records as read.

The backend creates welcome notifications when an account is first created, follow notifications when a linked wallet is followed, and trade notifications for accounts whose linked wallets follow a trader. Trade notifications are created only after `/api/events` has verified the transaction against Solana RPC. Inbox records are server-side Firestore documents in `notifications/`; clients cannot read or write them directly because the catch-all Firestore rule denies client access. These are in-app inbox notifications, not browser push notifications.

## Current frontend routes not implemented by this backend
The current `Saturn-INBOX-r2.html` also calls `/api/rewards` and `/api/copy-count`; neither is implemented in this ZIP. Do not enable reward claims or treat copy counts as server-confirmed until those backend contracts and their security/ledger rules are implemented and tested. `/api/link-nonce` is also not implemented, but the current frontend uses `LINK_MODE: 'legacy'` and the existing signed `/api/link-wallet` route; leave that mode unchanged.


## Community identity and inbox deduplication patch

- Community posts now resolve `by` and `ph` from the saved public profile for the authenticated user's linked wallet. Client-supplied display names are ignored.
- Follow notifications use a stable ID derived from the follow edge, so retrying the same follow action does not create another alert.
- The inbox returns only the newest follow alert per source wallet, which also hides repeated legacy alerts from the same follower.
- Existing community messages are not rewritten; the corrected identity is applied to new posts.


## Settings system (index-47)
Everything is on the existing `POST /api/settings` route (no new Vercel function). Actions: `get`, `save`, `session-register|list|revoke|revoke-others|end`, `blocks-list`, `block`, `unblock`, `report`, `delete-account`. Code: `lib/settings.js`; wiring in `lib/app.js`.
- **No new environment variables.**
- **Firestore rules:** deploy the updated `firestore.rules` (new collections are explicitly Admin-SDK only).
- **Firestore index (required for account deletion):** `firestore.indexes.json` adds a collection-group single-field index on `messages.uid` (used to delete a user's community messages). Deploy with `firebase deploy --only firestore:indexes` or create it in the console. Until it exists, deletion answers `deletion_incomplete` and removes nothing about the sign-in.
- **CORS:** `X-Saturn-Session` is now an allowed request header.
- **Sessions:** once an account registers a session (the new frontend does this automatically), every authenticated request must carry a live `x-saturn-session` header. Older cached frontends of an account that already registered will get 401 until reloaded.
- **Limits you should know:** community room messages are public Firestore reads, so a block/private profile cannot hide messages already posted there; new posts from a Private account are anonymous. A revoked device that still holds a valid Google/Privy sign-in can sign in again.
- Tests: `npm test` (settings tests are in `tests/settings.test.js`). `tests/identity.test.js` and `tests/integration.test.js` are not in the npm script; 2 of their tests fail in the original zip as well (createPair atomicity source-check, integration file).
