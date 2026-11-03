# Saturn Admin — setup, security model and deployment

Nothing here has been deployed. Every step below is yours to run.

## 1. What was added

| Item | Where |
|---|---|
| Admin API (one route, action-based, server-side authorization) | `POST /api/admin` — `lib/admin.js` |
| Targeted report intake (token / user / community message + up to 3 JPEG evidence images) | `POST /api/report` — `lib/reports.js` |
| Firestore deny rules for admin collections | `firestore.rules` |
| Tests | `tests/admin.test.js` (21 tests; included in `npm test`) |
| Read-only RPC health probe | `lib/deps.js` → `rpc.getHealth()` (existing methods untouched) |

Existing routes, trading, wallets, token creation, Rewards, Community, Settings, RPC proxy and the WebSocket are unchanged. `lib/community.js` and `lib/settings.js` are byte-identical to the original ZIP.

## 2. Security model

- Admin requests need a **Firebase (Google) ID token**; the token is verified server-side with revocation checking. Privy tokens are not accepted for admin.
- **Owner** = a UID listed in `OWNER_UIDS` (server environment variable only). Empty list = nobody is owner (fails closed). Owner is never stored in or editable through the database.
- **Moderator / support / finance** roles live in `adminRoles/{uid}` and can be assigned/removed only by the owner (`roles.manage`). The owner role cannot be assigned. Admins cannot edit themselves, and moderation cannot target the owner, yourself or another admin.
- Every action checks its permission on the server. A frontend flag is never trusted.
- Sign-in must be within the last 12 hours (`session_expired` otherwise).
- **Audit records** (`adminAudit`, owner-readable under Activity log): every successful mutation (report update, warn/restrict/lift, role set/remove) and every permission denial of an *authorised* admin (`ok:false`). Each mutation writes its audit record **in the same Firestore transaction** as the change, so if the audit write fails the whole operation is aborted and an error is returned: a change can never complete without its record. Requests that fail validation or find nothing to change (not found, reason missing) change nothing and write no audit record. The permission-denial audit entry is a separate best-effort write (no change has happened).
- **Security alerts** (`adminSecurity`, Security → alerts): every access attempt by a signed-in account that is *not* an administrator (`unauthorized_admin_access`, limited to 10 records/min per IP) and every permission denial of an administrator (`permission_denied`). Non-admin attempts are deliberately **not** written to `adminAudit`, so an ordinary user cannot fill the audit log. Authorised logins go to `adminLogins`.
- Rate limits: 120 requests/min per IP on the route, 30 mutations/min, 10 denied-attempt records/min, reports 10/min plus the existing 30 s per-user gap.
- Input is validated (UID, mint, signature, room and report-id formats; lengths; control characters stripped). Errors never include internals.
- No private keys, seed phrases, service accounts or admin secrets are in the admin frontend. The only configuration it contains is the same **public** Firebase web config the public Saturn site already ships.
- Moderation is **inside Saturn only and record-only**. It never touches a Solana asset or transaction, and nothing in Saturn enforces a restriction yet (see §8).

## 3. Roles

| Role | Permissions |
|---|---|
| owner | everything, including roles, audit log, logins, alerts |
| moderator | overview, users, tokens, reports (read/write), warn/restrict records, community |
| support | overview, users, tokens, reports (read only) |
| finance | overview, tokens, trades, rewards (read only) |

## 4. Secure owner provisioning (no UID or email is invented)

1. Deploy the admin site (§6) and add its domain to Firebase (§5).
2. Open `https://saturn-admin.netlify.app` and sign in with Google. You will see "This account is not an authorised Saturn administrator" plus your **Account UID**. Copy it.
3. Vercel → project `saturn-backend` → Settings → Environment Variables → set `OWNER_UIDS` to that UID (comma-separated if you already have owners; keep the existing ones) → redeploy.
4. Sign in again. You are now Owner. Add moderators under Security → Admin accounts using their Saturn user UID (they must have signed in to Saturn once).

## 5. External steps that require your account

1. **Firebase Console → Authentication → Settings → Authorized domains → add `saturn-admin.netlify.app`.** Without it Google sign-in fails with `auth/unauthorized-domain`.
2. **Google Cloud Console → APIs & Services → Credentials → your Browser API key:** if it has an HTTP-referrer restriction, add `https://saturn-admin.netlify.app/*`.
3. **Vercel → `SATURN_ALLOWED_ORIGINS`:** append `https://saturn-admin.netlify.app` (keep the existing origins, comma-separated, exact match, no trailing slash).
4. **Vercel → `OWNER_UIDS`:** see §4.
5. Firebase Console → Firestore → Rules → paste the updated `firestore.rules` → Publish.
6. The Netlify site named `saturn-admin` must be created by you; I cannot confirm the name is free.

