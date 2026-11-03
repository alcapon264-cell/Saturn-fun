// Admin dashboard backend tests (Firestore-SHAPED fake; does not prove real-Firestore behaviour).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../lib/app.js';
import { makeStore } from '../lib/deps.js';
import { fakeFirestore } from './fake-firestore.js';

const NOW = 1_700_000_000_000, ORIGIN = 'https://saturn-admin.netlify.app', FRESH = NOW / 1000 - 60, STALE = NOW / 1000 - 13 * 3600;
const MINT = 'So11111111111111111111111111111111111111112', WALLET = '11111111111111111111111111111111', SIG = '1'.repeat(64);
const TOK = {
  owner: { uid: 'OWNER1', email: 'o@x.test', auth_time: FRESH }, ownerOld: { uid: 'OWNER1', email: 'o@x.test', auth_time: STALE },
  mod: { uid: 'MOD1', email: 'm@x.test', auth_time: FRESH }, fin: { uid: 'FIN1', auth_time: FRESH }, sup: { uid: 'SUP1', auth_time: FRESH },
  user: { uid: 'USER1', email: 'u@x.test', auth_time: FRESH }, user2: { uid: 'USER2', auth_time: FRESH }
};
let ip = 0;
function setup() {
  const fs = fakeFirestore(), store = makeStore(fs); let clock = NOW;
  // Test seam: when flags.failAudit is set, any transaction that tries to create an adminAudit record throws before commit
  // (same effect as a failing audit write in real Firestore: the whole transaction aborts).
  const flags = { failAudit: false };
  const db = { ...fs, runTransaction: fn => fs.runTransaction(t => fn(!flags.failAudit ? t : { get: r => t.get(r), set: (r, d) => t.set(r, d), delete: r => t.delete(r), create: (r, d) => { if (r.path.startsWith('adminAudit/')) throw new Error('audit write failed'); return t.create(r, d); } })) };
  const app = createApp({ auth: { async verifyIdToken(t) { if (!TOK[t]) throw new Error('bad'); return { ...TOK[t] }; } }, store, rpc: {}, db, now: () => clock, env: { SATURN_ALLOWED_ORIGINS: ORIGIN + ',https://site.test', OWNER_UIDS: 'OWNER1' } });
  const call = async (h, token, body = {}, { origin = ORIGIN, fixedIp } = {}) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
    await h({ method: 'POST', url: '/x', headers: { origin, 'x-forwarded-for': fixedIp || '7.7.' + (++ip >> 8) + '.' + (ip & 255), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body, query: {} }, res); return res;
  };
  const adm = (token, body, o) => call(app.admin, token, body, o);
  fs.docs.set('adminRoles/MOD1', { role: 'moderator', addedAt: 1 }); fs.docs.set('adminRoles/FIN1', { role: 'finance' }); fs.docs.set('adminRoles/SUP1', { role: 'support' });
  for (const u of ['OWNER1', 'MOD1', 'USER1', 'USER2', 'FIN1', 'SUP1']) fs.docs.set('users/' + u, { uid: u, email: u.toLowerCase() + '@x.test', wallets: u === 'USER1' ? [WALLET] : [], lastSeen: NOW - 1000, createdAt: 1 });
  fs.docs.set('walletLinks/' + WALLET, { uid: 'USER1' });
  fs.docs.set('events/' + SIG, { type: 'launch', sig: SIG, wallet: WALLET, mint: MINT, uid: 'USER1', recordedAt: NOW - 5000, blockTime: NOW - 6000, launchKind: 'SATURN_NATIVE' });
  fs.docs.set('events/t1', { type: 'trade', sig: 't1', wallet: WALLET, mint: MINT, side: 'buy', solDelta: '-1000000000', treasuryLamportsDelta: '10000000', feeVerified: true, uid: 'USER1', recordedAt: NOW - 4000 });
  fs.docs.set('errors/e1', { type: 'tx_failed', sig: 'e1', wallet: WALLET, mint: MINT, error: '{"x":1}', recordedAt: NOW - 3000 });
  fs.docs.set('reports/rep000', { uid: 'USER2', category: 'bug', message: 'Old problem report', createdAt: NOW - 9000, status: 'new' });
  return { app, fs, flags, call, adm, tick: ms => { clock += ms; } };
}
const ACTS = ['overview', 'users-search', 'user-get', 'tokens-list', 'token-get', 'trades-list', 'rewards-summary', 'reports-list', 'report-get', 'report-update', 'moderate-user', 'moderation-lift', 'community-messages', 'system-health', 'audit-list', 'logins-list', 'security-alerts', 'roles-list', 'role-set', 'role-remove', 'settings-get'];

