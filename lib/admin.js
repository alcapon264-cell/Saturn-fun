// Saturn admin service. ESM, no side effects at import time. All I/O is injected (db = Firestore Admin handle).
// Served ONLY through POST /api/admin (one route, action-based). Never reads or stores wallet private keys.
//
// Collections (Admin SDK only; firestore.rules deny every client read/write):
//   adminRoles/{uid}        role, email, disabled, addedBy, addedAt            (owner is NEVER stored here: OWNER_UIDS env only)
//   adminAudit/{id}         ts, actor, role, action, target, detail, ok         (every mutation and every denial)
//   adminLogins/{id}        ts, uid, email, role, ip                            (whoami by an authorised admin)
//   adminSecurity/{id}      ts, uid, email, kind, action, ip                    (denied / unauthorised attempts)
//   moderation/{uid}        status, restriction, history[]                      (RECORD-ONLY: nothing in Saturn enforces it yet)
//   reports/{id}            existing Settings problem reports + new targeted reports (lib/reports.js)
//
// Moderation here is INSIDE SATURN ONLY and is a record. No Solana asset or transaction is ever touched.
import crypto from 'node:crypto';

export const PERMS = [
  'overview.read', 'users.read', 'tokens.read', 'trades.read', 'rewards.read', 'reports.read', 'reports.write',
  'moderation.write', 'community.read', 'system.read', 'security.read', 'roles.manage', 'settings.read'
];
export const ROLES = Object.freeze({
  owner: PERMS,
  moderator: ['overview.read', 'users.read', 'tokens.read', 'reports.read', 'reports.write', 'moderation.write', 'community.read'],
  support: ['overview.read', 'users.read', 'tokens.read', 'reports.read'],
  finance: ['overview.read', 'tokens.read', 'trades.read', 'rewards.read']
});
export const ASSIGNABLE_ROLES = ['moderator', 'support', 'finance'];
export const REPORT_STATUSES = ['new', 'review', 'escalated', 'resolved', 'rejected'];
export const OPEN_STATUSES = ['new', 'review', 'escalated'];
export const MOD_TYPES = ['warn', 'restrict'];

// action -> [permission, isMutation]
export const ACTIONS = Object.freeze({
  whoami: [null, false],
  overview: ['overview.read', false],
  'users-search': ['users.read', false], 'user-get': ['users.read', false],
  'tokens-list': ['tokens.read', false], 'token-get': ['tokens.read', false],
  'trades-list': ['trades.read', false],
  'rewards-summary': ['rewards.read', false],
  'reports-list': ['reports.read', false], 'report-get': ['reports.read', false],
  'report-update': ['reports.write', true],
  'moderate-user': ['moderation.write', true], 'moderation-lift': ['moderation.write', true],
  'community-messages': ['community.read', false],
  'system-health': ['system.read', false],
  'audit-list': ['security.read', false], 'logins-list': ['security.read', false], 'security-alerts': ['security.read', false],
  'roles-list': ['security.read', false], 'role-set': ['roles.manage', true], 'role-remove': ['roles.manage', true],
  'settings-get': ['settings.read', false]
});

const MAX_AGE_MS = 12 * 3600 * 1000;
const UID_RE = /^[A-Za-z0-9:_.-]{3,128}$/;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (v, max) => typeof v === 'string' ? v.normalize('NFC').replace(CTRL, ' ').trim().slice(0, max) : '';
const big = x => { try { return BigInt(x ?? 0); } catch { return 0n; } };
const abs = x => (x < 0n ? -x : x);
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const ipOf = req => String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim() || 'unknown';

