// Saturn backend core. Pure factory: all I/O (Firebase Auth, Firestore, Solana RPC) is injected, so it is fully testable and holds no secrets.
import crypto from 'node:crypto';
import { peekIssuer, loadVerificationKey, verifyPrivyToken } from './privy.js';
import {
  validateProfileInput,
  publicProfile,
  isWallet,
  searchPrefix,
  rankProfiles,
  normalizeUsername,
  usernameError,
  SEARCH_LIMIT
} from './profiles.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

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

const list = s =>
  String(s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

const big = x => BigInt(x ?? 0);

export function createApp({
  auth,
  store,
  rpc,
  env,
  now = () => Date.now()
}) {
  const privyAppId = env.PRIVY_APP_ID || '';
  const privyKey = loadVerificationKey(
    env.PRIVY_VERIFICATION_KEY
  );

  const origins = new Set(
    list(env.SATURN_ALLOWED_ORIGINS)
  );

  const owners = new Set(
    list(env.OWNER_UIDS)
  );

  const treasury =
    env.PLATFORM_TREASURY_WALLET || '';

  const send = (res, code, obj) => {
    res.statusCode = code;
    res.setHeader(
      'content-type',
      'application/json'
    );
    res.setHeader(
      'cache-control',
      'no-store'
    );
    res.end(JSON.stringify(obj));
  };

  const cors = (req, res) => {
    const o = req.headers.origin;

    if (o) {
      if (!origins.has(o)) return false;

      res.setHeader(
        'access-control-allow-origin',
        o
      );

      res.setHeader(
        'vary',
        'Origin'
      );
    }

    res.setHeader(
      'access-control-allow-headers',
      'Content-Type, Authorization'
    );

    res.setHeader(
      'access-control-allow-methods',
      'GET, POST, OPTIONS'
    );

    return true;
  };

  const authenticate = async req => {
    const m = /^Bearer (.+)$/.exec(
      req.headers.authorization || ''
    );

    if (!m) return null;

    if (peekIssuer(m[1]) === 'privy.io') {
      return privyAppId && privyKey
        ? verifyPrivyToken(m[1], {
            appId: privyAppId,
            key: privyKey,
            now
          })
        : null;
    }

    try {
      const d = await auth.verifyIdToken(
        m[1],
        true
      );

      if (
        !d ||
        typeof d.uid !== 'string' ||
        d.uid.startsWith('did:privy:')
      ) {
        return null;
      }

      return {
        ...d,
        provider: 'firebase'
      };
    } catch {
      return null;
    }
  };

  const isOwner = d =>
    !!d &&
    owners.size > 0 &&
    owners.has(d.uid);

  const body = req => {
    try {
      return typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body &&
            typeof req.body === 'object'
          ? req.body
          : {};
    } catch {
      return null;
    }
  };

  const hits = new Map();

  const limited = (req, key, max) => {
    const ip =
      String(
        req.headers['x-forwarded-for'] || ''
      )
        .split(',')[0]
        .trim() || 'unknown';

    const t = now();
    const k = key + '|' + ip;
    const r = hits.get(k);

    if (!r || t - r.t > 60000) {
      hits.set(k, {
        t,
        n: 1
      });

      if (hits.size > 5000) {
        for (const [kk, v] of hits) {
          if (t - v.t > 60000) {
            hits.delete(kk);
          }
        }
      }

      return false;
    }

    r.n++;

    return r.n > max;
  };

  const guard = (
    method,
    handler,
    {
      needAuth = false,
      name = 'x',
      limit = 60
    } = {}
  ) => async (req, res) => {
    if (!cors(req, res)) {
      return send(res, 403, {
        error: 'Origin not allowed.'
      });
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    if (req.method !== method) {
      return send(res, 405, {
        error: 'Method not allowed.'
      });
    }

    if (limited(req, name, limit)) {
      return send(res, 429, {
        error: 'Too many requests.'
      });
    }

    const user = await authenticate(req);

    if (needAuth && !user) {
      return send(res, 401, {
        error: 'Sign in required.'
      });
    }

    const b =
      method === 'POST'
        ? body(req)
        : {};

    if (b === null) {
      return send(res, 400, {
        error: 'Invalid JSON.'
      });
    }

    return handler(
      req,
      res,
      user,
      b
    );
  };

  // ---------------------------------------------------------------------------
  // ACCOUNT
  // ---------------------------------------------------------------------------

  const account = guard(
    'POST',
    async (req, res, user) => {
      const ex = await store.get(
        'users/' + user.uid
      );

      const rec = {
        uid: user.uid,
        provider:
          user.provider || 'firebase',
        email:
          user.email || null,
        name:
          user.name || null,
        lastSeen: now(),
        ...(ex
          ? {}
          : {
              createdAt: now(),
              wallets: []
            })
      };

      await store.set(
        'users/' + user.uid,
        rec,
        true
      );

      if (!ex) {
        await store.create(
          'events/signup_' + user.uid,
          {
            type: 'signup',
            uid: user.uid,
            recordedAt: now()
          }
        );
      }

      const u = await store.get(
        'users/' + user.uid
      );

      const linked = !!(
        await store.get(
          'identityLinks/' +
            (user.provider === 'privy'
              ? user.uid
              : 'fb_' + user.uid)
        )
      );

      return send(res, 200, {
        ok: true,
        uid: user.uid,
        wallets: u.wallets || [],
        identityLinked: linked
      });
    },
    {
      needAuth: true,
      name: 'account',
      limit: 30
    }
  );

  // ---------------------------------------------------------------------------
  // LINK WALLET
  // ---------------------------------------------------------------------------

  const linkWallet = guard(
    'POST',
    async (req, res, user, b) => {
      const {
        wallet,
        message,
        signature
      } = b;

      if (
        !ADDR_RE.test(wallet || '') ||
        typeof message !== 'string' ||
        typeof signature !== 'string'
      ) {
        return send(res, 400, {
          error: 'Invalid request.'
        });
      }

      const m =
        /^Saturn wallet link\nuid:(.+)\nwallet:(.+)\nissued:(\d+)$/.exec(
          message
        );

      if (
        !m ||
        m[1] !== user.uid ||
        m[2] !== wallet
      ) {
        return send(res, 400, {
          error:
            'Message does not match this account and wallet.'
        });
      }

      if (
        Math.abs(
          now() - Number(m[3])
        ) >
        10 * 60 * 1000
      ) {
        return send(res, 400, {
          error:
            'Link message expired. Try again.'
        });
      }

      const pub = b58dec(wallet);
      const sig = Buffer.from(
        signature,
        'base64'
      );

      if (
        !pub ||
        pub.length !== 32 ||
        sig.length !== 64 ||
        !verifyEd25519(
          pub,
          Buffer.from(
            message,
            'utf8'
          ),
          sig
        )
      ) {
        return send(res, 400, {
          error:
            'Wallet signature is invalid.'
        });
      }

      const created =
        await store.create(
          'walletLinks/' + wallet,
          {
            uid: user.uid,
            linkedAt: now()
          }
        );

      if (!created) {
        const ex =
          await store.get(
            'walletLinks/' + wallet
          );

        if (
          !ex ||
          ex.uid !== user.uid
        ) {
          return send(res, 409, {
            error:
              'This wallet is already linked to another account.'
          });
        }
      }

      const u =
        (await store.get(
          'users/' + user.uid
        )) || {};

      const wallets = [
        ...new Set([
          ...(u.wallets || []),
          wallet
        ])
      ];

      await store.set(
        'users/' + user.uid,
        {
          uid: user.uid,
          email:
            user.email || null,
          wallets,
          updatedAt: now()
        },
        true
      );

      if (created) {
        await store.create(
          'events/link_' + wallet,
          {
            type: 'wallet_link',
            uid: user.uid,
            wallet,
            recordedAt: now()
          }
        );
      }

      return send(res, 200, {
        ok: true,
        wallets
      });
    },
    {
      needAuth: true,
      name: 'link',
      limit: 10
    }
  );

  // ---------------------------------------------------------------------------
  // LINK IDENTITY
  // ---------------------------------------------------------------------------

  const linkIdentity = guard(
    'POST',
    async (req, res, user, b) => {
      if (user.provider !== 'privy') {
        return send(res, 403, {
          error:
            'Sign in with your new account first.'
        });
      }

      const tok =
        b.firebaseIdToken;

      if (
        typeof tok !== 'string' ||
        tok.length < 20 ||
        peekIssuer(tok) ===
          'privy.io'
      ) {
        return send(res, 400, {
          error: 'Invalid request.'
        });
      }

      let d;

      try {
        d =
          await auth.verifyIdToken(
            tok,
            true
          );
      } catch {
        return send(res, 401, {
          error:
            'Your previous account could not be verified.'
        });
      }

      if (
        !d ||
        typeof d.uid !== 'string' ||
        d.uid.startsWith(
          'did:privy:'
        )
      ) {
        return send(res, 401, {
          error:
            'Your previous account could not be verified.'
        });
      }

      if (
        typeof d.auth_time !==
          'number' ||
        Math.abs(
          now() / 1000 -
            d.auth_time
        ) > 300
      ) {
        return send(res, 401, {
          error:
            'Please sign in to your previous account again, then retry.'
        });
      }

      const pair =
        await store.createPair(
          'identityLinks/fb_' +
            d.uid,
          {
            privy: user.uid,
            firebaseUid: d.uid,
            linkedAt: now()
          },
          'identityLinks/' +
            user.uid,
          {
            privy: user.uid,
            firebaseUid: d.uid,
            email:
              d.email || null,
            linkedAt: now()
          }
        );

      if (!pair.created) {
        if (
          pair.a &&
          pair.b &&
          pair.b.firebaseUid ===
            d.uid &&
          pair.a.privy ===
            user.uid
        ) {
          return send(res, 200, {
            ok: true,
            duplicate: true
          });
        }

        return send(res, 409, {
          error:
            'One of these accounts is already linked to a different account.'
        });
      }

      await store.set(
        'users/' + user.uid,
        {
          uid: user.uid,
          provider: 'privy',
          linkedFirebaseUid:
            d.uid,
          updatedAt: now()
        },
        true
      );

      await store.create(
        'events/idlink_' +
          user.uid,
        {
          type: 'identity_link',
          privy: user.uid,
          firebaseUid:
            d.uid,
          recordedAt: now()
        }
      );

      return send(res, 200, {
        ok: true
      });
    },
    {
      needAuth: true,
      name: 'idlink',
      limit: 5
    }
  );

  // ---------------------------------------------------------------------------
  // TRANSACTION ANALYSIS
  // ---------------------------------------------------------------------------

  function analyse(
    tx,
    wallet,
    mint
  ) {
    const keys = (
      tx.transaction?.message
        ?.accountKeys || []
    ).map(k =>
      typeof k === 'string'
        ? {
            pubkey: k,
            signer: false
          }
        : k
    );

    const pre =
      tx.meta.preBalances;

    const post =
      tx.meta.postBalances;

    const wi =
      keys.findIndex(
        k => k.pubkey === wallet
      );

    const ti = treasury
      ? keys.findIndex(
          k =>
            k.pubkey ===
            treasury
        )
      : -1;

    const tok = (
      arr,
      owner,
      m
    ) =>
      (arr || [])
        .filter(
          b =>
            b.owner === owner &&
            (!m ||
              b.mint === m)
        )
        .reduce(
          (x, b) =>
            x +
            big(
              b.uiTokenAmount
                ?.amount
            ),
          0n
        );

    const tre = {};

    if (treasury) {
      for (const b of [
        ...(tx.meta
          .postTokenBalances ||
          []),
        ...(tx.meta
          .preTokenBalances ||
          [])
      ]) {
        if (
          b.owner === treasury
        ) {
          tre[b.mint] ??= (
            tok(
              tx.meta
                .postTokenBalances,
              treasury,
              b.mint
            ) -
            tok(
              tx.meta
                .preTokenBalances,
              treasury,
              b.mint
            )
          ).toString();
        }
      }
    }

    return {
      feePayer:
        keys[0]?.pubkey,

      walletSigned:
        wi >= 0 &&
        keys[wi].signer ===
          true,

      hasMint:
        !!mint &&
        keys.some(
          k =>
            k.pubkey === mint
        ),

      tokenDelta: mint
        ? (
            tok(
              tx.meta
                .postTokenBalances,
              wallet,
              mint
            ) -
            tok(
              tx.meta
                .preTokenBalances,
              wallet,
              mint
            )
          ).toString()
        : '0',

      solDelta:
        wi >= 0
          ? (
              big(post[wi]) -
              big(pre[wi])
            ).toString()
          : '0',

      txFee: String(
        tx.meta.fee ?? 0
      ),

      treasuryLamportsDelta:
        ti >= 0
          ? (
              big(post[ti]) -
              big(pre[ti])
            ).toString()
          : '0',

      treasuryTokenDeltas:
        tre,

      feeVerified:
        (ti >= 0 &&
          big(post[ti]) -
            big(pre[ti]) >
            0n) ||
        Object.values(tre).some(
          v => big(v) > 0n
        ),

      blockTime:
        tx.blockTime
          ? tx.blockTime * 1000
          : null
    };
  }

  // ---------------------------------------------------------------------------
  // EVENTS
  // ---------------------------------------------------------------------------

  const events = guard(
    'POST',
    async (
      req,
      res,
      user,
      b
    ) => {
      const {
        type,
        sig,
        wallet,
        mint,
        side,
        kind
      } = b;

      if (
        !['trade', 'launch'].includes(
          type
        ) ||
        !SIG_RE.test(sig || '') ||
        !ADDR_RE.test(
          wallet || ''
        ) ||
        !ADDR_RE.test(
          mint || ''
        )
      ) {
        return send(res, 400, {
          error: 'Invalid event.'
        });
      }

      if (
        type === 'trade' &&
        !['buy', 'sell'].includes(
          side
        )
      ) {
        return send(res, 400, {
          error: 'Invalid side.'
        });
      }

      if (
        await store.get(
          'events/' + sig
        )
      ) {
        return send(res, 200, {
          ok: true,
          duplicate: true
        });
      }

      let tx;

      try {
        tx =
          await rpc.getTransaction(
            sig
          );
      } catch {
        return send(res, 502, {
          error:
            'RPC unavailable.'
        });
      }

      if (!tx) {
        return send(res, 202, {
          ok: false,
          status: 'pending'
        });
      }

      if (tx.meta?.err) {
        const ok = (
          tx.transaction
            ?.message
            ?.accountKeys ||
          []
        ).some(
          k =>
            (k.pubkey || k) ===
              wallet &&
            k.signer !== false
        );

        if (ok) {
          await store.create(
            'errors/' + sig,
            {
              type: 'tx_failed',
              sig,
              wallet,
              mint,
              error:
                JSON.stringify(
                  tx.meta.err
                ).slice(0, 300),
              recordedAt: now()
            }
          );
        }

        return send(res, 200, {
          ok: false,
          status:
            'failed_on_chain'
        });
      }

      const a = analyse(
        tx,
        wallet,
        mint
      );

      if (
        a.feePayer !== wallet ||
        !a.walletSigned
      ) {
        return send(res, 422, {
          error:
            'Wallet did not sign this transaction.'
        });
      }

      if (
        type === 'trade' &&
        (
          (
            side === 'buy' &&
            big(a.tokenDelta) <=
              0n
          ) ||
          (
            side === 'sell' &&
            big(a.tokenDelta) >=
              0n
          )
        )
      ) {
        return send(res, 422, {
          error:
            'Token movement does not match the side.'
        });
      }

      if (
        type === 'launch' &&
        !a.hasMint
      ) {
        return send(res, 422, {
          error:
            'Mint is not part of this transaction.'
        });
      }

      let uid = null;

      if (user) {
        const l =
          await store.get(
            'walletLinks/' +
              wallet
          );

        if (
          l &&
          l.uid === user.uid
        ) {
          uid = user.uid;
        }
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
                kind ===
                'PUMP_LAUNCH'
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

      const created =
        await store.create(
          'events/' + sig,
          rec
        );

      return send(res, 200, {
        ok: true,
        duplicate: !created
      });
    },
    {
      name: 'events',
      limit: 60
    }
  );

  // ---------------------------------------------------------------------------
  // OWNER
  // ---------------------------------------------------------------------------

  const owner = guard(
    'GET',
    async (req, res, 