// ---------------------------------------------------------------- authentication
test('admin: missing token, forged token and wrong origin are refused', async () => {
  const s = setup();
  assert.equal((await s.adm(null, { action: 'overview' })).statusCode, 401);
  assert.equal((await s.adm('forged', { action: 'overview' })).statusCode, 401);
  assert.equal((await s.adm('owner', { action: 'overview' }, { origin: 'https://evil.test' })).statusCode, 403);
});
test('admin: ordinary users are rejected on EVERY action and an alert is recorded', async () => {
  const s = setup();
  for (const a of ['whoami', ...ACTS]) {
    const r = await s.adm('user', { action: a, uid: 'USER2', id: 'rep000', q: 'abc', mint: MINT, room: 'x' });
    assert.equal(r.statusCode, 403, a); assert.equal(r.body.error, 'not_admin', a);
  }
  assert.ok([...s.fs.docs.keys()].some(k => k.startsWith('adminSecurity/')));
  assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('adminAudit/')).length, 0);
});
test('admin: unknown action is rejected; non-admin whoami returns only their own uid', async () => {
  const s = setup();
  assert.equal((await s.adm('owner', { action: 'nope' })).statusCode, 400);
  const r = await s.adm('user', { action: 'whoami' });
  assert.equal(r.statusCode, 403); assert.equal(r.body.uid, 'USER1');
});
test('admin: owner whoami works, login is recorded; stale login (>12h) is refused', async () => {
  const s = setup();
  const r = await s.adm('owner', { action: 'whoami' });
  assert.equal(r.statusCode, 200); assert.equal(r.body.role, 'owner'); assert.ok(r.body.permissions.includes('roles.manage'));
  assert.ok([...s.fs.docs.keys()].some(k => k.startsWith('adminLogins/')));
  const old = await s.adm('ownerOld', { action: 'overview' });
  assert.equal(old.statusCode, 401); assert.equal(old.body.error, 'session_expired');
});
test('admin: empty OWNER_UIDS means nobody is owner (fail closed)', async () => {
  const fs = fakeFirestore(), store = makeStore(fs);
  const app = createApp({ auth: { async verifyIdToken() { return { uid: 'OWNER1', auth_time: FRESH }; } }, store, rpc: {}, db: fs, now: () => NOW, env: { SATURN_ALLOWED_ORIGINS: ORIGIN } });
  const res = { headers: {}, setHeader() {}, end(b) { this.body = JSON.parse(b); } };
  await app.admin({ method: 'POST', url: '/x', headers: { origin: ORIGIN, authorization: 'Bearer t', 'x-forwarded-for': '1.2.3.4' }, body: { action: 'overview' } }, res);
  assert.equal(res.statusCode, 403);
});
test('admin: a disabled role is refused; a Privy-style uid is never an admin', async () => {
  const s = setup(); s.fs.docs.set('adminRoles/MOD1', { role: 'moderator', disabled: true });
  assert.equal((await s.adm('mod', { action: 'overview' })).statusCode, 403);
  s.fs.docs.set('adminRoles/did:privy:abc', { role: 'moderator' });
  const app2 = createApp({ auth: { async verifyIdToken() { return { uid: 'did:privy:abc', auth_time: FRESH }; } }, store: makeStore(s.fs), rpc: {}, db: s.fs, now: () => NOW, env: { SATURN_ALLOWED_ORIGINS: ORIGIN } });
  const res = { headers: {}, setHeader() {}, end(b) { this.body = JSON.parse(b); } };
  await app2.admin({ method: 'POST', url: '/x', headers: { origin: ORIGIN, authorization: 'Bearer t', 'x-forwarded-for': '1.2.3.5' }, body: { action: 'overview' } }, res);
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------- roles & permissions
test('admin: role permission matrix is enforced server-side', async () => {
  const s = setup();
  const code = async (t, a, extra = {}) => (await s.adm(t, { action: a, ...extra })).statusCode;
  assert.equal(await code('mod', 'reports-list'), 200);
  assert.equal(await code('mod', 'trades-list'), 403);
  assert.equal(await code('mod', 'rewards-summary'), 403);
  assert.equal(await code('mod', 'audit-list'), 403);
  assert.equal(await code('mod', 'roles-list'), 403);
  assert.equal(await code('mod', 'role-set', { uid: 'USER1', role: 'moderator' }), 403);
  assert.equal(await code('fin', 'trades-list'), 200);
  assert.equal(await code('fin', 'rewards-summary'), 200);
  assert.equal(await code('fin', 'reports-list'), 403);
  assert.equal(await code('fin', 'users-search', { q: 'user' }), 403);
  assert.equal(await code('sup', 'reports-list'), 200);
  assert.equal(await code('sup', 'report-update', { id: 'rep000', status: 'review' }), 403);
  assert.equal(await code('sup', 'moderate-user', { uid: 'USER1', type: 'warn', reason: 'testing' }), 403);
  assert.equal(await code('owner', 'audit-list'), 200);
});
test('admin: owner can assign/remove roles; cannot assign owner, edit self, or unknown role; every change audited', async () => {
  const s = setup();
  assert.equal((await s.adm('owner', { action: 'role-set', uid: 'USER2', role: 'moderator', email: 'a@b.c' })).statusCode, 200);
  assert.equal(s.fs.docs.get('adminRoles/USER2').role, 'moderator');
  assert.equal((await s.adm('owner', { action: 'role-set', uid: 'USER2', role: 'owner' })).statusCode, 400);
  assert.equal((await s.adm('owner', { action: 'role-set', uid: 'OWNER1', role: 'moderator' })).statusCode, 403);
  assert.equal((await s.adm('owner', { action: 'role-set', uid: 'NOBODY1', role: 'moderator' })).statusCode, 404);
  assert.equal((await s.adm('owner', { action: 'role-remove', uid: 'USER2' })).statusCode, 200);
  assert.equal(s.fs.docs.has('adminRoles/USER2'), false);
  const acts = [...s.fs.docs].filter(([k]) => k.startsWith('adminAudit/')).map(([, v]) => v.action);
  assert.deepEqual(acts, ['role-set', 'role-remove']);
});

// ---------------------------------------------------------------- data views
test('admin: overview uses real records only and labels unavailable data', async () => {
  const s = setup(); const r = (await s.adm('owner', { action: 'overview' })).body;
  assert.equal(r.tokensLaunched, 1); assert.equal(r.trades, 1); assert.equal(r.volumeLamports, '1000000000'); assert.equal(r.platformRevenueLamports, '10000000');
  assert.equal(r.failedTransactions, 1); assert.equal(r.openReports, 1); assert.equal(r.totalUsers, 6); assert.equal(r.pendingRewards.available, false);
  assert.equal(r.volumeSeries.length, 1);
});
test('admin: user search by uid, email, wallet; user detail', async () => {
  const s = setup();
  for (const q of ['USER1', 'user1@x.test', WALLET]) { const r = await s.adm('mod', { action: 'users-search', q }); assert.equal(r.body.users[0].uid, 'USER1', q); }
  assert.equal((await s.adm('mod', { action: 'users-search', q: 'a' })).statusCode, 400);
  const u = (await s.adm('mod', { action: 'user-get', uid: 'USER1' })).body;
  assert.equal(u.tokensCreated[0].mint, MINT); assert.equal(u.moderation.enforced, false);
  assert.equal((await s.adm('mod', { action: 'user-get', uid: 'ZZZZZ' })).statusCode, 404);
  assert.equal((await s.adm('mod', { action: 'user-get', uid: '../x' })).statusCode, 400);
});
test('admin: token list/detail, trades (incl. failed)', async () => {
  const s = setup();
  const l = (await s.adm('mod', { action: 'tokens-list' })).body.tokens; assert.equal(l[0].mint, MINT); assert.equal(l[0].trades, 1);
  assert.equal((await s.adm('mod', { action: 'tokens-list', q: WALLET })).body.tokens.length, 1);
  assert.equal((await s.adm('mod', { action: 'token-get', mint: MINT })).body.market.available, false);
  assert.equal((await s.adm('mod', { action: 'token-get', mint: 'bad' })).statusCode, 400);
  const t = (await s.adm('fin', { action: 'trades-list' })).body.trades; assert.deepEqual(t.map(x => x.status).sort(), ['confirmed', 'failed']);
});
test('admin: rewards are labelled not connected', async () => {
  const s = setup(); const r = (await s.adm('fin', { action: 'rewards-summary' })).body;
  assert.equal(r.payoutsEnabled, false); assert.equal(r.traderCashback.reason, 'Not connected');
});
test('admin: system health reports Firestore ok and unconfigured services honestly', async () => {
  const s = setup(); const r = (await s.adm('owner', { action: 'system-health' })).body.services;
  assert.equal(r.firestore.status, 'ok'); assert.equal(r.vercelBackend.status, 'ok'); assert.equal(r.renderWebSocket.status, 'not_connected');
});
test('admin: settings view exposes configuration status only, never values', async () => {
  const s = setup(); const txt = JSON.stringify((await s.adm('owner', { action: 'settings-get' })).body);
  assert.ok(txt.includes('OWNER_UIDS')); assert.ok(!txt.includes('OWNER1'));
});

// ---------------------------------------------------------------- reports
test('reports: user submits a targeted report with evidence -> appears in admin list/detail', async () => {
  const s = setup(); const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const r = await s.call(s.app.reportSubmit, 'user2', { targetType: 'token', category: 'scam', message: 'Token copies another project and misled buyers', mint: MINT, signature: SIG, evidence: [img] });
  assert.equal(r.statusCode, 200); const id = r.body.id;
  const list = (await s.adm('mod', { action: 'reports-list', status: 'new' })).body;
  assert.ok(list.reports.some(x => x.id === id)); assert.equal(list.counts.new, 2);
  const d = (await s.adm('mod', { action: 'report-get', id })).body.report;
  assert.equal(d.mint, MINT); assert.equal(d.signature, SIG); assert.equal(d.evidence.length, 1); assert.equal(d.status, 'new'); assert.equal(d.uid, 'USER2');
});
test('reports: validation, self-report, rate limit and auth', async () => {
  const s = setup(); const base = { targetType: 'user', category: 'abuse', message: 'This account is harassing people', targetWallet: WALLET };
  assert.equal((await s.call(s.app.reportSubmit, null, base)).statusCode, 401);
  assert.equal((await s.call(s.app.reportSubmit, 'user2', { ...base, category: 'nope' })).statusCode, 400);
  assert.equal((await s.call(s.app.reportSubmit, 'user2', { ...base, message: 'short' })).statusCode, 400);
  assert.equal((await s.call(s.app.reportSubmit, 'user2', { ...base, evidence: ['data:image/png;base64,AAAA'] })).statusCode, 400);
  assert.equal((await s.call(s.app.reportSubmit, 'user2', { ...base, evidence: [1, 2, 3, 4].map(() => 'data:image/jpeg;base64,AAAA') })).statusCode, 400);
  assert.equal((await s.call(s.app.reportSubmit, 'user', base)).statusCode, 400, 'self report');
  assert.equal((await s.call(s.app.reportSubmit, 'user2', { targetType: 'message', category: 'spam', message: 'Spam message in the room', room: 'r1' })).statusCode, 400);
  assert.equal((await s.call(s.app.reportSubmit, 'user2', base)).statusCode, 200);
  assert.equal((await s.call(s.app.reportSubmit, 'user2', base)).statusCode, 429);
  const stored = [...s.fs.docs].find(([k, v]) => k.startsWith('reports/') && v.targetType === 'user')[1]; assert.equal(stored.targetUid, 'USER1');
});
test('reports: status workflow, notes, reason required, history, audit log', async () => {
  const s = setup();
  assert.equal((await s.adm('mod', { action: 'report-update', id: 'rep000', status: 'review', note: 'Looking into it' })).statusCode, 200);
  assert.equal((await s.adm('mod', { action: 'report-update', id: 'rep000', status: 'resolved' })).body.error, 'reason_required');
  assert.equal((await s.adm('mod', { action: 'report-update', id: 'rep000', status: 'bogus' })).statusCode, 400);
  assert.equal((await s.adm('mod', { action: 'report-update', id: 'zzzzzzzz', status: 'review' })).statusCode, 404);
  assert.equal((await s.adm('mod', { action: 'report-update', id: 'rep000' })).statusCode, 400);
  assert.equal((await s.adm('mod', { action: 'report-update', id: 'rep000', status: 'resolved', reason: 'Fixed in release' })).statusCode, 200);
  const d = (await s.adm('mod', { action: 'report-get', id: 'rep000' })).body.report;
  assert.equal(d.status, 'resolved'); assert.equal(d.notes.length, 1); assert.deepEqual(d.history.map(h => h.to), ['review', 'resolved']);
  const audit = [...s.fs.docs].filter(([k]) => k.startsWith('adminAudit/')).map(([, v]) => v);
  assert.equal(audit.length, 2); assert.ok(audit.every(a => a.actor === 'MOD1' && a.action === 'report-update' && a.ok));
});

// ---------------------------------------------------------------- record-only moderation
test('moderation: warn/restrict/lift are record-only, validated and audited', async () => {
  const s = setup();
  assert.equal((await s.adm('mod', { action: 'moderate-user', uid: 'USER1', type: 'warn', reason: 'Spam posts' })).body.status, 'warned');
  const r = await s.adm('mod', { action: 'moderate-user', uid: 'USER1', type: 'restrict', reason: 'Repeated scam launches', reportId: 'rep000' });
  assert.equal(r.body.status, 'restricted'); assert.equal(r.body.enforced, false);
  assert.equal((await s.adm('mod', { action: 'moderate-user', uid: 'USER1', type: 'ban', reason: 'xxxxxxx' })).statusCode, 400);
  assert.equal((await s.adm('mod', { action: 'moderate-user', uid: 'USER1', type: 'warn', reason: 'x' })).body.error, 'reason_required');
  assert.equal((await s.adm('mod', { action: 'moderate-user', uid: 'OWNER1', type: 'warn', reason: 'testing now' })).statusCode, 403);
  assert.equal((await s.adm('mod', { action: 'moderate-user', uid: 'FIN1', type: 'warn', reason: 'testing now' })).statusCode, 403);
  assert.equal((await s.adm('mod', { action: 'moderate-user', uid: 'GHOST1', type: 'warn', reason: 'testing now' })).statusCode, 404);
  const u = (await s.adm('mod', { action: 'user-get', uid: 'USER1' })).body.moderation; assert.equal(u.history.length, 2); assert.equal(u.enforced, false);
  assert.equal((await s.adm('mod', { action: 'moderation-lift', uid: 'USER1', reason: 'Appeal accepted' })).body.status, 'none');
  assert.equal(s.fs.docs.get('moderation/USER1').restriction, null);
  assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('adminAudit/')).length, 3);
  assert.equal(s.fs.docs.get('users/USER1').restricted, undefined, 'no user record is altered');
});