export function createAdmin({ db, isOwner, now = () => Date.now(), env = {}, probes = {} }) {
  const col = n => db.collection(n);
  const bad = (status, error, extra = {}) => ({ status, body: { ok: false, error, ...extra } });
  const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });

  async function rows(name, { limit = 500, orderBy } = {}) {
    let q = col(name);
    if (orderBy) q = q.orderBy(orderBy, 'desc');
    const s = await q.limit(limit).get();
    const out = s.docs.map(d => ({ id: d.id, ...d.data() }));
    if (orderBy) out.sort((a, b) => (Number(b[orderBy]) || 0) - (Number(a[orderBy]) || 0));
    return out;
  }
  async function where(name, field, v, limit = 200) {
    const s = await col(name).where(field, '==', v).limit(limit).get();
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  const one = async path => { const s = await db.doc(path).get(); return s.exists ? s.data() : null; };

  // ---------------- identity + roles
  async function resolveRole(user) {
    if (!user || typeof user.uid !== 'string' || user.provider !== 'firebase') return null; // admin app uses Google/Firebase only
    if (isOwner(user)) return 'owner';
    if (!UID_RE.test(user.uid)) return null;
    const r = await one('adminRoles/' + user.uid);
    return r && !r.disabled && ASSIGNABLE_ROLES.includes(r.role) ? r.role : null;
  }
  const fresh = user => {
    const t = Number(user && user.auth_time);
    return Number.isFinite(t) && now() - t * 1000 <= MAX_AGE_MS;
  };

  // ---------------- audit
  // Mutations write their audit record in the SAME Firestore transaction as the change (auditTx), so an audit failure aborts the
  // change and a change can never complete without its record. audit() (stand-alone) is used only for permission denials.
  const auditEntry = (actor, role, action, target, detail, success = true) => {
    const id = now() + '_' + crypto.randomBytes(6).toString('hex');
    return [db.doc('adminAudit/' + id), { ts: now(), actor: actor.uid, email: actor.email || null, role: role || null, action, target: target || null, detail: detail || null, ok: success }];
  };
  const auditTx = (tx, actor, role, action, target, detail) => { const [ref, rec] = auditEntry(actor, role, action, target, detail); tx.create(ref, rec); };
  async function audit(actor, role, action, target, detail, success = true) {
    const [ref, rec] = auditEntry(actor, role, action, target, detail, success);
    await ref.create(rec);
  }
  async function alert(req, user, kind, action) {
    const id = now() + '_' + crypto.randomBytes(6).toString('hex');
    try { await col('adminSecurity').doc(id).create({ ts: now(), uid: (user && user.uid) || null, email: (user && user.email) || null, kind, action: clean(action, 40), ip: ipOf(req) }); } catch { /* best effort */ }
  }

  // ---------------- views
  const evTs = e => Number(e.blockTime) || Number(e.recordedAt) || 0;
  const tradesOf = ev => ev.filter(e => e.type === 'trade');
  const volume = a => a.reduce((s, e) => s + abs(big(e.solDelta)), 0n);

  async function overview() {
    const L = 2000;
    const [ev, us, rp, er, rl] = await Promise.all([
      rows('events', { limit: L, orderBy: 'recordedAt' }), rows('users', { limit: L, orderBy: 'lastSeen' }),
      rows('reports', { limit: 500, orderBy: 'createdAt' }), rows('errors', { limit: 500, orderBy: 'recordedAt' }),
      rows('rewardsLaunches', { limit: 500 })
    ]);
    const t = now(), day = t - 864e5, tr = tradesOf(ev), la = ev.filter(e => e.type === 'launch');
    const series = {};
    for (const e of tr) { const k = new Date(evTs(e)).toISOString().slice(0, 10); series[k] = (series[k] || 0n) + abs(big(e.solDelta)); }
    const days = Object.keys(series).sort().map(d => ({ day: d, lamports: series[d].toString() }));
    const feed = [
      ...ev.filter(e => e.type === 'trade' || e.type === 'launch').slice(0, 20).map(e => ({ ts: evTs(e), kind: e.type, subject: e.mint || null, ref: e.sig || null, side: e.side || null })),
      ...rp.slice(0, 20).map(r => ({ ts: r.createdAt, kind: 'report', subject: r.category, ref: r.id, status: r.status })),
      ...er.slice(0, 20).map(e => ({ ts: e.recordedAt, kind: 'tx_failed', subject: e.mint || null, ref: e.sig || null }))
    ].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 15);
    return ok({
      note: 'Computed from the most recent recorded records (caps shown). Volume = net SOL moved by trader wallets on on-chain-verified trades reported to /api/events; trades not reported there are not counted. Revenue = SOL received by the Saturn treasury in those same transactions.',
      capped: { events: ev.length >= L, users: us.length >= L },
      totalUsers: us.length, activeUsers24h: us.filter(u => Number(u.lastSeen) >= day).length,
      tokensLaunched: la.length, launches24h: la.filter(e => e.recordedAt >= day).length,
      trades: tr.length, trades24h: tr.filter(e => e.recordedAt >= day).length,
      volumeLamports: volume(tr).toString(), volume24hLamports: volume(tr.filter(e => e.recordedAt >= day)).toString(),
      platformRevenueLamports: tr.reduce((s, e) => s + big(e.treasuryLamportsDelta), 0n).toString(),
      failedTransactions: er.length,
      openReports: rp.filter(r => OPEN_STATUSES.includes(r.status)).length, totalReports: rp.length,
      pendingRewards: { available: false, reason: 'No verified reward ledger exists yet (payouts_disabled).' },
      registeredLaunchesAwaitingRewardSource: rl.length,
      volumeSeries: days, recent: feed
    });
  }

  async function usersSearch(b) {
    const q = clean(b.q, 128);
    if (q.length < 2) return bad(400, 'query_too_short');
    const found = new Map(), add = (u, id) => { if (u) found.set(id || u.uid, { uid: id || u.uid, email: u.email || null, name: u.name || null, provider: u.provider || null, wallets: u.wallets || [], lastSeen: u.lastSeen || null, createdAt: u.createdAt || null }); };
    if (UID_RE.test(q)) add(await one('users/' + q), q);
    for (const u of await where('users', 'email', q, 5)) add(u, u.id);
    const wl = MINT_RE.test(q) ? await one('walletLinks/' + q) : null;
    if (wl && wl.uid) add(await one('users/' + wl.uid), wl.uid);
    const un = await one('usernames/' + q.toLowerCase());
    if (un && un.uid) add(await one('users/' + un.uid), un.uid);
    if (!found.size) {
      const s = await col('users').where('email', '>=', q.toLowerCase()).where('email', '<', q.toLowerCase() + '\uf8ff').limit(10).get().catch(() => ({ docs: [] }));
      for (const d of s.docs) add(d.data(), d.id);
    }
    return ok({ users: [...found.values()].slice(0, 20) });
  }

  async function userGet(b) {
    const uid = clean(b.uid, 128);
    if (!UID_RE.test(uid)) return bad(400, 'invalid_uid');
    const u = await one('users/' + uid);
    if (!u) return bad(404, 'not_found');
    const wallets = u.wallets || [];
    const evs = (await where('events', 'uid', uid, 200)).sort((a, b) => evTs(b) - evTs(a));
    const reportsBy = await where('reports', 'uid', uid, 50);
    const reportsAbout = (await where('reports', 'targetUid', uid, 50));
    const prof = [];
    for (const w of wallets.slice(0, 10)) { const p = await one('profiles/' + w); if (p) prof.push({ wallet: p.wallet, username: p.username || null, displayName: p.displayName || null }); }
    const mod = await one('moderation/' + uid);
    const settings = await one('userSettings/' + uid);
    return ok({
      user: { uid, email: u.email || null, name: u.name || null, provider: u.provider || null, createdAt: u.createdAt || null, lastSeen: u.lastSeen || null, wallets },
      profiles: prof,
      profileVisibility: (settings && settings.profileVisibility) || 'public',
      tokensCreated: evs.filter(e => e.type === 'launch').slice(0, 50).map(e => ({ mint: e.mint, sig: e.sig, ts: evTs(e) })),
      activity: evs.slice(0, 50).map(e => ({ type: e.type, side: e.side || null, mint: e.mint || null, sig: e.sig || null, ts: evTs(e) })),
      reportsFiled: reportsBy.map(r => ({ id: r.id, category: r.category, status: r.status, createdAt: r.createdAt })),
      reportsAgainst: reportsAbout.map(r => ({ id: r.id, category: r.category, status: r.status, createdAt: r.createdAt })),
      moderation: mod ? { status: mod.status, restriction: mod.restriction || null, history: mod.history || [], enforced: false } : { status: 'none', history: [], enforced: false },
      moderationNote: 'Record-only: Saturn does not yet enforce restrictions in sign-in, posting or token creation.'
    });
  }

  async function tokensList(b) {
    const la = (await rows('events', { limit: 2000, orderBy: 'recordedAt' }));
    const byMint = new Map();
    for (const e of la) {
      if (!e.mint) continue;
      const m = byMint.get(e.mint) || { mint: e.mint, launch: null, trades: 0, buys: 0, sells: 0, volumeLamports: 0n };
      if (e.type === 'launch') m.launch = { creatorWallet: e.wallet, sig: e.sig, ts: evTs(e), kind: e.launchKind || null };
      if (e.type === 'trade') { m.trades++; if (e.side === 'buy') m.buys++; if (e.side === 'sell') m.sells++; m.volumeLamports += abs(big(e.solDelta)); }
      byMint.set(e.mint, m);
    }
    const q = clean(b.q, 64).toLowerCase();
    let list = [...byMint.values()].map(m => ({ ...m, volumeLamports: m.volumeLamports.toString() }));
    if (q) list = list.filter(m => m.mint.toLowerCase().includes(q) || (m.launch && m.launch.creatorWallet.toLowerCase().includes(q)));
    list.sort((a, b2) => ((b2.launch && b2.launch.ts) || 0) - ((a.launch && a.launch.ts) || 0));
    return ok({ tokens: list.slice(0, 100), note: 'Name, symbol and market data are not stored by the Saturn backend: "Not connected". Only mint, creator wallet and recorded trades are shown.' });
  }

  async function tokenGet(b) {
    const mint = clean(b.mint, 64);
    if (!MINT_RE.test(mint)) return bad(400, 'invalid_mint');
    const evs = (await where('events', 'mint', mint, 200)).sort((a, b2) => evTs(b2) - evTs(a));
    const reports = await where('reports', 'mint', mint, 50);
    const lr = await one('rewardsLaunches/' + mint);
    return ok({
      mint, launch: evs.find(e => e.type === 'launch') || null,
      trades: evs.filter(e => e.type === 'trade').slice(0, 50),
      reports: reports.map(r => ({ id: r.id, category: r.category, status: r.status, createdAt: r.createdAt })),
      rewards: lr ? { status: lr.status, feeShareAuthorized: !!lr.feeShareAuthorized } : null,
      riskFlags: reports.filter(r => OPEN_STATUSES.includes(r.status)).length ? ['open_reports'] : [],
      market: { available: false, reason: 'Not connected' }, communityMessages: { available: false, reason: 'Use Community with the token room id.' }
    });
  }

  async function tradesList(b) {
    const ev = await rows('events', { limit: 1000, orderBy: 'recordedAt' });
    const er = await rows('errors', { limit: 200, orderBy: 'recordedAt' });
    const side = ['buy', 'sell'].includes(b.side) ? b.side : null;
    const confirmed = tradesOf(ev).filter(e => !side || e.side === side).slice(0, 100).map(e => ({ sig: e.sig, wallet: e.wallet, mint: e.mint, side: e.side, solLamports: abs(big(e.solDelta)).toString(), status: 'confirmed', feeVerified: !!e.feeVerified, treasuryLamports: big(e.treasuryLamportsDelta).toString(), ts: evTs(e) }));
    const failed = side ? [] : er.filter(e => e.type === 'tx_failed').slice(0, 50).map(e => ({ sig: e.sig, wallet: e.wallet, mint: e.mint, status: 'failed', error: e.error, ts: e.recordedAt }));
    return ok({ trades: [...confirmed, ...failed].sort((a, c) => (c.ts || 0) - (a.ts || 0)), note: 'Only trades reported to /api/events and verified against Solana RPC. Failed transaction simulations are not stored (Not connected).' });
  }

  async function rewardsSummary() {
    const rl = await rows('rewardsLaunches', { limit: 200 });
    return ok({
      payoutsEnabled: false,
      creatorRewards: { registered: rl.map(r => ({ mint: r.mint, wallet: r.wallet, status: r.status, feeShareAuthorized: !!r.feeShareAuthorized, creatorShareBps: r.creatorShareBps, saturnShareBps: r.saturnShareBps, createdAt: r.createdAt })), note: 'Proposed split only; not authorised or configured on Pump.fun.' },
      traderCashback: { available: false, reason: 'Not connected' }, solRecovery: { available: false, reason: 'Not connected' },
      claims: { available: false, reason: 'No claim ledger exists; claims return payouts_disabled.' },
      saturnFees: { note: 'See Overview: treasury SOL received in verified trades.' },
      externalProvider: { available: false, reason: 'Not connected' }
    });
  }

  // ---------------- reports
  const reportView = r => ({
    id: r.id, uid: r.uid || null, category: r.category, message: r.message, contact: r.contact || null, wallet: r.wallet || null,
    targetType: r.targetType || null, targetUid: r.targetUid || null, mint: r.mint || null, signature: r.signature || null, room: r.room || null, messageId: r.messageId || null,
    evidence: Array.isArray(r.evidence) ? r.evidence : [], createdAt: r.createdAt, status: r.status || 'new',
    notes: r.notes || [], history: r.history || []
  });
  async function reportsList(b) {
    let list = await rows('reports', { limit: 500, orderBy: 'createdAt' });
    const counts = { all: list.length }; for (const s of REPORT_STATUSES) counts[s] = list.filter(r => (r.status || 'new') === s).length;
    if (REPORT_STATUSES.includes(b.status)) list = list.filter(r => (r.status || 'new') === b.status);
    return ok({ counts, reports: list.slice(0, 100).map(r => { const v = reportView(r); return { ...v, message: v.message.slice(0, 160), evidence: v.evidence.length, notes: v.notes.length, history: v.history.length }; }) });
  }
  async function reportGet(b) {
    const id = clean(b.id, 64); if (!ID_RE.test(id)) return bad(400, 'invalid_id');
    const r = await one('reports/' + id); if (!r) return bad(404, 'not_found');
    return ok({ report: reportView({ id, ...r }) });
  }
  async function reportUpdate(b, actor, role) {
    const id = clean(b.id, 64); if (!ID_RE.test(id)) return bad(400, 'invalid_id');
    const status = b.status === undefined ? undefined : b.status;
    if (status !== undefined && !REPORT_STATUSES.includes(status)) return bad(400, 'invalid_status');
    const note = clean(b.note, 1000), reason = clean(b.reason, 500);
    if (status === undefined && !note) return bad(400, 'nothing_to_update');
    if ((status === 'resolved' || status === 'rejected') && reason.length < 3) return bad(400, 'reason_required');
    const t = now(); let result = null;
    await db.runTransaction(async tx => {
      const ref = db.doc('reports/' + id), snap = await tx.get(ref);
      if (!snap.exists) { result = bad(404, 'not_found'); return; }
      const r = snap.data(), history = (r.history || []).slice(-199), notes = (r.notes || []).slice(-99);
      if (note) notes.push({ ts: t, by: actor.uid, text: note });
      if (status !== undefined) history.push({ ts: t, by: actor.uid, role, from: r.status || 'new', to: status, reason: reason || null });
      auditTx(tx, actor, role, 'report-update', 'report:' + id, { status: status || null, hasNote: !!note, reason: reason || null });
      tx.set(ref, { ...r, status: status !== undefined ? status : (r.status || 'new'), notes, history, updatedAt: t });
    });
    if (result) return result;
    return ok({ id, status: status || undefined });
  }

  // ---------------- moderation (RECORD-ONLY)
  async function moderate(b, actor, role) {
    const uid = clean(b.uid, 128); if (!UID_RE.test(uid)) return bad(400, 'invalid_uid');
    if (!MOD_TYPES.includes(b.type)) return bad(400, 'invalid_type');
    const reason = clean(b.reason, 500); if (reason.length < 5) return bad(400, 'reason_required');
    if (uid === actor.uid || isOwner({ uid })) return bad(403, 'cannot_moderate_owner_or_self');
    const reportId = clean(b.reportId, 64), t = now(); let result = null, status = null;
    await db.runTransaction(async tx => {
      const [u, adm, m] = [await tx.get(db.doc('users/' + uid)), await tx.get(db.doc('adminRoles/' + uid)), await tx.get(db.doc('moderation/' + uid))];
      if (!u.exists) { result = bad(404, 'not_found'); return; }
      if (adm.exists) { result = bad(403, 'cannot_moderate_admin'); return; }
      const cur = m.exists ? m.data() : { history: [] };
      const entry = { ts: t, by: actor.uid, type: b.type, reason, reportId: ID_RE.test(reportId) ? reportId : null };
      status = b.type === 'restrict' ? 'restricted' : (cur.status === 'restricted' ? 'restricted' : 'warned');
      auditTx(tx, actor, role, 'moderate-user', 'user:' + uid, { type: b.type, reason, reportId: entry.reportId });
      tx.set(db.doc('moderation/' + uid), { uid, status, restriction: b.type === 'restrict' ? { since: t, by: actor.uid, reason } : (cur.restriction || null), enforced: false, history: [...(cur.history || []).slice(-99), entry], updatedAt: t });
    });
    if (result) return result;
    return ok({ uid, status, enforced: false, note: 'Recorded only. Saturn does not yet enforce restrictions.' });
  }
  async function lift(b, actor, role) {
    const uid = clean(b.uid, 128); if (!UID_RE.test(uid)) return bad(400, 'invalid_uid');
    const reason = clean(b.reason, 500); if (reason.length < 5) return bad(400, 'reason_required');
    const t = now(); let result = null;
    await db.runTransaction(async tx => {
      const m = await tx.get(db.doc('moderation/' + uid));
      if (!m.exists) { result = bad(404, 'not_found'); return; }
      const cur = m.data();
      auditTx(tx, actor, role, 'moderation-lift', 'user:' + uid, { reason });
      tx.set(db.doc('moderation/' + uid), { ...cur, status: 'none', restriction: null, history: [...(cur.history || []).slice(-99), { ts: t, by: actor.uid, type: 'lift', reason }], updatedAt: t });
    });
    if (result) return result;
    return ok({ uid, status: 'none' });
  }

  async function communityMessages(b) {
    const room = clean(b.room, 64); if (!ROOM_RE.test(room)) return bad(400, 'invalid_room');
    const s = await db.collection('communityRooms').doc(room).collection('messages').orderBy('t', 'desc').limit(50).get();
    const reported = new Set((await rows('reports', { limit: 500, orderBy: 'createdAt' })).filter(r => r.room === room && r.messageId).map(r => r.messageId));
    const messages = s.docs.map(d => { const m = d.data(); return { id: d.id, uid: m.uid || null, by: m.by || null, wallet: m.wallet || null, text: m.text || '', hasImage: !!m.img, img: m.img || null, ts: m.t || null, reported: reported.has(d.id), spamHint: /(https?:\/\/\S+){2,}/i.test(m.text || '') } ; });
    return ok({ room, messages, note: 'Read-only. Hiding or deleting messages is not available from the dashboard (Not connected).' });
  }

  async function health() {
    const t0 = now(); const out = {};
    const run = async (k, fn) => { const s = Date.now(); try { const r = await fn(); out[k] = { status: 'ok', ms: Date.now() - s, ...(r || {}) }; } catch (e) { out[k] = { status: 'down', ms: Date.now() - s, error: String((e && e.message) || e).slice(0, 120) }; } };
    out.vercelBackend = { status: 'ok', note: 'This request was served by the backend.', deployment: { commit: env.VERCEL_GIT_COMMIT_SHA ? String(env.VERCEL_GIT_COMMIT_SHA).slice(0, 7) : null, branch: env.VERCEL_GIT_COMMIT_REF || null, env: env.VERCEL_ENV || null, region: env.VERCEL_REGION || null } };
    await run('firestore', async () => { await db.doc('adminRoles/_health').get(); });
    out.solanaRpc = probes.rpc ? null : { status: 'not_connected' };
    if (probes.rpc) await run('solanaRpc', () => probes.rpc());
    out.renderWebSocket = probes.ws ? null : { status: 'not_connected', note: 'Set RENDER_HEALTH_URL to enable.' };
    if (probes.ws) await run('renderWebSocket', () => probes.ws());
    const er = await rows('errors', { limit: 200, orderBy: 'recordedAt' });
    const sec = await rows('adminSecurity', { limit: 200, orderBy: 'ts' });
    return ok({ checkedAt: t0, services: out, failedTransactions24h: er.filter(e => e.recordedAt >= t0 - 864e5).length, authFailures24h: sec.filter(e => e.ts >= t0 - 864e5).length, notTracked: ['API failure log', 'Upload errors', 'Failed transaction simulations'] });
  }

  async function auditList() { return ok({ entries: await rows('adminAudit', { limit: 200, orderBy: 'ts' }) }); }
  async function loginsList() { return ok({ logins: await rows('adminLogins', { limit: 100, orderBy: 'ts' }) }); }
  async function alerts() { return ok({ alerts: (await rows('adminSecurity', { limit: 100, orderBy: 'ts' })).map(a => ({ ...a, ip: a.ip ? sha(a.ip).slice(0, 8) : null })) }); }
  async function rolesList() {
    const list = await rows('adminRoles', { limit: 200 });
    return ok({ owners: 'Configured by OWNER_UIDS (not editable here)', roles: list.map(r => ({ uid: r.id, role: r.role, email: r.email || null, disabled: !!r.disabled, addedAt: r.addedAt || null })), assignable: ASSIGNABLE_ROLES, permissions: ROLES });
  }
  async function roleSet(b, actor, role) {
    const uid = clean(b.uid, 128); if (!UID_RE.test(uid)) return bad(400, 'invalid_uid');
    if (!ASSIGNABLE_ROLES.includes(b.role)) return bad(400, 'invalid_role');
    if (isOwner({ uid })) return bad(403, 'owner_is_not_editable');
    if (uid === actor.uid) return bad(403, 'cannot_edit_self');
    let result = null;
    await db.runTransaction(async tx => {
      const u = await tx.get(db.doc('users/' + uid)), prevS = await tx.get(db.doc('adminRoles/' + uid));
      if (!u.exists) { result = bad(404, 'user_not_found'); return; }
      const prev = prevS.exists ? prevS.data() : null;
      auditTx(tx, actor, role, 'role-set', 'user:' + uid, { role: b.role, previous: prev ? prev.role : null });
      tx.set(db.doc('adminRoles/' + uid), { role: b.role, email: clean(b.email, 120) || null, disabled: false, addedBy: actor.uid, addedAt: (prev && prev.addedAt) || now(), updatedAt: now() });
    });
    return result || ok({ uid, role: b.role });
  }
  async function roleRemove(b, actor, role) {
    const uid = clean(b.uid, 128); if (!UID_RE.test(uid)) return bad(400, 'invalid_uid');
    let result = null;
    await db.runTransaction(async tx => {
      const r = await tx.get(db.doc('adminRoles/' + uid));
      if (!r.exists) { result = bad(404, 'not_found'); return; }
      auditTx(tx, actor, role, 'role-remove', 'user:' + uid, null);
      tx.delete(db.doc('adminRoles/' + uid));
    });
    return result || ok({ uid });
  }
  async function settingsGet() {
    const has = k => !!env[k];
    return ok({
      readOnly: true,
      features: [
        { name: 'Owner authentication (OWNER_UIDS)', status: has('OWNER_UIDS') ? 'configured' : 'not_configured' },
        { name: 'Firestore', status: has('FIREBASE_SERVICE_ACCOUNT_JSON') ? 'configured' : 'not_configured' },
        { name: 'Solana RPC (server)', status: has('SOLANA_RPC_URL') ? 'configured' : 'not_configured' },
        { name: 'Privy token verification', status: has('PRIVY_APP_ID') && has('PRIVY_VERIFICATION_KEY') ? 'configured' : 'not_configured' },
        { name: 'Treasury wallet (public)', status: has('PLATFORM_TREASURY_WALLET') ? 'configured' : 'not_configured' },
        { name: 'Render WebSocket health probe', status: has('RENDER_HEALTH_URL') ? 'configured' : 'not_configured' },
        { name: 'Reward payouts', status: 'disabled' }, { name: 'Moderation enforcement', status: 'not_connected' }, { name: 'Maintenance mode', status: 'not_connected' }
      ],
      roles: ROLES
    });
  }

  // ---------------- entry point
  async function handle(req, user, b, { limited = () => false } = {}) {
    const action = b && typeof b.action === 'string' ? b.action : '';
    const def = ACTIONS[action];
    if (!def) return bad(400, 'unknown_action');
    if (!user) return bad(401, 'sign_in_required');
    const role = await resolveRole(user);
    if (!role) {
      if (!limited(req, 'admin-denied', 10)) await alert(req, user, 'unauthorized_admin_access', action);
      return bad(403, 'not_admin', action === 'whoami' ? { uid: user.uid } : {});
    }
    if (!fresh(user)) return bad(401, 'session_expired', { hint: 'Sign in again.' });
    const [perm, mutation] = def;
    if (perm && !ROLES[role].includes(perm)) {
      await audit(user, role, action, null, { denied: 'permission' }, false).catch(() => {});
      await alert(req, user, 'permission_denied', action);
      return bad(403, 'forbidden');
    }
    if (mutation && limited(req, 'admin-write', 30)) return bad(429, 'too_many_requests');
    try {
      switch (action) {
        case 'whoami': {
          const id = now() + '_' + crypto.randomBytes(6).toString('hex');
          if (!limited(req, 'admin-login-log', 6)) await col('adminLogins').doc(id).create({ ts: now(), uid: user.uid, email: user.email || null, role, ip: sha(ipOf(req)).slice(0, 8) });
          return ok({ uid: user.uid, email: user.email || null, name: user.name || null, role, permissions: ROLES[role] });
        }
        case 'overview': return await overview();
        case 'users-search': return await usersSearch(b);
        case 'user-get': return await userGet(b);
        case 'tokens-list': return await tokensList(b);
        case 'token-get': return await tokenGet(b);
        case 'trades-list': return await tradesList(b);
        case 'rewards-summary': return await rewardsSummary();
        case 'reports-list': return await reportsList(b);
        case 'report-get': return await reportGet(b);
        case 'report-update': return await reportUpdate(b, user, role);
        case 'moderate-user': return await moderate(b, user, role);
        case 'moderation-lift': return await lift(b, user, role);
        case 'community-messages': return await communityMessages(b);
        case 'system-health': return await health();
        case 'audit-list': return await auditList();
        case 'logins-list': return await loginsList();
        case 'security-alerts': return await alerts();
        case 'roles-list': return await rolesList();
        case 'role-set': return await roleSet(b, user, role);
        case 'role-remove': return await roleRemove(b, user, role);
        case 'settings-get': return await settingsGet();
        default: return bad(400, 'unknown_action');
      }
    } catch (e) {
      console.error('[admin]', action, e && e.message);
      return bad(500, 'server_error');
    }
  }
  return { handle, resolveRole };
}
