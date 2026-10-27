// Saturn rewards: server-side cashback + creator-reward ledger and the claim/payout state machine.
// Everything here is derived from CHAIN-VERIFIED facts (the confirmed transaction fetched by the server). No amount, fee, volume or mint
// supplied by a browser is ever used as a number. All state lives in Firestore (Admin SDK only; clients are denied by firestore.rules).
//
// Collections (written only here):
//   rewardsConfig/main                          { startAt }                       first-seen deployment time (unless REWARDS_START_AT is set)
//   rewardAccounts/{wallet}                     running totals in lamports + `inflight` claim id
//   rewardAccounts/{wallet}/cashback/{sig}      one row per credited trade (audit: fee, bps, amount, volume)
//   rewardAccounts/{wallet}/creator/{sig}       one row per credited trade on a token the wallet created
//   creatorMints/{mint}                         create-once registry: mint -> verified creator wallet + launch signature + running totals
//   claims/{wallet_key}                         payout state machine (reserved -> sending -> paid | released)
//   payoutStats/{yyyy-mm-dd}                    reserved lamports per UTC day (daily cap)

export const CASHBACK_BPS = 2500;   // 25% of the verified Saturn platform fee
export const CREATOR_BPS = 3000;    // 30% of the verified Saturn platform fee on trades of a registered creator token

const WSOL = 'So11111111111111111111111111111111111111112';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGRE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const KEYRE = /^[A-Za-z0-9_-]{16,64}$/;
const big = x => BigInt(Math.trunc(Number(x ?? 0)) || 0);
const num = b => Number(b);
const share = (fee, bps) => (fee * BigInt(bps)) / 10000n;
const out = (status, body) => ({ status, body });
const FIELDS = {
  cashback: { earned: 'cashbackEarned', claimed: 'cashbackClaimed', reserved: 'cashbackReserved' },
  creator: { earned: 'creatorEarned', claimed: 'creatorClaimed', reserved: 'creatorReserved' }
};
const KINDS = ['all', 'cashback', 'creator'];

// ---------- pure, chain-derived helpers ----------

// Saturn's verified platform fee for one transaction, in lamports: the SOL the treasury actually received in that very transaction
// (native lamports to the treasury + wrapped-SOL token balance gained by treasury-owned accounts). Token-denominated fees in any other mint are
// NOT counted: they cannot be priced from chain data, so they earn no reward.
export function verifiedFeeLamports(a) {
  let f = 0n;
  const n = big(a.treasuryLamportsDelta);
  if (n > 0n) f += n;
  const w = a.treasuryTokenDeltas && a.treasuryTokenDeltas[WSOL];
  if (w != null && big(w) > 0n) f += big(w);
  return f;
}

// Non-WSOL mints whose balance for `wallet` changed in this transaction (derived from chain data, never from the request).
export function walletMintDeltas(tx, wallet) {
  const sum = (arr, m) => (arr || []).filter(b => b.owner === wallet && b.mint === m).reduce((x, b) => x + BigInt(b.uiTokenAmount?.amount ?? 0), 0n);
  const mints = new Set();
  for (const b of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) if (b.owner === wallet && b.mint !== WSOL) mints.add(b.mint);
  return [...mints].filter(m => sum(tx.meta.postTokenBalances, m) - sum(tx.meta.preTokenBalances, m) !== 0n);
}