// ---------------------------------------------------------------- audit, logins, security
test('admin: audit log, logins and security alerts are readable by owner only', async () => {
  const s = setup();
  await s.adm('owner', { action: 'whoami' }); await s.adm('user', { action: 'overview' }); await s.adm('mod', { action: 'report-update', id: 'rep000', status: 'review' });
  assert.equal((await s.adm('owner', { action: 'audit-list' })).body.entries.length, 1);
  assert.equal((await s.adm('owner', { action: 'logins-list' })).body.logins.length, 1);
  const al = (await s.adm('owner', { action: 'security-alerts' })).body.alerts; assert.equal(al[0].kind, 'unauthorized_admin_access');
  assert.equal((await s.adm('mod', { action: 'security-alerts' })).statusCode, 403);
  assert.ok(s.fs.docs.get([...s.fs.docs.keys()].find(k => k.startsWith('adminAudit/'))).ts);
});
test('admin: sensitive mutation rate limit', async () => {
  const s = setup(); let last = 0; const ipx = '8.8.8.8';
  for (let i = 0; i < 32; i++) last = (await s.call(s.app.admin, 'mod', { action: 'report-update', id: 'rep000', note: 'n' + i }, { fixedIp: ipx })).statusCode;
  assert.equal(last, 429);
});

