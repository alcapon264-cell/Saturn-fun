# Saturn private chat + blocking — diagnosis, changes, deployment

Nothing here has been deployed. Public domains, environment-variable names, `SATURN_LIVE_WS_URL`, RPC, wallet, trading, token creation, portfolio, authentication, community and owner/admin code are unchanged.

## 1. Diagnosis of what already existed
Both uploads already contained a working private-chat design:
- **Backend** (`lib/chat.js`, routes `chat-eligibility|open|send|history|list`): identity from the verified token, mutual-follow check on every send, block check both ways, history kept after unfollow, duplicate-safe sends (hashed client id), per-recipient unread counts, rate limiting, membership checks. Blocking (`lib/settings.js`) removes follows between the accounts.
- **Frontend**: Chat module, Inbox "Messages" tab, Message button on profiles, Block trader on profiles, Blocked traders in Settings.

I traced the real flow by running the real backend (with a Firestore-shaped fake) against your real HTML in headless Chromium (test copy with Privy disabled and Firebase sign-in stubbed). Sending, receiving, unread dots, read state and blocking all worked at the API level. What was actually wrong or missing:
1. **The Message button was injected once into the profile page and could be wiped by the next profile re-render, with nothing putting it back.** Reproduced against the original HTML (the "re-applied after a re-render" check fails on the original, passes on the fix). It is timing dependent, so it appeared intermittently. This is the most likely reason users could not reach a chat.
2. **No notifications for messages or new mutual follows.** The bell never lit for a message, and a notification type the Inbox cannot draw would have counted as unread but shown nothing.
3. **No way to block from inside a chat** (only from the profile).
4. **Race window on send:** block/unfollow were checked just before the write, not inside it.
5. The conversation list and bell never refreshed on their own.
6. History order relied on the database's ordering.

I could not reproduce a hard failure in the backend routes themselves. If chat is still failing for you in production after deploying this, the cause is outside what I can see from the uploads (for example a missing `SATURN_ALLOWED_ORIGINS` entry, the deployed backend being older than this ZIP, or users whose wallet is not linked to a Saturn account — the app then correctly says the trader is unavailable). Check the browser console / Vercel logs for `chat-*` calls.

## 2. Files changed

**Frontend (1 file):** `Saturn-Rewards-Redesign_1.html` — about 21 lines added, 11 lines replaced:
- Message button drawn from cached eligibility and re-applied by a MutationObserver after any re-render.
- Chat header three-dot menu: View profile, Block user (confirmation, then returns to Inbox).
- Inbox rows for `message` and `mutual` notifications ("sent you a message", "you now follow each other", with Open chat / Message links).
- Quiet refresh: the Messages list and bell refresh every 60 s while the tab is visible and signed in (no requests when hidden or signed out); the bell refreshes shortly after a conversation is read.
- Corrected a stale comment. No other page touched; `SATURN_LIVE_WS_URL` is byte-identical.

**Backend:**
- `lib/chat.js` — send re-reads the block documents and both follow edges **inside the Firestore transaction** (a block or unfollow that lands mid-request stops the message); one deterministic message notification per conversation per recipient written in the same transaction (no text in it); history marks the conversation and its notification read for the caller only; new `read` route; `mutualNotify`; history sorted explicitly.
- `lib/app.js` — wires `chat-read`; after a NEW follow edge that completes a mutual follow, both users get one `mutual` notification (best effort, never fails the follow); the notification list hides message/mutual alerts from anyone in a block relationship with the reader.
- `api/[route].js` — adds route `chat-read`.
- `package.json` — adds `tests/chat-mutual.test.js` to `npm test`.
- New: `tests/chat-mutual.test.js`, `e2e/` (browser test harness), `CHAT-SETUP.md`.
- Unchanged: `lib/settings.js`, `lib/community.js`, `lib/follow.js`, `lib/deps.js`, `firestore.rules`, `firestore.indexes.json`.

## 3. Firestore
Collections (all Admin-SDK only; rules already deny every client access): `privateChats/{conv}` and `privateChats/{conv}/messages/{id}` (existing), `blocks/{blocker}__{blocked}` (existing), `follows/{from}_{to}` (existing), `notifications/{id}` with the new ids `msg_{conv}_{recipientUid}` (type `message`) and `mutual_{conv}_{uid}_{edgeTimestamp}` (type `mutual`).
Indexes: **none new.** Rules: **no change.**

## 4. Environment variables / Firebase
None new. `SATURN_ALLOWED_ORIGINS` must already contain your production site origin.

## 5. Behaviour (what the backend enforces)
- Chat needs both accounts to follow each other (any linked wallet of one follows any linked wallet of the other), checked on open and on every send, and re-checked inside the write.
- Unfollow: new messages stop, history stays readable.
- Block (either direction): no send, no open, no read through an old conversation id, conversation hidden from both lists, follows removed, re-follow refused; the blocker and the blocked user get the identical generic answer (no hint who blocked whom).
- Unblock does not restore follows; both users must follow again.
- Identity is only the verified token; a `from`/`uid` field in a request is ignored. Messages: 1,000 characters, control characters stripped, 0.7 s minimum gap per sender, duplicate submissions return the original message.
- Updates arrive by polling (open chat every 8 s while visible; list/bell every 60 s). There is no private-message WebSocket; none was invented.
- "Requests" tab has no backing feature and still shows its empty state.

## 6. Deploy
1. Replace the backend repo files with this ZIP's contents (do not delete your environment variables) and let Vercel build.
2. Replace the frontend HTML with `Saturn-Rewards-Redesign_1.html` using your usual process.
3. No Firestore rules/indexes to publish.
Backend and frontend can ship in either order: old frontends simply ignore the new notification types except that an unknown type shows nothing, so ship the frontend promptly.

## 7. Running the tests
Backend (Node 22, no credentials): `npm install && npm test` — 149 tests.

Browser E2E (Python 3.12, Playwright 1.56.0, Chromium; no network or credentials):
```
pip install playwright==1.56.0 && playwright install chromium
e2e/make_test_html.sh Saturn-Rewards-Redesign_1.html /tmp/test.html   # TEST-ONLY copy, never deploy it
cd e2e && HTML=/tmp/test.html ./run.sh e2e_final.py                   # prints PASS/FAIL, ends "TOTAL 20 FAILED 0"
```
`run.sh` starts the real backend with an in-memory Firestore on port 8811, runs the script and stops it. The harness removes the onboarding overlay and neutralises its navigation (the test account has no wallet), and Firebase sign-in is stubbed.

## 8. Not tested
Real Firebase sign-in, real Firestore (transactions, ordering), Privy wallet flow, real Vercel/CORS, notification timing at scale, and real phones/browsers other than headless Chromium.
