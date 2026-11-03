// Saturn backend core. Pure factory: all I/O (Firebase Auth, Firestore, Solana RPC) is injected, so it is fully testable and holds no secrets.
import crypto from 'node:crypto';
import { peekIssuer, loadVerificationKey, verifyPrivyToken } from './privy.js';
import { validateProfileInput, publicProfile, isWallet, searchPrefix, rankProfiles, normalizeUsername, usernameError, SEARCH_LIMIT } from './profiles.js';
import { sweep as treasurySweep } from './treasury.js';
import { createCommunity } from './community.js';
import { createChat } from './chat.js';
import { createSettings, SESSION_HEADER } from './settings.js';
import { createAdmin } from './admin.js';
import { createReports } from './reports.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export function b58dec(s) {
  let n = 0n;
  for (const c of s) {
    const i = A.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  let b = Buffer.from(h === '0' ? '' : h, 'hex');
  for (const c of s) {
    if (c === '1') b = Buffer.concat([Buffer.from([0]), b]);
    else break;
  }
  return b;
}

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(pub32, msg, sig) {
  try {
    return crypto.verify(
      null,
      msg,
      crypto.createPublicKey({
        key: Buffer.concat([SPKI, pub32]),
        format: 'der',
        type: 'spki'
      }),
      sig
    );
  } catch {
    return false;
  }
}

export const linkMessage = (uid, wallet, issued) =>
  `Saturn wallet link\nuid:${uid}\nwallet:${wallet}\nissued:${issued}`;

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const big = x => BigInt(x ?? 0);

