# Saturn account-ban enforcement patch

This patch adds server-side enforcement for the `ban` moderation action.

- Admin moderation accepts `warn`, `restrict`, and `ban`.
- A `ban` stores `moderation/{uid}.status = "banned"`, a reason/since/by record, and `enforced = true`.
- Authenticated Saturn API routes return HTTP 403 with `error: "account_banned"` for a banned account.
- The authenticated `/api/account` route remains available (subject to the existing Saturn session check) and returns `access: "banned"` plus moderation details so the frontend can show the banned-account screen.
- `Lift` clears the ban and restores API access.
- `warn` and `restrict` remain recorded moderation actions and do not block features in this patch.
- This is Saturn backend enforcement only. It cannot prevent a wallet from interacting directly with Solana or other third-party applications.

RPC compatibility fix: the backend read-only RPC allowlist also includes `getSlot` and `getTokenAccountBalance`, which the supplied Saturn frontend calls. These methods are read-only; no transaction-signing or wallet-secret behavior was changed.

Validation: `npm test` — 132 tests passed.

After deploying this backend patch, the main Saturn frontend still needs a small UI change to display the ban screen when `/api/account` returns `access: "banned"`. Upload the exact current live Saturn HTML separately before making that frontend change.