// ---------------------------------------------------------------- non-interference
test('admin: existing public routes are unchanged (router exposes admin + report, keeps owner)', async () => {
  const { default: h } = await import('../api/[route].js').catch(() => ({}));
  const src = (await import('node:fs')).readFileSync(new URL('../api/[route].js', import.meta.url), 'utf8');
  for (const r of ['account', 'events', 'owner', 'rewards', 'settings', 'community-post', 'profile-save', 'rpc']) assert.ok(src.includes(r), r);
  assert.ok(src.includes("admin: 'admin'") && src.includes("report: 'reportSubmit'"));
  assert.ok(!(await import('node:fs')).readFileSync(new URL('../lib/community.js', import.meta.url), 'utf8').includes('moderation'));
});

// ---------------------------------------------------------------- audit consistency & atomicity
test('audit: mutation + audit record are one transaction — if the audit write fails, NOTHING changes and an error is returned', async () => {
  const s = setup(); s.flags.failAudit = true;
  const before = JSON.stringify([...s.fs.docs]);
  const rs = [
    await s.adm('mod', { action: 'report-update', id: 'rep000', status: 'review', note: 'x' }),
    await s.adm('mod', { action: 'moderate-user', uid: 'USER1', type: 'restrict', reason: 'Scam launches' }),
    await s.adm('owner', { action: 'role-set', uid: 'USER2', role: 'moderator' }),
    await s.adm('owner', { action: 'role-remove', uid: 'MOD1' })
  ];
  for (const r of rs) { assert.equal(r.statusCode, 500); assert.equal(r.body.error, 'server_error'); }
  const after = [...s.fs.docs].filter(([k]) => !k.startsWith('adminSecurity/') && !k.startsWith('adminLogins/'));
  assert.equal(JSON.stringify(after), JSON.stringify([...JSON.parse(before)].filter(([k]) => !k.startsWith('adminSecurity/') && !k.startsWith('adminLogins/'))), 'no document changed');
  s.fs.docs.set('moderation/USER1', { status: 'restricted', restriction: { since: 1 }, history: [] });
  const lift = await s.adm('mod', { action: 'moderation-lift', uid: 'USER1', reason: 'Appeal accepted' });
  assert.equal(lift.statusCode, 500); assert.equal(s.fs.docs.get('moderation/USER1').status, 'restricted');
  s.flags.failAudit = false;
  assert.equal((await s.adm('mod', { action: 'report-update', id: 'rep000', status: 'review' })).statusCode, 200);
});
test('audit: every successful mutation has exactly one matching audit record written with it', async () => {
  const s = setup();
  await s.adm('mod', { action: 'report-update', id: 'rep000', status: 'review' });
  await s.adm('mod', { action: 'moderate-user', uid: 'USER1', type: 'warn', reason: 'Spam posts' });
  await s.adm('mod', { action: 'moderation-lift', uid: 'USER1', reason: 'Appeal accepted' });
  await s.adm('owner', { action: 'role-set', uid: 'USER2', role: 'support' });
  await s.adm('owner', { action: 'role-remove', uid: 'USER2' });
  const acts = [...s.fs.docs].filter(([k]) => k.startsWith('adminAudit/')).map(([, v]) => v.action).sort();
  assert.deepEqual(acts, ['moderate-user', 'moderation-lift', 'report-update', 'role-remove', 'role-set']);
});
test('audit: failed validations and not-found results write no audit record (nothing happened)', async () => {
  const s = setup();
  await s.adm('mod', { action: 'report-update', id: 'zzzzzzzz', status: 'review' });
  await s.adm('mod', { action: 'moderate-user', uid: 'GHOST1', type: 'warn', reason: 'testing now' });
  await s.adm('mod', { action: 'moderate-user', uid: 'FIN1', type: 'warn', reason: 'testing now' });
  await s.adm('owner', { action: 'role-set', uid: 'GHOST1', role: 'moderator' });
  assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('adminAudit/')).length, 0);
});
test('audit: non-admin attempts -> adminSecurity ONLY; authorised admin denied by permission -> adminAudit (ok:false) AND adminSecurity', async () => {
  const s = setup();
  await s.adm('user', { action: 'overview' });
  assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('adminSecurity/')).length, 1);
  assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('adminAudit/')).length, 0);
  await s.adm('sup', { action: 'report-update', id: 'rep000', status: 'review' });
  const a = [...s.fs.docs].filter(([k]) => k.startsWith('adminAudit/')).map(([, v]) => v);
  assert.equal(a.length, 1); assert.equal(a[0].ok, false); assert.equal(a[0].actor, 'SUP1');
  assert.equal([...s.fs.docs.keys()].filter(k => k.startsWith('adminSecurity/')).length, 2);
  assert.equal(s.fs.docs.get('reports/rep000').status, 'new');
});