### Environment variables

| Name | Status | Purpose |
|---|---|---|
| `OWNER_UIDS` | existing | Owner UID(s). |
| `SATURN_ALLOWED_ORIGINS` | existing | **Add** `https://saturn-admin.netlify.app`. |
| `FIREBASE_SERVICE_ACCOUNT_JSON`, `SOLANA_RPC_URL`, `PRIVY_*`, `PLATFORM_TREASURY_WALLET` | existing | Unchanged. |
| `RENDER_HEALTH_URL` | **new, optional** | A URL on your Render service that returns HTTP 200 when healthy. Until set, Render WebSocket shows "Not connected". Not guessed. |
| `VERCEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_REF`, `VERCEL_ENV`, `VERCEL_REGION` | Vercel system variables | Shown as deployment info when "Automatically expose System Environment Variables" is on. |

No new secrets are required.

## 5b. Running the tests

Backend (Node 22, no credentials, no network): `cd Saturn-fun-main && npm install && npm test` — 128 tests (103 original + 25 admin). Uses a Firestore-shaped fake.

Admin UI (Playwright, Chromium, 53 checks; Firebase SDK and backend are mocked, no credentials or network needed):
```
pip install playwright==1.56.0
playwright install chromium
cd saturn-admin-frontend          # the unzipped folder containing index.html and tests/
python3 tests/admin_ui_test.py    # exit code 0 = all pass; prints PASS/FAIL per check and "TOTAL 53 FAILED 0"
```
Environment used: Python 3.12.3, Playwright (Python) 1.56.0, headless Chromium. Screenshots are written to `/tmp/shot-*.png` (change that path on Windows). These tests prove layout and client behaviour only; they do not exercise real Google sign-in or the real backend.

## 6. Deployment

Backend (Vercel project `saturn-backend`): replace the repository files with this ZIP's contents (do not replace the public HTML), commit, let Vercel build. Run `npm test` first if you can (124 tests pass locally).

Admin frontend (Netlify): create a **separate** site named `saturn-admin` and publish the contents of `saturn-admin-frontend.zip` (the `index.html`, `netlify.toml`, `robots.txt`). No build command. `netlify.toml` sets a strict Content-Security-Policy, `X-Frame-Options: DENY`, no-store and noindex.

## 7. Firestore

- Rules: updated `firestore.rules` (explicit deny for `adminRoles`, `adminAudit`, `adminLogins`, `adminSecurity`, `moderation`, `rewardsLaunches`; everything else stays denied).
- Indexes: **none new**. All admin queries are single-field (automatic indexes). The existing `messages.uid` index stays.

## 8. Known limits (stated honestly)

- **Reports from the public app:** the current public Saturn HTML only sends "Report a problem" (existing `/api/settings` action). It has no Report button for tokens, users or messages and does not call `/api/report`. Those appear in the dashboard as soon as a later, separately approved frontend change submits to `POST /api/report` with `{targetType: "token"|"user"|"message"|"other", category, message, mint?, signature?, targetWallet?, targetUid?, room?+messageId?, evidence?: ["data:image/jpeg;base64,…" ×≤3, ≤180 kB each]}`. Existing problem reports already appear.
- **Restrictions are record-only.** No sign-in, posting or token-creation check reads `moderation/{uid}`. Enforcement needs edits to `lib/community.js` / `authenticate()` that were not approved.
- **Hide content / remove token from listings:** not implemented (Saturn has no token-listing database and community hiding would change protected code). Shown as Not connected.
- **Tokens:** only mint, creator wallet and recorded trades exist; name, symbol and market data show "Not connected".
- **Volume / users** are computed from the most recent 2,000 records and labelled when capped. Volume covers only trades reported to `/api/events`.
- **Rewards:** payouts are disabled; cashback, SOL recovery, claim history and external provider show "Not connected".
- **System health:** Vercel (served), Firestore (live read) and Solana RPC (`getHealth`) are probed live; Render needs `RENDER_HEALTH_URL`. API failure log, upload errors and failed transaction simulations are not recorded anywhere yet and say so.
- **Maintenance controls and platform configuration editing:** not connected; Settings is read-only status.
- Admin pagination is capped (100–500 rows per view).