export function createApp({ auth, store, rpc, env, db = null, now = () => Date.now() }) {
  const privyAppId = env.PRIVY_APP_ID || '';
  const privyKey = loadVerificationKey(env.PRIVY_VERIFICATION_KEY);

const origins = new Set([
  ...list(env.SATURN_ALLOWED_ORIGINS),
  ...list(env.SATURN_EXTRA_ALLOWED_ORIGINS)
]);
  const owners = new Set(list(env.OWNER_UIDS));
  const treasury = env.PLATFORM_TREASURY_WALLET || '';

  const send = (res, code, obj) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(obj));
  };

  // Browser requests from an origin that is not allowlisted are refused outright.
  // Requests without an Origin header still need valid auth where required.
  const cors = (req, res) => {
    const o = req.headers.origin;
    if (o) {
      if (!origins.has(o)) return false;
      res.setHeader('access-control-allow-origin', o);
      res.setHeader('vary', 'Origin');
    }
    res.setHeader('access-control-allow-headers', 'Content-Type, Authorization, X-Saturn-Session');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    return true;
  };

  // Settings service (preferences, sessions, blocks, reports, deletion). Wallet-signature proof for account deletion reuses ed25519.
  const settingsSvc = createSettings({
    store, db, auth, now,
    verifyWalletSig: (wallet, message, signature) => {
      const pub = b58dec(wallet), sig = Buffer.from(String(signature), 'base64');
      return !!pub && pub.length === 32 && sig.length === 64 && verifyEd25519(pub, Buffer.from(message, 'utf8'), sig);
    }
  });

  // Token verification only (Privy access tokens or Firebase ID tokens).
  const verifyToken = async req => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;

    if (peekIssuer(m[1]) === 'privy.io') {
      return privyAppId && privyKey
        ? verifyPrivyToken(m[1], { appId: privyAppId, key: privyKey, now })
        : null;
    }

    try {
      const d = await auth.verifyIdToken(m[1], true);
      if (!d || typeof d.uid !== 'string' || d.uid.startsWith('did:privy:')) return null;
      return { ...d, provider: 'firebase' };
    } catch {
      return null;
    }
  };

  // One identity per request: a verified token AND, once the account has registered a Saturn session, a live (not revoked,
  // not expired, same-account) session id in the x-saturn-session header. Revocation is therefore enforced server-side on every
  // authenticated route (settings, profile, follow, chat, community, notifications...). skipSession is used ONLY by session-register.
  const authenticate = async (req, { skipSession = false } = {}) => {
    const u = await verifyToken(req);
    if (!u || skipSession) return u;
    const g = await settingsSvc.gate(req, u);
    if (!g.ok) { try { req.sessionDenied = g.code; } catch { /* frozen request */ } return null; }
    return g.sessionId ? { ...u, sessionId: g.sessionId } : u;
  };
  
     // ---- Saturn community messaging.
  const community = db
    ? createCommunity({
        db,
        verify: r => authenticate(r),
        linkedWallets: async uid => {
          const u = await store.get('users/' + uid);
          return (u && u.wallets) || [];
        },
        isPrivate: async uid => (await settingsSvc.getSettings(uid)).profileVisibility === 'private',
        now
      })
    : null;
  // ---- Saturn private chat (mutual follow required; see lib/chat.js).
  const chat = db
    ? createChat({
        db,
        verify: r => authenticate(r),
        linkedWallets: async uid => {
          const u = await store.get('users/' + uid);
          return (u && u.wallets) || [];
        },
        walletOwner: async w => {
          const l = await store.get('walletLinks/' + w);
          return (l && typeof l.uid === 'string' && l.uid) || '';
        },
        isBlocked: (a, b) => settingsSvc.blockedEitherWay(a, b),
        now
      })
    : null;
  const isOwner = d => !!d && owners.size > 0 && owners.has(d.uid);

  const body = req => {
    try {
      return typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body && typeof req.body === 'object' ? req.body : {});
    } catch {
      return null;
    }
  };

  const hits = new Map();

  const limited = (req, key, max) => {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const t = now();
    const k = key + '|' + ip;
    const r = hits.get(k);

    if (!r || t - r.t > 60000) {
      hits.set(k, { t, n: 1 });
      if (hits.size > 5000) {
        for (const [kk, v] of hits) {
          if (t - v.t > 60000) hits.delete(kk);
        }
      }
      return false;
    }

    r.n++;
    return r.n > max;
  };

  const guard = (method, handler, { needAuth = false, name = 'x', limit = 60, skipSession = null } = {}) =>
    async (req, res) => {
      if (!cors(req, res)) return send(res, 403, { error: 'Origin not allowed.' });
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
      }
      if (req.method !== method) return send(res, 405, { error: 'Method not allowed.' });
      if (limited(req, name, limit)) return send(res, 429, { error: 'Too many requests.' });

      const b = method === 'POST' ? body(req) : {};
      if (b === null) return send(res, 400, { error: 'Invalid JSON.' });

      const user = await authenticate(req, { skipSession: typeof skipSession === 'function' && !!skipSession(b) });
      if (needAuth && !user) {
        return send(res, 401, { error: 'Sign in required.', ...(req.sessionDenied ? { code: req.sessionDenied } : {}) });
      }

      return handler(req, res, user, b);
    };
  const communityRoute = (fn, name) =>
    guard('POST', async (req, res, user, b) => {
      if (!community) {
        return send(res, 503, {
          ok: false,
          error: 'community_unavailable'
        });
      }
      const r = await community[fn](req, b);
      return send(res, r.status, r.body);
    }, { needAuth: true, name, limit: 30 });

  const chatRoute = (fn, name, limit = 60) =>
    guard('POST', async (req, res, user, b) => {
      if (!chat) return send(res, 503, { ok: false, error: 'chat_unavailable' });
      const r = await chat[fn](req, b);
      return send(res, r.status, r.body);
    }, { needAuth: true, name, limit });

  const chatEligibility = chatRoute('eligibility', 'chat-eligibility');
  const chatOpen = chatRoute('open', 'chat-open', 30);
  const chatSend = chatRoute('send', 'chat-send', 60);
  const chatHistory = chatRoute('history', 'chat-history');
  const chatList = chatRoute('list', 'chat-list');

  const communityPost = communityRoute('post', 'community-post');
  const communityDelete = communityRoute('remove', 'community-delete');
  
  // POST /api/settings — one authenticated endpoint, action-based (lib/settings.js):
  //   get | save                                  allow-listed preferences (userSettings/{uid})
  //   session-register|list|revoke|revoke-others|end   server-side sessions, enforced in authenticate()
  //   blocks-list | block | unblock               persistent blocked traders (enforced in search/profile/follow/chat/notifications)
  //   report                                      problem reports (stored; success only after the write)
  //   delete-account                              re-authenticated deletion of Saturn data (never touches wallets or on-chain assets)
  const settings = guard('POST', async (req, res, user, b) => {
    const r = await settingsSvc.handle(req, user, b, { limited });
    return send(res, r.status, r.body);
  }, { needAuth: true, name: 'settings', limit: 60, skipSession: b => b && b.action === 'session-register' });

  // POST /api/admin — Saturn admin dashboard (lib/admin.js). Verified token only (no Saturn session header), owner/role checked server-side.
  const adminProbes = {
    rpc: typeof rpc.getHealth === 'function' ? () => rpc.getHealth() : null,
    ws: env.RENDER_HEALTH_URL ? async () => {
      const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 4000);
      try { const r = await fetch(env.RENDER_HEALTH_URL, { signal: ctl.signal }); if (!r.ok) throw new Error('http_' + r.status); } finally { clearTimeout(tm); }
    } : null
  };
  const adminSvc = db ? createAdmin({ db, isOwner, now, env, probes: adminProbes }) : null;
  const admin = guard('POST', async (req, res, user, b) => {
    if (!adminSvc) return send(res, 503, { ok: false, error: 'admin_unavailable' });
    const r = await adminSvc.handle(req, user, b, { limited });
    return send(res, r.status, r.body);
  }, { needAuth: true, name: 'admin', limit: 120, skipSession: () => true });

  // POST /api/report — targeted user reports (token / user / community message) with optional image evidence.
  const reportsSvc = db ? createReports({ db, store, now }) : null;
  const reportSubmit = guard('POST', async (req, res, user, b) => {
    if (!reportsSvc) return send(res, 503, { ok: false, error: 'reports_unavailable' });
    const r = await reportsSvc.submit(user, b);
    return send(res, r.status, r.body);
  }, { needAuth: true, name: 'report', limit: 10 });

  // POST /api/account — upsert the authenticated user's account document.
  const account = guard('POST', async (req, res, user) => {
    const ex = await store.get('users/' + user.uid);

    const rec = {
      uid: user.uid,
      provider: user.provider || 'firebase',
      email: user.email || null,
      name: user.name || null,
      lastSeen: now(),
      ...(ex ? {} : { createdAt: now(), wallets: [] })
    };

    await store.set('users/' + user.uid, rec, true);

    if (!ex) {
      await store.create('events/signup_' + user.uid, {
        type: 'signup',
        uid: user.uid,
        recordedAt: now()
      });
      await store.create('notifications/welcome_' + user.uid, {
        uid: user.uid, type: 'welcome', ts: now(), read: false
      });
    }

    const u = await store.get('users/' + user.uid);
    const linked = !!(
      await store.get(
        'identityLinks/' + (user.provider === 'privy' ? user.uid : 'fb_' + user.uid)
      )
    );

    return send(res, 200, {
      ok: true,
      uid: user.uid,
      wallets: u.wallets || [],
      identityLinked: linked
    });
  }, { needAuth: true, name: 'account', limit: 30 });

  // POST /api/link-wallet
  const linkWallet = guard('POST', async (req, res, user, b) => {
    const { wallet, message, signature } = b;

    if (
      !ADDR_RE.test(wallet || '') ||
      typeof message !== 'string' ||
      typeof signature !== 'string'
    ) {
      return send(res, 400, { error: 'Invalid request.' });
    }

    const m = /^Saturn wallet link\nuid:(.+)\nwallet:(.+)\nissued:(\d+)$/.exec(message);

    if (!m || m[1] !== user.uid || m[2] !== wallet) {
      return send(res, 400, { error: 'Message does not match this account and wallet.' });
    }

    if (Math.abs(now() - Number(m[3])) > 10 * 60 * 1000) {
      return send(res, 400, { error: 'Link message expired. Try again.' });
    }

    const pub = b58dec(wallet);
    const sig = Buffer.from(signature, 'base64');

    if (
      !pub ||
      pub.length !== 32 ||
      sig.length !== 64 ||
      !verifyEd25519(pub, Buffer.from(message, 'utf8'), sig)
    ) {
      return send(res, 400, { error: 'Wallet signature is invalid.' });
    }

    const created = await store.create('walletLinks/' + wallet, {
      uid: user.uid,
      linkedAt: now()
    });

    if (!created) {
      const ex = await store.get('walletLinks/' + wallet);
      if (!ex || ex.uid !== user.uid) {
        return send(res, 409, {
          error: 'This wallet is already linked to another account.'
        });
      }
    }

    const u = (await store.get('users/' + user.uid)) || {};
    const wallets = [...new Set([...(u.wallets || []), wallet])];

    await store.set('users/' + user.uid, {
      uid: user.uid,
      email: user.email || null,
      wallets,
      updatedAt: now()
    }, true);

    if (created) {
      await store.create('events/link_' + wallet, {
        type: 'wallet_link',
        uid: user.uid,
        wallet,
        recordedAt: now()
      });
    }

    return send(res, 200, { ok: true, wallets });
  }, { needAuth: true, name: 'link', limit: 10 });

  // POST /api/link-identity
  const linkIdentity = guard('POST', async (req, res, user, b) => {
    if (user.provider !== 'privy') {
      return send(res, 403, { error: 'Sign in with your new account first.' });
    }

    const tok = b.firebaseIdToken;

    if (
      typeof tok !== 'string' ||
      tok.length < 20 ||
      peekIssuer(tok) === 'privy.io'
    ) {
      return send(res, 400, { error: 'Invalid request.' });
    }

    let d;

    try {
      d = await auth.verifyIdToken(tok, true);
    } catch {
      return send(res, 401, {
        error: 'Your previous account could not be verified.'
      });
    }

    if (!d || typeof d.uid !== 'string' || d.uid.startsWith('did:privy:')) {
      return send(res, 401, {
        error: 'Your previous account could not be verified.'
      });
    }

    if (
      typeof d.auth_time !== 'number' ||
      Math.abs(now() / 1000 - d.auth_time) > 300
    ) {
      return send(res, 401, {
        error: 'Please sign in to your previous account again, then retry.'
      });
    }

    const pair = await store.createPair(
      'identityLinks/fb_' + d.uid,
      {
        privy: user.uid,
        firebaseUid: d.uid,
        linkedAt: now()
      },
      'identityLinks/' + user.uid,
      {
        privy: user.uid,
        firebaseUid: d.uid,
        email: d.email || null,
        linkedAt: now()
      }
    );

    if (!pair.created) {
      if (
        pair.a &&
        pair.b &&
        pair.b.firebaseUid === d.uid &&
        pair.a.privy === user.uid
      ) {
        return send(res, 200, { ok: true, duplicate: true });
      }

      return send(res, 409, {
        error: 'One of these accounts is already linked to a different account.'
      });
    }

    await store.set('users/' + user.uid, {
      uid: user.uid,
      provider: 'privy',
      linkedFirebaseUid: d.uid,
      updatedAt: now()
    }, true);

    await store.create('events/idlink_' + user.uid, {
      type: 'identity_link',
      privy: user.uid,
      firebaseUid: d.uid,
      recordedAt: now()
    });

    return send(res, 200, { ok: true });
  }, { needAuth: true, name: 'idlink', limit: 5 });

  // ---- Rewards foundation. Monetary claims remain disabled until an audited
  // on-chain source and payout adapter are configured. Never infer balances
  // from trade volume or client-provided values.
  const rewards = guard('POST', async (req, res, user, b) => {
    const action = String(b.action || '');
    const wallet = String(b.wallet || '');
    if (!ADDR_RE.test(wallet)) return send(res, 400, { ok: false, error: 'invalid_wallet' });

    const link = await store.get('walletLinks/' + wallet);
    if (!link || link.uid !== user.uid) {
      return send(res, 403, { ok: false, error: 'wallet_not_linked' });
    }

    if (action === 'summary') {
      // Empty ledger is intentional until source-specific, verified reward
      // ingestion is implemented. Existing events are NOT themselves proof
      // of a payable creator/cashback amount.
      return send(res, 200, {
        ok: true,
        wallet,
        cashback: { earned: '0', claimed: '0', claimable: '0', trades: 0, volume: '0' },
        creator: { earned: '0', claimable: '0', tokens: [] },
        total: { claimable: '0' },
        config: { minClaimLamports: '0', payoutsEnabled: false },
        sources: { traderCashback: 'not_connected', pumpCreatorFees: 'not_connected', recovery: 'not_connected' }
      });
    }

    if (action === 'claim') {
      // No payout signer, ledger debit, or verified external claim integration
      // is configured. Refuse safely rather than simulate a payment.
      return send(res, 503, { ok: false, error: 'payouts_disabled' });
    }

    if (action === 'register-launch') {
      const { mint, sig, kind } = b;
      if (!ADDR_RE.test(mint || '') || !SIG_RE.test(sig || '')) {
        return send(res, 400, { ok: false, error: 'invalid_launch' });
      }
      const event = await store.get('events/' + sig);
      if (!event) return send(res, 202, { ok: false, error: 'pending' });
      if (event.type !== 'launch' || event.wallet !== wallet || event.mint !== mint) {
        return send(res, 403, { ok: false, error: 'launch_mismatch' });
      }
      const path = 'rewardsLaunches/' + mint;
      const prior = await store.get(path);
      if (prior && prior.wallet !== wallet) {
        return send(res, 409, { ok: false, error: 'mint_already_registered' });
      }
      const record = {
        wallet, uid: user.uid, mint, signature: sig,
        launchKind: event.launchKind || (kind === 'PUMP_LAUNCH' ? 'PUMP_LAUNCH' : 'SATURN_NATIVE'),
        status: 'registered_pending_source_verification',
        creatorShareBps: 8000,
        saturnShareBps: 2000,
        feeShareAuthorized: false,
        createdAt: prior?.createdAt || now(),
        updatedAt: now()
      };
      await store.set(path, record, true);
      return send(res, 200, { ok: true, registered: true, status: record.status, feeShareConfigured: false });
    }

    return send(res, 400, { ok: false, error: 'invalid_action' });
  }, { needAuth: true, name: 'rewards', limit: 30 });

  // POST /api/events
  function analyse(tx, wallet, mint) {
    const keys = (tx.transaction?.message?.accountKeys || []).map(k =>
      typeof k === 'string'
        ? { pubkey: k, signer: false }
        : k
    );

    const pre = tx.meta.preBalances;
    const post = tx.meta.postBalances;

    const wi = keys.findIndex(k => k.pubkey === wallet);
    const ti = treasury ? keys.findIndex(k => k.pubkey === treasury) : -1;

    const tok = (arr, owner, m) =>
      (arr || [])
        .filter(b => b.owner === owner && (!m || b.mint === m))
        .reduce((x, b) => x + big(b.uiTokenAmount?.amount), 0n);

    const tre = {};

    if (treasury) {
      for (const b of [
        ...(tx.meta.postTokenBalances || []),
        ...(tx.meta.preTokenBalances || [])
      ]) {
        if (b.owner === treasury) {
          tre[b.mint] ??= (
            tok(tx.meta.postTokenBalances, treasury, b.mint) -
            tok(tx.meta.preTokenBalances, treasury, b.mint)
          ).toString();
        }
      }
    }

    return {
      feePayer: keys[0]?.pubkey,
      walletSigned: wi >= 0 && keys[wi].signer === true,
      hasMint: !!mint && keys.some(k => k.pubkey === mint),
      tokenDelta: mint
        ? (
            tok(tx.meta.postTokenBalances, wallet, mint) -
            tok(tx.meta.preTokenBalances, wallet, mint)
          ).toString()
        : '0',
      solDelta: wi >= 0
        ? (big(post[wi]) - big(pre[wi])).toString()
        : '0',
      txFee: String(tx.meta.fee ?? 0),
      treasuryLamportsDelta: ti >= 0
        ? (big(post[ti]) - big(pre[ti])).toString()
        : '0',
      treasuryTokenDeltas: tre,
      feeVerified:
        (ti >= 0 && big(post[ti]) - big(pre[ti]) > 0n) ||
        Object.values(tre).some(v => big(v) > 0n),
      blockTime: tx.blockTime ? tx.blockTime * 1000 : null
    };
  }

  const events = guard('POST', async (req, res, user, b) => {
    const { type, sig, wallet, mint, side, kind } = b;

    if (
      !['trade', 'launch'].includes(type) ||
      !SIG_RE.test(sig || '') ||
      !ADDR_RE.test(wallet || '') ||
      !ADDR_RE.test(mint || '')
    ) {
      return send(res, 400, { error: 'Invalid event.' });
    }

    if (type === 'trade' && !['buy', 'sell'].includes(side)) {
      return send(res, 400, { error: 'Invalid side.' });
    }

    if (await store.get('events/' + sig)) {
      return send(res, 200, { ok: true, duplicate: true });
    }

    let tx;

    try {
      tx = await rpc.getTransaction(sig);
    } catch {
      return send(res, 502, { error: 'RPC unavailable.' });
    }

    if (!tx) {
      return send(res, 202, { ok: false, status: 'pending' });
    }

    if (tx.meta?.err) {
      const ok = (tx.transaction?.message?.accountKeys || []).some(
        k => (k.pubkey || k) === wallet && k.signer !== false
      );

      if (ok) {
        await store.create('errors/' + sig, {
          type: 'tx_failed',
          sig,
          wallet,
          mint,
          error: JSON.stringify(tx.meta.err).slice(0, 300),
          recordedAt: now()
        });
      }

      return send(res, 200, {
        ok: false,
        status: 'failed_on_chain'
      });
    }

    const a = analyse(tx, wallet, mint);

    if (a.feePayer !== wallet || !a.walletSigned) {
      return send(res, 422, {
        error: 'Wallet did not sign this transaction.'
      });
    }

    if (
      type === 'trade' &&
      (
        (side === 'buy' && big(a.tokenDelta) <= 0n) ||
        (side === 'sell' && big(a.tokenDelta) >= 0n)
      )
    ) {
      return send(res, 422, {
        error: 'Token movement does not match the side.'
      });
    }

    if (type === 'launch' && !a.hasMint) {
      return send(res, 422, {
        error: 'Mint is not part of this transaction.'
      });
    }

    let uid = null;

    if (user) {
      const l = await store.get('walletLinks/' + wallet);
      if (l && l.uid === user.uid) uid = user.uid;
    }

    const rec = {
      type,
      sig,
      wallet,
      mint,
      ...(type === 'trade'
        ? { side }
        : {
            launchKind:
              kind === 'PUMP_LAUNCH'
                ? 'PUMP_LAUNCH'
                : 'SATURN_NATIVE'
          }),
      ...a,
      uid,
      recordedAt: now()
    };

    delete rec.feePayer;
    delete rec.walletSigned;
    delete rec.hasMint;

    const created = await store.create('events/' + sig, rec);

    // Notify only accounts whose linked wallets follow this trader. The event
    // is already verified against confirmed chain data before reaching here.
    if (created && type === 'trade' && typeof store.followersOf === 'function') {
      const followers = await store.followersOf(wallet, 500);
      const notified = new Set();
      const traderUid = ((await store.get('walletLinks/' + wallet)) || {}).uid || null;
      for (const follower of followers) {
        const link = await store.get('walletLinks/' + follower);
        if (!link || !link.uid || link.uid === uid || notified.has(link.uid)) continue;
        if (traderUid && await settingsSvc.blockedEitherWay(link.uid, traderUid)) continue;
        notified.add(link.uid);
        await store.create('notifications/trade_' + sig + '_' + link.uid, {
          uid: link.uid, type: 'trade', from: wallet, mint, side, ts: rec.blockTime || now(), read: false
        });
      }
    }

    return send(res, 200, {
      ok: true,
      duplicate: !created
    });
  }, { name: 'events', limit: 60 });

  // GET /api/owner?view=summary|events|users|errors — owner only.
  const owner = guard('GET', async (req, res, user) => {
    if (!isOwner(user)) {
      return send(res, 403, { error: 'Forbidden.' });
    }

    const q = new URL(req.url, 'http://x').searchParams;
    const view = q.get('view') || 'summary';
    const lim = Math.min(
      Math.max(Number(q.get('limit')) || 100, 1),
      500
    );

    if (view === 'events') {
      return send(res, 200, {
        events: await store.list('events', { limit: lim })
      });
    }

    if (view === 'users') {
      return send(res, 200, {
        users: await store.list('users', {
          limit: lim,
          orderBy: 'lastSeen'
        })
      });
    }

    if (view === 'errors') {
      return send(res, 200, {
        errors: await store.list('errors', { limit: lim })
      });
    }

    const ev = await store.list('events', { limit: 2000 });
    const us = await store.list('users', {
      limit: 2000,
      orderBy: 'lastSeen'
    });
    const er = await store.list('errors', { limit: 500 });
    const day = now() - 864e5;

    const tr = ev.filter(e => e.type === 'trade');
    const la = ev.filter(e => e.type === 'launch');

    const vol = a =>
      a.reduce(
        (s, e) =>
          s + (big(e.solDelta) < 0n
            ? -big(e.solDelta)
            : big(e.solDelta)),
        0n
      );

    const treTok = {};

    for (const e of tr) {
      for (const [m, d] of Object.entries(e.treasuryTokenDeltas || {})) {
        treTok[m] = (big(treTok[m]) + big(d)).toString();
      }
    }

    return send(res, 200, {
      summary: {
        note: 'Computed from the most recent recorded events (cap 2000). Volume = net SOL moved by the trader wallet per on-chain-verified trade (includes network fee/rent). "Fee-verified" trades are those where the Saturn treasury received value in the same transaction — use these for Saturn-attributed volume/revenue; other trades (e.g. Pump.fun-routed) are recorded but not fee-attributed.',
        users: us.length,
        linkedWallets: us.reduce(
          (s, u) => s + (u.wallets || []).length,
          0
        ),
        launches: la.length,
        trades: tr.length,
        buys: tr.filter(e => e.side === 'buy').length,
        sells: tr.filter(e => e.side === 'sell').length,
        volumeLamports: vol(tr).toString(),
        feeVerifiedTrades: tr.filter(e => e.feeVerified).length,
        feeVerifiedVolumeLamports: vol(
          tr.filter(e => e.feeVerified)
        ).toString(),
        treasuryLamportsReceived: tr.reduce(
          (s, e) => s + big(e.treasuryLamportsDelta),
          0n
        ).toString(),
        treasuryTokenDeltas: treTok,
        last24h: {
          trades: tr.filter(e => e.recordedAt >= day).length,
          launches: la.filter(e => e.recordedAt >= day).length,
          errors: er.filter(e => e.recordedAt >= day).length
        },
        errors: er.length
      }
    });
  }, { needAuth: true, name: 'owner', limit: 30 });

  // POST /api/owner?view=treasury-sweep — owner-only treasury sweep.
  const ownerSweep = guard('POST', async (req, res, user) => {
    if (!isOwner(user)) {
      return send(res, 403, { error: 'Forbidden.' });
    }

    const internalReq = {
      ...req,
      headers: {
        ...req.headers,
        authorization: `Bearer ${env.SATURN_ADMIN_SECRET || ''}`
      }
    };

    return treasurySweep(internalReq, res);
  }, { needAuth: true, name: 'treasury-sweep', limit: 5 });

  // ---- Privacy / block visibility (server-side; the browser's own hiding is never relied upon).
  // A profile is hidden from everyone except its owner when it is Private, and from either party of a block.
  const ownerOf = async (wallet, raw) => (raw && raw.uid) || ((await store.get('walletLinks/' + wallet)) || {}).uid || null;
  const hiddenFrom = async (viewer, ownerUid, cache) => {
    if (!ownerUid || (viewer && viewer.uid === ownerUid)) return false;
    let s = cache.get(ownerUid);
    if (!s) { s = await settingsSvc.getSettings(ownerUid); cache.set(ownerUid, s); }
    if (s.profileVisibility === 'private') return true;
    return !!viewer && await settingsSvc.blockedEitherWay(viewer.uid, ownerUid);
  };
  const visibleProfile = async (viewer, raw, cache) => (raw && !(await hiddenFrom(viewer, await ownerOf(raw.wallet, raw), cache))) ? raw : null;

  // ---- Public profile registry.
  // Ownership = the EXISTING walletLinks/{wallet} document
  // written only by /api/link-wallet after an ed25519 signature.

  // POST /api/profile-save
  const profileSave = guard('POST', async (req, res, user, b) => {
    const v = validateProfileInput(b);

    if (!v.ok) {
      return send(res, 400, {
        error: v.error,
        ...(v.field ? { field: v.field } : {})
      });
    }

    const p = v.value;
    const l = await store.get('walletLinks/' + p.wallet);

    if (!l || l.uid !== user.uid) {
      return send(res, 403, {
        error: 'Link this wallet to your account before publishing a profile.'
      });
    }

    if (!p.username && !p.displayName && !p.bio && !p.avatar) {
      await store.profileRemove(p.wallet);
      return send(res, 200, {
        ok: true,
        profile: null
      });
    }

    const r = await store.profileUpsert({
      ...p,
      nameLower: p.displayName.toLowerCase(),
      uid: user.uid,
      updatedAt: now()
    });

    if (r.conflict) {
      return send(res, 409, {
        error: 'That username is taken',
        field: 'username'
      });
    }

    return send(res, 200, {
      ok: true,
      profile: publicProfile(r.profile)
    });
  }, { needAuth: true, name: 'profile-save', limit: 20 });

  // POST /api/profile-get — Private profiles and blocked relationships look exactly like "no profile".
  // The response also carries the owner's public-display privacy flags; Saturn holds no balance/P&L values itself, so these tell
  // the app whether it may show them for this wallet (on-chain data stays public on-chain regardless).
  const profileGet = guard('POST', async (req, res, user, b) => {
    const cache = new Map();
    const reply = async (raw, wallet) => {
      const owner = await ownerOf(wallet, raw);
      const hidden = await hiddenFrom(user, owner, cache);
      let privacy = { showBalance: true, showPnl: true };
      if (owner) {
        const st = cache.get(owner) || await settingsSvc.getSettings(owner);
        privacy = hidden ? { showBalance: false, showPnl: false } : { showBalance: st.showBalance, showPnl: st.showPnl };
      }
      return send(res, 200, { ok: true, profile: hidden ? null : publicProfile(raw), privacy });
    };

    if (b.wallet != null) {
      if (!isWallet(b.wallet)) {
        return send(res, 400, { error: 'Invalid wallet.' });
      }
      return reply(await store.get('profiles/' + b.wallet), b.wallet);
    }

    if (b.username != null) {
      const u = normalizeUsername(b.username);

      if (usernameError(u)) {
        return send(res, 200, {
          ok: true,
          profile: null
        });
      }

      const c = await store.get('usernames/' + u);
      if (!c) return send(res, 200, { ok: true, profile: null });
      return reply(await store.get('profiles/' + c.wallet), c.wallet);
    }

    return send(res, 400, {
      error: 'wallet or username required'
    });
  }, { name: 'profile-get', limit: 120 });

  // POST /api/profile-search
  const profileSearch = guard('POST', async (req, res, user, b) => {
    const raw = typeof b.q === 'string' ? b.q.trim() : '';

    const limit = Math.min(
      SEARCH_LIMIT,
      Math.max(
        1,
        Math.floor(Number(b.limit)) || SEARCH_LIMIT
      )
    );

    const cache = new Map();

    if (isWallet(raw)) {
      const p = publicProfile(
        await visibleProfile(user, await store.get('profiles/' + raw), cache)
      );

      return send(res, 200, {
        ok: true,
        items: p ? [p] : []
      });
    }

    const q = searchPrefix(raw);

    if (!q) {
      return send(res, 200, {
        ok: true,
        items: []
      });
    }

    const [a, n] = await Promise.all([
      store.prefix('profiles', 'username', q, limit * 2),
      store.prefix('profiles', 'nameLower', q, limit * 2)
    ]);

    const seen = new Set(), visible = [];
    for (const p of [...a, ...n]) {
      if (!p || seen.has(p.wallet)) continue;
      seen.add(p.wallet);
      if (await visibleProfile(user, p, cache)) visible.push(p);
    }

    return send(res, 200, {
      ok: true,
      items: rankProfiles(visible, q, limit)
    });
  }, { name: 'profile-search', limit: 60 });

  // POST /api/rpc
  const RPC_METHODS = new Set([
    'getAccountInfo',
    'getBalance',
    'getFeeForMessage',
    'getLatestBlockhash',
    'getMinimumBalanceForRentExemption',
    'getMultipleAccounts',
    'getProgramAccounts',
    'getSignatureStatuses',
    'getSignaturesForAddress',
    'getTokenAccountsByOwner',
    'getTransaction',
    'sendTransaction',
    'simulateTransaction'
  ]);

  const rpcProxy = guard('POST', async (req, res, user, b) => {
    const m = b && b.method;
    const p = b && b.params;

    if (
      !b ||
      Array.isArray(b) ||
      typeof m !== 'string' ||
      !RPC_METHODS.has(m) ||
      (p !== undefined && !Array.isArray(p)) ||
      JSON.stringify(p || []).length > 20000
    ) {
      return send(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32601,
          message: 'Method not allowed.'
        }
      });
    }

    let out;

    try {
      out = await rpc.forward({
        jsonrpc: '2.0',
        id: 1,
        method: m,
        params: p || []
      });
    } catch {
      return send(res, 502, {
        error: 'RPC unavailable.'
      });
    }

    return send(res, 200, out);
  }, { name: 'rpc', limit: 240 });

  const notificationsList = guard('POST', async (req, res, user) => {
    const raw = typeof store.notificationList === 'function'
      ? await store.notificationList(user.uid, 100)
      : [];
    // Keep only the newest follow alert per source wallet. This cleans up
    // duplicate legacy alerts as well as preventing repeated inbox clutter.
    const seenFollows = new Set();
    const items = raw.filter(item => {
      if (!item || item.type !== 'follow' || typeof item.from !== 'string') return true;
      if (seenFollows.has(item.from)) return false;
      seenFollows.add(item.from);
      return true;
    });
    return send(res, 200, { ok: true, items });
  }, { needAuth: true, name: 'notifications-list', limit: 60 });

  const notificationsRead = guard('POST', async (req, res, user, b) => {
    const all = b.all === true;
    const ids = Array.isArray(b.ids) ? b.ids : [];
    if (!all && (!ids.length || ids.length > 100 || ids.some(x => typeof x !== 'string' || x.length > 180))) {
      return send(res, 400, { ok: false, error: 'invalid_notification_ids' });
    }
    const changed = typeof store.notificationRead === 'function'
      ? await store.notificationRead(user.uid, ids, all, now())
      : 0;
    return send(res, 200, { ok: true, changed });
  }, { needAuth: true, name: 'notifications-read', limit: 60 });

  return {
  account,
  settings,
  notificationsList,
  notificationsRead,
  linkWallet,
  linkIdentity,
  events,
  rewards,
  owner,
  admin,
  reportSubmit,
  ownerSweep,
  isOwner,
  profileSave,
  profileGet,
  profileSearch,
  rpcProxy,

  // FOLLOW SYSTEM
  followSet: guard(
    'POST',
    async (req, res, user, b) => {
      if (!user) {
        return send(res, 401, { ok: false, error: 'sign_in_required' });
      }

      const target = b.wallet;
      const shouldFollow = b.follow;
      const from = b.from;

      if (!ADDR_RE.test(target || '')) {
        return send(res, 400, { ok: false, error: 'invalid_wallet' });
      }

      if (typeof shouldFollow !== 'boolean') {
        return send(res, 400, { ok: false, error: 'invalid_follow' });
      }

      if (!ADDR_RE.test(from || '')) {
        return send(res, 400, { ok: false, error: 'invalid_wallet' });
      }

      if (from === target) {
        return send(res, 400, {
          ok: false,
          error: 'cannot_follow_self'
        });
      }

      const linked = await store.get('users/' + user.uid);

      const wallets = Array.isArray(linked?.wallets)
        ? linked.wallets
        : [];

      if (!wallets.includes(from)) {
        return send(res, 403, {
          ok: false,
          error: 'no_linked_wallet'
        });
      }

      if (shouldFollow) {
        const targetOwner = ((await store.get('walletLinks/' + target)) || {}).uid || null;
        if (targetOwner && await settingsSvc.blockedEitherWay(user.uid, targetOwner)) {
          return send(res, 403, { ok: false, error: 'blocked' });
        }
      }

      const result = await store.followSet(
        from,
        target,
        shouldFollow
      );

      if (shouldFollow && result.changed) {
        const targetLink = await store.get('walletLinks/' + target);
        if (targetLink && targetLink.uid && targetLink.uid !== user.uid) {
          // One notification per actual follow edge. Repeated requests cannot
          // create duplicates; a genuine unfollow/refollow gets a new edge timestamp.
          const edge = result.createdAt || now();
          await store.create('notifications/follow_' + from + '_' + target + '_' + edge, {
            uid: targetLink.uid, type: 'follow', from, ts: edge, read: false
          });
        }
      }

      return send(res, 200, {
        ok: true,
        following: shouldFollow,
        changed: !!result.changed
      });
    },
    {
      needAuth: true,
      name: 'follow-set',
      limit: 30
    }
  ),

  followList: guard(
    'POST',
    async (req, res, user, b) => {
      if (!user) {
        return send(res, 401, {
          ok: false,
          error: 'sign_in_required'
        });
      }

      const wallet = b.wallet;
      const kind = b.kind;

      if (!ADDR_RE.test(wallet || '')) {
        return send(res, 400, {
          ok: false,
          error: 'invalid_wallet'
        });
      }

      if (kind !== 'followers' && kind !== 'following') {
        return send(res, 400, {
          ok: false,
          error: 'invalid_kind'
        });
      }

      const field =
        kind === 'followers'
          ? 'following'
          : 'follower';

      const cache = new Map();
      const wallets = [];

      for (const w of await store.followList(
        field,
        wallet
      )) {
        const owner = ((await store.get('walletLinks/' + w)) || {}).uid || null;
        if (!(await hiddenFrom(user, owner, cache))) wallets.push(w);
      }

      const profiles = [];

      for (const w of wallets) {
        const profile = await store.get('profiles/' + w);

        if (profile) {
          profiles.push({
            wallet: w,
            username: profile.username || '',
            displayName: profile.displayName || '',
            avatar: profile.avatar || ''
          });
        }
      }

      return send(res, 200, {
        ok: true,
        kind,
        wallets,
        profiles
      });
    },
    {
      needAuth: true,
      name: 'follow-list',
      limit: 60
    }
  ),

  followCounts: guard(
    'POST',
    async (req, res, user, b) => {
      if (!user) {
        return send(res, 401, {
          ok: false,
          error: 'sign_in_required'
        });
      }

      const wallet = b.wallet;

      if (!ADDR_RE.test(wallet || '')) {
        return send(res, 400, {
          ok: false,
          error: 'invalid_wallet'
        });
      }

      const [followers, following] =
        await Promise.all([
          store.followCount('following', wallet),
          store.followCount('follower', wallet)
        ]);

      return send(res, 200, {
        ok: true,
        followers,
        following
      });
    },
    {
      needAuth: true,
      name: 'follow-counts',
      limit: 60
    }
      ),
    communityPost,
    chatEligibility,
    chatOpen,
    chatSend,
    chatHistory,
    chatList,
    communityDelete
  };
}