// Cryptographic launch proof. The wallet must have paid for and signed the transaction, AND the mint address must be
// (a) a SIGNER of the transaction (only the holder of the new mint's key can make it sign), (b) an account that did not exist before
// the transaction and exists after it, and (c) initialised as a mint (SPL initializeMint/initializeMint2) or handed to the Pump program.
// Merely mentioning someone else's mint in a transaction proves nothing and is rejected.
export function creatorProof(tx, wallet, mint) {
  const keys = (tx.transaction?.message?.accountKeys || []).map(k => (typeof k === 'string' ? { pubkey: k, signer: false } : k));
  if (!keys.length) return { ok: false, reason: 'no_keys' };
  if (keys[0].pubkey !== wallet || keys[0].signer !== true) return { ok: false, reason: 'wallet_not_fee_payer' };
  const mi = keys.findIndex(k => k.pubkey === mint);
  if (mi < 0) return { ok: false, reason: 'mint_missing' };
  if (keys[mi].signer !== true) return { ok: false, reason: 'mint_not_signer' };
  const pre = tx.meta?.preBalances, post = tx.meta?.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post) || big(pre[mi]) !== 0n || big(post[mi]) <= 0n) return { ok: false, reason: 'mint_not_new' };
  const ixs = [...(tx.transaction?.message?.instructions || []), ...((tx.meta?.innerInstructions || []).flatMap(i => i.instructions || []))];
  const initialised = ixs.some(ix => {
    const p = ix && ix.parsed;
    if (p && /^initializeMint2?$/.test(p.type) && p.info && p.info.mint === mint) return true;
    return ix && ix.programId === PUMP_PROGRAM && Array.isArray(ix.accounts) && ix.accounts.includes(mint);
  });
  return initialised ? { ok: true } : { ok: false, reason: 'mint_not_initialised' };
}

export function createRewards({ db, store, rpc, payout, env, now = () => Date.now() }) {
  const treasury = env.PLATFORM_TREASURY_WALLET || '';
  const minClaim = BigInt(env.REWARD_MIN_CLAIM_LAMPORTS || 1_000_000);   // 0.001 SOL
  const maxClaim = BigInt(env.REWARD_MAX_CLAIM_LAMPORTS || 5_000_000_000); // 5 SOL per claim
  const dailyCap = BigInt(env.REWARD_DAILY_CAP_LAMPORTS || 50_000_000_000); // 50 SOL per UTC day
  const KEEP = 5_000_000n, NET_FEE = 5_000n;                                // treasury must keep a buffer after paying
  const EXPIRY_MARGIN = 150;                                                // blocks past lastValidBlockHeight before a claim may be released
  const sleep = (payout && payout.sleep) || (ms => new Promise(r => setTimeout(r, ms)));
  const payoutsOn = () => env.SATURN_PAYOUTS_ENABLED === 'true';

  let startAt = null;
  async function getStartAt() {
    if (startAt != null) return startAt;
    const e = Date.parse(env.REWARDS_START_AT || '') || Number(env.REWARDS_START_AT);
    if (Number.isFinite(e) && e > 0) return (startAt = e);
    const ref = db.doc('rewardsConfig/main');
    const v = await db.runTransaction(async t => {
      const s = await t.get(ref);
      if (s.exists) return s.data().startAt;
      t.create(ref, { startAt: now(), createdAt: now() });
      return now();
    });
    return (startAt = v);
  }

  // Decide whether a verified trade earns rewards, and how much. `a` = the server's own analysis of the transaction.
  async function assessTrade({ tx, a, wallet, mint }) {
    const fee = verifiedFeeLamports(a);
    const base = { fee, volume: (big(a.solDelta) < 0n ? -big(a.solDelta) : big(a.solDelta)) };
    if (!a.feeVerified || fee <= 0n) return { ...base, eligible: false, reason: 'no_verified_fee' };
    if (treasury && wallet === treasury) return { ...base, eligible: false, reason: 'treasury_wallet' };
    const mints = walletMintDeltas(tx, wallet);
    if (mints.length !== 1 || mints[0] !== mint) return { ...base, eligible: false, reason: 'ambiguous_mint' };
    const sa = await getStartAt();
    if ((a.blockTime || now()) < sa) return { ...base, eligible: false, reason: 'before_rewards_start' };
    return { ...base, eligible: true, cashback: share(fee, CASHBACK_BPS) };
  }

  const acctDefaults = wallet => ({ wallet, cashbackEarned: 0, cashbackClaimed: 0, cashbackReserved: 0, cashbackVolume: 0, cashbackTrades: 0, creatorEarned: 0, creatorClaimed: 0, creatorReserved: 0, inflight: null, createdAt: now() });

  // ONE Firestore transaction: event + cashback row + creator row + running totals. Replays of the same signature change nothing.
  async function recordTrade({ sig, event, wallet, mint, side, a }) {
    const fee = a.fee, vol = a.volume;
    const evRef = db.doc('events/' + sig), acRef = db.doc('rewardAccounts/' + wallet), cmRef = db.doc('creatorMints/' + mint);
    return db.runTransaction(async t => {
      const ev = await t.get(evRef);
      if (ev.exists) return { created: false };
      const ac = await t.get(acRef), cm = await t.get(cmRef);
      const cmd = cm.exists ? cm.data() : null;
      const creatorWallet = cmd && cmd.creator !== wallet ? cmd.creator : null;   // a creator's own trades do not count as creator volume
      const crAc = creatorWallet ? await t.get(db.doc('rewardAccounts/' + creatorWallet)) : null;
      const cashback = share(fee, CASHBACK_BPS), creator = creatorWallet ? share(fee, CREATOR_BPS) : 0n;
      const ts = now();

      t.create(evRef, { ...event, cashbackLamports: num(cashback), creatorRewardLamports: num(creator) });
      const acc = ac.exists ? ac.data() : acctDefaults(wallet);
      if (cashback > 0n) {
        t.create(db.doc(`rewardAccounts/${wallet}/cashback/${sig}`), { sig, wallet, mint, side, feeLamports: num(fee), bps: CASHBACK_BPS, cashbackLamports: num(cashback), volumeLamports: num(vol), blockTime: event.blockTime || null, createdAt: ts });
        acc.cashbackEarned = num(big(acc.cashbackEarned) + cashback);
        acc.cashbackVolume = num(big(acc.cashbackVolume) + vol);
        acc.cashbackTrades = (acc.cashbackTrades || 0) + 1;
        acc.updatedAt = ts;
        t.set(acRef, acc);
      }
      if (creatorWallet) {
        const ca = crAc.exists ? crAc.data() : acctDefaults(creatorWallet);
        if (creator > 0n) {
          t.create(db.doc(`rewardAccounts/${creatorWallet}/creator/${sig}`), { sig, mint, trader: wallet, feeLamports: num(fee), bps: CREATOR_BPS, rewardLamports: num(creator), volumeLamports: num(vol), blockTime: event.blockTime || null, createdAt: ts });
          ca.creatorEarned = num(big(ca.creatorEarned) + creator);
          ca.updatedAt = ts;
          t.set(db.doc('rewardAccounts/' + creatorWallet), ca);
        }
        t.set(cmRef, { ...cmd, volumeLamports: num(big(cmd.volumeLamports) + vol), feeLamports: num(big(cmd.feeLamports) + fee), earnedLamports: num(big(cmd.earnedLamports) + creator), trades: (cmd.trades || 0) + 1, updatedAt: ts });
      }
      return { created: true, cashbackLamports: num(cashback), creatorRewardLamports: num(creator) };
    });
  }

  // Register creator <-> mint ONLY from a verified launch transaction. First verified registrant wins; nobody else can take the mint.
  async function registerCreator({ mint, wallet, sig, kind, blockTimeMs }) {
    const ref = db.doc('creatorMints/' + mint);
    return db.runTransaction(async t => {
      const s = await t.get(ref);
      if (s.exists) return s.data().creator === wallet ? { ok: true, duplicate: true } : { ok: false, conflict: true };
      t.create(ref, { mint, creator: wallet, launchSig: sig, launchKind: kind || null, launchedAt: blockTimeMs || null, registeredAt: now(), volumeLamports: 0, feeLamports: 0, earnedLamports: 0, trades: 0 });
      return { ok: true, created: true };
    });
  }

  // Credit the creator for trades on this mint that were recorded (post-deployment, fee-verified) BEFORE the launch was registered.
  async function reconcileCreator(mint) {
    const snap = await db.collection('events').where('mint', '==', mint).limit(300).get();
    let credited = 0;
    for (const d of snap.docs) {
      const e = d.data();
      if (e.type !== 'trade' || !e.rewardEligible || !(big(e.feeLamports) > 0n)) continue;
      const r = await creditCreatorForEvent(e);
      if (r) credited++;
    }
    return credited;
  }
  async function creditCreatorForEvent(e) {
    const cmRef = db.doc('creatorMints/' + e.mint);
    return db.runTransaction(async t => {
      const cm = await t.get(cmRef);
      if (!cm.exists) return false;
      const cmd = cm.data();
      if (cmd.creator === e.wallet) return false;
      const lRef = db.doc(`rewardAccounts/${cmd.creator}/creator/${e.sig}`);
      const l = await t.get(lRef);
      if (l.exists) return false;
      const ac = await t.get(db.doc('rewardAccounts/' + cmd.creator));
      const fee = big(e.feeLamports), vol = big(e.volumeLamports), reward = share(fee, CREATOR_BPS), ts = now();
      if (reward <= 0n) return false;
      const ca = ac.exists ? ac.data() : acctDefaults(cmd.creator);
      ca.creatorEarned = num(big(ca.creatorEarned) + reward); ca.updatedAt = ts;
      t.create(lRef, { sig: e.sig, mint: e.mint, trader: e.wallet, feeLamports: num(fee), bps: CREATOR_BPS, rewardLamports: num(reward), volumeLamports: num(vol), blockTime: e.blockTime || null, createdAt: ts, reconciled: true });
      t.set(db.doc('rewardAccounts/' + cmd.creator), ca);
      t.set(cmRef, { ...cmd, volumeLamports: num(big(cmd.volumeLamports) + vol), feeLamports: num(big(cmd.feeLamports) + fee), earnedLamports: num(big(cmd.earnedLamports) + reward), trades: (cmd.trades || 0) + 1, updatedAt: ts });
      return true;
    });
  }

  // From a launch transaction the server has already fetched (used by /api/events and register-launch).
  async function registerFromTx(tx, { wallet, mint, sig, kind }) {
    const proof = creatorProof(tx, wallet, mint);
    if (!proof.ok) return { ok: false, reason: proof.reason };
    const r = await registerCreator({ mint, wallet, sig, kind, blockTimeMs: tx.blockTime ? tx.blockTime * 1000 : null });
    if (!r.ok) return { ok: false, reason: 'mint_already_registered' };
    if (r.created) { try { await reconcileCreator(mint); } catch { /* best effort; the live path credits all later trades */ } }
    return { ok: true, duplicate: !!r.duplicate };
  }

  // ---------- reads ----------
  const accOf = async wallet => { const s = await db.doc('rewardAccounts/' + wallet).get(); return s.exists ? { ...acctDefaults(wallet), ...s.data() } : acctDefaults(wallet); };
  const avail = (acc, k) => { const f = FIELDS[k], v = big(acc[f.earned]) - big(acc[f.claimed]) - big(acc[f.reserved]); return v > 0n ? v : 0n; };

  async function linkedWallet(user, wallet) {
    const u = (await store.get('users/' + user.uid)) || {};
    const wallets = (u.wallets || []).filter(w => ADDR.test(w));
    let w = wallet;
    if (w == null) { if (wallets.length === 1) w = wallets[0]; else return { error: wallets.length ? 'wallet_ambiguous' : 'no_linked_wallet' }; }
    if (!ADDR.test(w)) return { error: 'invalid_wallet' };
    const l = await store.get('walletLinks/' + w);
    if (!l || l.uid !== user.uid) return { error: 'wallet_not_linked' };
    return { wallet: w };
  }

  async function summary(user, b) {
    const lw = await linkedWallet(user, b.wallet);
    if (lw.error) return out(lw.error === 'invalid_wallet' ? 400 : 403, { ok: false, error: lw.error });
    const wallet = lw.wallet;
    let acc = await accOf(wallet);
    if (acc.inflight) { try { await settle(acc.inflight); } catch { /* shown as pending below */ } acc = await accOf(wallet); }
    const hist = async k => {
      const s = await db.collection(`rewardAccounts/${wallet}/${k}`).orderBy('createdAt', 'desc').limit(20).get();
      return s.docs.map(d => d.data()).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, 20);
    };
    const [cbH, crH, toks] = await Promise.all([
      hist('cashback'), hist('creator'),
      db.collection('creatorMints').where('creator', '==', wallet).limit(100).get().then(s => s.docs.map(d => d.data()))
    ]);
    let inflight = null;
    if (acc.inflight) { const c = (await db.doc('claims/' + acc.inflight).get()); if (c.exists) inflight = pubClaim(c.data()); }
    const S = x => String(x);
    return out(200, {
      ok: true, wallet,
      config: { cashbackBps: CASHBACK_BPS, creatorBps: CREATOR_BPS, minClaimLamports: S(minClaim), payoutsEnabled: payoutsOn(), startAt: await getStartAt() },
      cashback: { earned: S(big(acc.cashbackEarned)), claimed: S(big(acc.cashbackClaimed)), reserved: S(big(acc.cashbackReserved)), claimable: S(avail(acc, 'cashback')), volume: S(big(acc.cashbackVolume)), trades: acc.cashbackTrades || 0, history: cbH },
      creator: { earned: S(big(acc.creatorEarned)), claimed: S(big(acc.creatorClaimed)), reserved: S(big(acc.creatorReserved)), claimable: S(avail(acc, 'creator')), history: crH, tokens: toks.sort((x, y) => (y.registeredAt || 0) - (x.registeredAt || 0)) },
      total: { claimable: S(avail(acc, 'cashback') + avail(acc, 'creator')) },
      claim: inflight
    });
  }

  const pubClaim = c => ({ key: c.key, kind: c.kind, status: c.status, lamports: String(c.lamports), signature: c.sig || null, reason: c.reason || null });

  // ---------- claims: reserve -> sign (stored) -> send -> confirm -> paid | released ----------
  const dayKey = () => new Date(now()).toISOString().slice(0, 10);

  async function reserve({ wallet, uid, kind, key }) {
    const id = wallet + '_' + key, cRef = db.doc('claims/' + id), aRef = db.doc('rewardAccounts/' + wallet), dRef = db.doc('payoutStats/' + dayKey());
    const r = await db.runTransaction(async t => {
      const c = await t.get(cRef);
      if (c.exists) return { existing: c.data() };
      const a = await t.get(aRef), d = await t.get(dRef);
      const acc = a.exists ? { ...acctDefaults(wallet), ...a.data() } : acctDefaults(wallet);
      if (acc.inflight && acc.inflight !== id) return { busy: acc.inflight };
      let cb = kind !== 'creator' ? avail(acc, 'cashback') : 0n, cr = kind !== 'cashback' ? avail(acc, 'creator') : 0n;
      if (cb + cr > maxClaim) { if (cb > maxClaim) { cb = maxClaim; cr = 0n; } else cr = maxClaim - cb; }
      const total = cb + cr;
      if (total < minClaim) return { none: true, total };
      const used = big(d.exists ? d.data().lamports : 0);
      if (used + total > dailyCap) return { capped: true };
      const rec = { id, key, wallet, uid, kind, lamports: num(total), cashbackLamports: num(cb), creatorLamports: num(cr), status: 'reserved', createdAt: now(), updatedAt: now() };
      t.create(cRef, rec);
      acc.cashbackReserved = num(big(acc.cashbackReserved) + cb);
      acc.creatorReserved = num(big(acc.creatorReserved) + cr);
      acc.inflight = id; acc.updatedAt = now();
      t.set(aRef, acc);
      t.set(dRef, { day: dayKey(), lamports: num(used + total) });
      return { created: rec };
    });
    return r;
  }

  // Finish a claim: used for fresh claims AND to recover interrupted/uncertain ones. Never builds a second transaction once one is stored.
  async function settle(id) {
    const ref = db.doc('claims/' + id);
    let c = (await ref.get());
    if (!c.exists) return null;
    c = c.data();
    if (c.status === 'paid' || c.status === 'released') return c;
    if (!c.sig) {
      let bal;
      try { bal = await payout.balance(); } catch { return c; }                       // RPC trouble: stay reserved, retry later
      if (bal < BigInt(c.lamports) + KEEP + NET_FEE) return release(id, 'treasury_insufficient');
      let bh, tx;
      try { bh = await payout.latestBlockhash(); tx = payout.build(c.wallet, BigInt(c.lamports), bh.blockhash); }
      catch { return c; }
      c = await db.runTransaction(async t => {                                         // persist BEFORE sending; the first writer wins
        const s = await t.get(ref), d = s.data();
        if (d.sig || d.status !== 'reserved') return d;
        const n = { ...d, sig: tx.signature, wire: tx.wire, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, status: 'sending', updatedAt: now() };
        t.set(ref, n);
        return n;
      });
      if (c.status === 'paid' || c.status === 'released') return c;
    }
    return confirm(c);
  }

  async function confirm(c) {
    const done = st => st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized');
    let st = null;
    try { st = await payout.status(c.sig); } catch { return c; }
    if (st && st.err) return release(c.id, 'tx_failed');
    if (done(st)) return markPaid(c.id);
    if (!st) {
      let h; try { h = await payout.blockHeight(); } catch { return c; }
      if (h > c.lastValidBlockHeight + EXPIRY_MARGIN) {                                // blockhash can no longer land: re-check history once, then release
        let s2 = null; try { s2 = await payout.status(c.sig, { history: true }); } catch { return c; }
        if (done(s2)) return markPaid(c.id);
        if (s2 && s2.err) return release(c.id, 'tx_failed');
        if (!s2) return release(c.id, 'expired');
        return c;
      }
      try { await payout.send(c.wire); } catch { /* uncertain: the SAME signed transaction may still land; keep polling / retry later */ }
    }
    for (let i = 0; i < 5; i++) {
      await sleep(1200);
      let s; try { s = await payout.status(c.sig); } catch { break; }
      if (s && s.err) return release(c.id, 'tx_failed');
      if (done(s)) return markPaid(c.id);
    }
    return c;
  }

  async function markPaid(id) {
    const cRef = db.doc('claims/' + id);
    return db.runTransaction(async t => {
      const s = await t.get(cRef); const c = s.data();
      if (c.status === 'paid') return c;
      const aRef = db.doc('rewardAccounts/' + c.wallet), a = await t.get(aRef), acc = { ...acctDefaults(c.wallet), ...a.data() };
      acc.cashbackReserved = Math.max(0, acc.cashbackReserved - c.cashbackLamports); acc.cashbackClaimed += c.cashbackLamports;
      acc.creatorReserved = Math.max(0, acc.creatorReserved - c.creatorLamports); acc.creatorClaimed += c.creatorLamports;
      if (acc.inflight === id) acc.inflight = null;
      acc.updatedAt = now();
      const n = { ...c, status: 'paid', paidAt: now(), updatedAt: now() };
      t.set(aRef, acc); t.set(cRef, n);
      return n;
    });
  }

  async function release(id, reason) {
    const cRef = db.doc('claims/' + id);
    return db.runTransaction(async t => {
      const s = await t.get(cRef); const c = s.data();
      if (c.status === 'paid' || c.status === 'released') return c;
      const aRef = db.doc('rewardAccounts/' + c.wallet), a = await t.get(aRef);
      const dRef = db.doc('payoutStats/' + new Date(c.createdAt).toISOString().slice(0, 10)), d = await t.get(dRef);
      const acc = { ...acctDefaults(c.wallet), ...a.data() };
      acc.cashbackReserved = Math.max(0, acc.cashbackReserved - c.cashbackLamports);
      acc.creatorReserved = Math.max(0, acc.creatorReserved - c.creatorLamports);
      if (acc.inflight === id) acc.inflight = null;
      acc.updatedAt = now();
      const n = { ...c, status: 'released', reason, updatedAt: now() };
      t.set(aRef, acc); t.set(cRef, n);
      if (d.exists) t.set(dRef, { ...d.data(), lamports: Math.max(0, d.data().lamports - c.lamports) });
      return n;
    });
  }

  const claimReply = c => {
    if (c.status === 'paid') return out(200, { ok: true, claim: pubClaim(c) });
    if (c.status === 'released') return out(c.reason === 'treasury_insufficient' ? 503 : 409, { ok: false, error: c.reason || 'released', claim: pubClaim(c) });
    return out(202, { ok: true, pending: true, claim: pubClaim(c) });
  };

  async function claim(user, b) {
    if (!KINDS.includes(b.kind)) return out(400, { ok: false, error: 'invalid_kind' });
    if (typeof b.key !== 'string' || !KEYRE.test(b.key)) return out(400, { ok: false, error: 'invalid_key' });
    const lw = await linkedWallet(user, b.wallet);
    if (lw.error) return out(lw.error === 'invalid_wallet' ? 400 : 403, { ok: false, error: lw.error });
    if (!payoutsOn()) return out(503, { ok: false, error: 'payouts_disabled' });
    if (!payout || !payout.ready()) return out(503, { ok: false, error: 'payout_unavailable' });
    const wallet = lw.wallet;
    let r = await reserve({ wallet, uid: user.uid, kind: b.kind, key: b.key });
    if (r.busy) {                                                                       // another claim is unresolved: finish/recover it first
      const prev = await settle(r.busy);
      if (!prev || (prev.status !== 'paid' && prev.status !== 'released')) return out(409, { ok: false, error: 'claim_in_progress', claim: prev ? pubClaim(prev) : null });
      r = await reserve({ wallet, uid: user.uid, kind: b.kind, key: b.key });
      if (r.busy) return out(409, { ok: false, error: 'claim_in_progress' });
    }
    if (r.existing) { if (r.existing.wallet !== wallet || r.existing.uid !== user.uid) return out(409, { ok: false, error: 'key_in_use' }); const c = await settle(r.existing.id); return claimReply(c || r.existing); }
    if (r.none) return out(400, { ok: false, error: 'nothing_to_claim', claimableLamports: String(r.total), minClaimLamports: String(minClaim) });
    if (r.capped) return out(503, { ok: false, error: 'daily_cap_reached' });
    const c = await settle(r.created.id);
    return claimReply(c || r.created);
  }

  async function registerLaunch(b) {
    const { sig, wallet, mint } = b;
    if (!SIGRE.test(sig || '') || !ADDR.test(wallet || '') || !ADDR.test(mint || '')) return out(400, { ok: false, error: 'invalid_request' });
    let tx;
    try { tx = await rpc.getTransaction(sig); } catch { return out(502, { ok: false, error: 'rpc_unavailable' }); }
    if (!tx) return out(202, { ok: false, status: 'pending' });
    if (tx.meta?.err) return out(422, { ok: false, error: 'tx_failed_on_chain' });
    const r = await registerFromTx(tx, { wallet, mint, sig, kind: b.kind });
    if (!r.ok) return out(r.reason === 'mint_already_registered' ? 409 : 422, { ok: false, error: r.reason });
    return out(200, { ok: true, duplicate: !!r.duplicate });
  }

  async function handle(user, b) {
    switch (b.action) {
      case 'register-launch': return registerLaunch(b);
      case 'summary': if (!user) return out(401, { ok: false, error: 'sign_in_required' }); return summary(user, b);
      case 'claim': if (!user) return out(401, { ok: false, error: 'sign_in_required' }); return claim(user, b);
      default: return out(400, { ok: false, error: 'invalid_action' });
    }
  }

  return { assessTrade, recordTrade, registerFromTx, registerCreator, reconcileCreator, handle, summary, claim, settle };
}
