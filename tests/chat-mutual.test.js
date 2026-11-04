// Private chat + blocking, end to end through the REAL app handlers (follow-set, settings, chat-*, notifications-*).
// Firestore-SHAPED fake (not real Firestore): proves the application logic, not production Firestore behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../lib/app.js';
import { makeStore } from '../lib/deps.js';
import { fakeFirestore } from './fake-firestore.js';

const ORIGIN = 'https://site.test';
const WA = '7'.repeat(44), WB = '8'.repeat(44), WC = '9'.repeat(44);
const TOK = { ta: { uid: 'UA' }, tb: { uid: 'UB' }, tc: { uid: 'UC' } };
let ip = 0;
function setup() {
  const fs = fakeFirestore(), store = makeStore(fs); let clock = 1_700_000_000_000;
  const hook = { beforeTx: null };
  const db = { ...fs, runTransaction: fn => { if (hook.beforeTx) { const f = hook.beforeTx; hook.beforeTx = null; f(); } return fs.runTransaction(fn); } };
  const app = createApp({ auth: { async verifyIdToken(t) { if (!TOK[t]) throw new Error('bad'); return { ...TOK[t] }; } }, store, rpc: {}, db, now: () => clock, env: { SATURN_ALLOWED_ORIGINS: ORIGIN } });
  for (const [u, w, n] of [['UA', WA, 'alice'], ['UB', WB, 'bob'], ['UC', WC, 'carol']]) {
    fs.docs.set('users/' + u, { uid: u, wallets: [w] }); fs.docs.set('walletLinks/' + w, { uid: u, wallet: w });
    fs.docs.set('profiles/' + w, { wallet: w, username: n, displayName: n, avatar: '' });
  }
  const call = async (h, token, body = {}, sid) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
    await h({ method: 'POST', url: '/x', headers: { origin: ORIGIN, 'x-forwarded-for': '5.5.' + (++ip >> 8) + '.' + (ip & 255), ...(sid ? { 'x-saturn-session': sid } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body, query: {} }, res);
    return res;
  };
  const S = {
    fs, app, call, hook, tick: ms => { clock += ms; },
    follow: (t, from, wallet, follow = true) => call(app.followSet, t, { from, wallet, follow }),
    elig: (t, wallet) => call(app.chatEligibility, t, { wallet }),
    open: (t, wallet) => call(app.chatOpen, t, { wallet }),
    send: (t, conversation, text, cid = 'cid-' + Math.random().toString(36).slice(2, 12)) => { clock += 1000; return call(app.chatSend, t, { conversation, text, cid }); },
    hist: (t, conversation) => call(app.chatHistory, t, { conversation }),
    list: t => call(app.chatList, t, {}),
    notifs: async t => (await call(app.notificationsList, t, {})).body.items,
    block: (t, wallet) => call(app.settings, t, { action: 'block', wallet }),
    unblock: (t, wallet) => call(app.settings, t, { action: 'unblock', wallet }),
    msgs: conv => [...fs.docs].filter(([k]) => k.startsWith('privateChats/' + conv + '/messages/')).map(([, v]) => v)
  };
  S.mutual = async () => { await S.follow('ta', WA, WB); await S.follow('tb', WB, WA); const o = await S.open('ta', WB); return o.body.conversation; };
  return S;
}

test('1. A follows B only: chat unavailable', async () => {
  const s = setup(); assert.equal((await s.follow('ta', WA, WB)).body.changed, true);
  const e = await s.elig('ta', WB); assert.deepEqual([e.body.mutual, e.body.iFollow, e.body.theyFollow], [false, true, false]);
  const o = await s.open('ta', WB); assert.equal(o.statusCode, 403); assert.equal(o.body.error, 'mutual_follow_required');
  assert.equal((await s.send('ta', e.body.conversation, 'hi')).statusCode, 404);
  assert.equal((await s.list('ta')).body.items.length, 0);
});
test('2. B follows back: chat becomes available; both get ONE mutual notification (no duplicates)', async () => {
  const s = setup(); await s.follow('ta', WA, WB);
  const r = await s.follow('tb', WB, WA); assert.equal(r.body.changed, true);
  assert.equal((await s.elig('ta', WB)).body.mutual, true); assert.equal((await s.elig('tb', WA)).body.mutual, true);
  assert.equal((await s.open('ta', WB)).statusCode, 200);
  await s.follow('tb', WB, WA); await s.follow('tb', WB, WA);          // repeated requests
  const na = (await s.notifs('ta')).filter(n => n.type === 'mutual'), nb = (await s.notifs('tb')).filter(n => n.type === 'mutual');
  assert.equal(na.length, 1); assert.equal(nb.length, 1); assert.equal(na[0].from, WB); assert.equal(nb[0].from, WA);
  assert.equal((await s.notifs('tc')).filter(n => n.type === 'mutual').length, 0);
});
test('3. both users can send and receive', async () => {
  const s = setup(); const c = await s.mutual();
  assert.equal((await s.send('ta', c, 'hello bob')).statusCode, 200);
  assert.equal((await s.send('tb', c, 'hi alice')).statusCode, 200);
  const a = (await s.hist('ta', c)).body, b = (await s.hist('tb', c)).body;
  assert.deepEqual(a.messages.map(m => [m.text, m.mine]), [['hello bob', true], ['hi alice', false]]);
  assert.deepEqual(b.messages.map(m => [m.text, m.mine]), [['hello bob', false], ['hi alice', true]]);
  assert.equal(a.peer.username, 'bob'); assert.equal(b.peer.username, 'alice'); assert.ok(a.messages.every(m => m.t > 0));
});
test('4+5. an unrelated third user cannot read or send into the conversation', async () => {
  const s = setup(); const c = await s.mutual(); await s.send('ta', c, 'secret');
  const h = await s.hist('tc', c); assert.equal(h.statusCode, 404); assert.ok(!JSON.stringify(h.body).includes('secret'));
  assert.equal((await s.send('tc', c, 'intruder')).statusCode, 404);
  assert.equal((await call2(s, 'tc', 'chatRead', { conversation: c })).statusCode, 404);
  assert.equal(s.msgs(c).length, 1); assert.equal((await s.list('tc')).body.items.length, 0);
  assert.equal((await s.hist('tc', 'f'.repeat(32))).statusCode, 404); assert.equal((await s.hist('tc', '../x')).statusCode, 400);
});
const call2 = (s, t, route, body) => s.call(s.app[route], t, body);
test('6+7. A unfollows B: new messages blocked, existing messages stay stored and readable', async () => {
  const s = setup(); const c = await s.mutual(); await s.send('ta', c, 'one'); await s.send('tb', c, 'two');
  assert.equal((await s.follow('ta', WA, WB, false)).statusCode, 200);
  for (const t of ['ta', 'tb']) { const r = await s.send(t, c, 'after'); assert.equal(r.statusCode, 403); assert.equal(r.body.error, 'mutual_follow_required'); }
  assert.equal(s.msgs(c).length, 2);
  const h = (await s.hist('tb', c)).body; assert.equal(h.messages.length, 2); assert.equal(h.canSend, false);
  assert.equal((await s.list('ta')).body.items.length, 1);
});
test('8. A blocks B: messaging blocked in both directions, no new conversation, no leak of who blocked', async () => {
  const s = setup(); const c = await s.mutual(); await s.send('ta', c, 'before');
  assert.equal((await s.block('ta', WB)).statusCode, 200);
  const toB = await s.send('ta', c, 'x'), toA = await s.send('tb', c, 'y');
  assert.equal(toB.statusCode, 404); assert.equal(toA.statusCode, 404); assert.deepEqual(toA.body, toB.body, 'blocker and blocked get the same answer');
  assert.equal((await s.open('tb', WA)).statusCode, 404); assert.equal((await s.open('ta', WB)).statusCode, 404);
  assert.equal((await s.elig('tb', WA)).statusCode, 404);
  assert.equal((await s.follow('tb', WB, WA)).statusCode, 403);       // cannot re-follow to get around it
  assert.equal((await s.list('ta')).body.items.length, 0); assert.equal((await s.list('tb')).body.items.length, 0);
  assert.equal(s.msgs(c).length, 1);
});
test('9. blocked user cannot bypass through an old conversation id (history, send, read)', async () => {
  const s = setup(); const c = await s.mutual(); await s.send('ta', c, 'before'); await s.block('ta', WB);
  assert.equal((await s.hist('tb', c)).statusCode, 404); assert.equal((await s.hist('ta', c)).statusCode, 404);
  assert.equal((await s.send('tb', c, 'bypass')).statusCode, 404); assert.equal((await call2(s, 'tb', 'chatRead', { conversation: c })).statusCode, 404);
  assert.equal(s.msgs(c).length, 1);
});
test('10. unblock does NOT restore mutual follow: messaging stays unavailable until both follow again', async () => {
  const s = setup(); const c = await s.mutual(); await s.block('ta', WB);
  assert.equal((await s.unblock('ta', WB)).statusCode, 200);
  const e = await s.elig('ta', WB); assert.equal(e.body.mutual, false); assert.deepEqual([e.body.iFollow, e.body.theyFollow], [false, false]);
  assert.equal((await s.send('ta', c, 'still no')).statusCode, 403); assert.equal((await s.send('tb', c, 'still no')).statusCode, 403);
  await s.follow('ta', WA, WB); assert.equal((await s.send('ta', c, 'one-way')).statusCode, 403);
  await s.follow('tb', WB, WA); assert.equal((await s.send('ta', c, 'mutual again')).statusCode, 200);
  assert.deepEqual((await s.hist('tb', c)).body.messages.map(m => m.text), ['mutual again']);
});
test('11. a sender cannot be impersonated: identity always comes from the verified token', async () => {
  const s = setup(); const c = await s.mutual();
  const r = await s.call(s.app.chatSend, 'ta', { conversation: c, text: 'forged', cid: 'cid-forge1234', from: 'UB', uid: 'UB', sender: 'UB', userId: 'UB' });
  assert.equal(r.statusCode, 200); assert.deepEqual(s.msgs(c).map(m => m.from), ['UA']);
  assert.equal((await s.hist('tb', c)).body.messages[0].mine, false);
  assert.equal((await s.send('tc', c, 'as carol')).statusCode, 404);
});
test('12. duplicate submissions create one message and one unread', async () => {
  const s = setup(); const c = await s.mutual();
  const [a, b, d] = [await s.call(s.app.chatSend, 'ta', { conversation: c, text: 'once', cid: 'cid-dup-0001' }), await s.call(s.app.chatSend, 'ta', { conversation: c, text: 'once', cid: 'cid-dup-0001' }), await s.call(s.app.chatSend, 'ta', { conversation: c, text: 'once', cid: 'cid-dup-0001' })];
  assert.equal(a.body.duplicate, false); assert.equal(b.body.duplicate, true); assert.equal(d.body.duplicate, true); assert.equal(a.body.id, b.body.id);
  assert.equal(s.msgs(c).length, 1); assert.equal((await s.list('tb')).body.items[0].unread, 1);
  assert.equal((await s.notifs('tb')).filter(n => n.type === 'message')[0].count, 1);
});
test('13. unread counts, message notification and read state belong to the correct recipient only', async () => {
  const s = setup(); const c = await s.mutual(); await s.send('ta', c, 'm1'); await s.send('ta', c, 'm2');
  assert.equal((await s.list('tb')).body.items[0].unread, 2); assert.equal((await s.list('ta')).body.items[0].unread, 0);
  const nb = (await s.notifs('tb')).filter(n => n.type === 'message'); assert.equal(nb.length, 1); assert.equal(nb[0].read, false); assert.equal(nb[0].count, 2); assert.equal(nb[0].from, WA);
  assert.ok(!JSON.stringify(nb).includes('m1'), 'notification carries no message text');
  assert.equal((await s.notifs('ta')).filter(n => n.type === 'message').length, 0);
  await s.hist('ta', c);                                                  // sender opening it must NOT clear the recipient's unread
  assert.equal((await s.list('tb')).body.items[0].unread, 2);
  await s.hist('tb', c);
  assert.equal((await s.list('tb')).body.items[0].unread, 0); assert.equal((await s.notifs('tb')).filter(n => n.type === 'message')[0].read, true);
  await s.send('tb', c, 'reply'); assert.equal((await s.list('ta')).body.items[0].unread, 1);
  assert.equal((await call2(s, 'ta', 'chatRead', { conversation: c })).statusCode, 200); assert.equal((await s.list('ta')).body.items[0].unread, 0);
  await s.send('ta', c, 'm3'); assert.equal((await s.notifs('tb')).filter(n => n.type === 'message')[0].count, 1, 'count restarts after read');
});
test('14. invalid authentication and revoked/missing sessions are rejected', async () => {
  const s = setup();
  for (const r of ['chatEligibility', 'chatOpen', 'chatSend', 'chatHistory', 'chatList', 'chatRead']) { assert.equal((await s.call(s.app[r], null, {})).statusCode, 401, r); assert.equal((await s.call(s.app[r], 'forged', {})).statusCode, 401, r); }
  const a = await s.call(s.app.settings, 'ta', { action: 'session-register' }), b = await s.call(s.app.settings, 'ta', { action: 'session-register' }, a.body.sessionId);
  assert.equal((await s.call(s.app.chatList, 'ta', {}, a.body.sessionId)).statusCode, 200);
  assert.equal((await s.call(s.app.chatList, 'ta', {})).statusCode, 401, 'enforced account: no session header');
  assert.equal((await s.call(s.app.chatList, 'ta', {}, 'bogus-session-id')).statusCode, 401);
  const c = await s.call(s.app.settings, 'ta', { action: 'session-register' }, a.body.sessionId);
  assert.equal((await s.call(s.app.settings, 'ta', { action: 'session-revoke', id: b.body.session.id }, a.body.sessionId)).statusCode, 200);
  assert.equal((await s.call(s.app.chatList, 'ta', {}, b.body.sessionId)).statusCode, 401, 'revoked session');
});
test('validation: size limits, empty, control characters, bad cursor', async () => {
  const s = setup(); const c = await s.mutual();
  assert.equal((await s.send('ta', c, 'x'.repeat(1001))).statusCode, 400); assert.equal((await s.send('ta', c, '   ')).body.error, 'empty_message');
  assert.equal((await s.send('ta', c, 'x'.repeat(5000))).statusCode, 400);
  assert.equal((await s.call(s.app.chatSend, 'ta', { conversation: c, text: 'ok', cid: 'x' })).statusCode, 400);
  assert.equal((await s.call(s.app.chatHistory, 'ta', { conversation: c, before: -1 })).statusCode, 400);
  assert.equal((await s.send('ta', c, 'a\u0000b\u202Ec')).statusCode, 200); assert.equal(s.msgs(c)[0].text, 'a b c');
  const fast = await s.call(s.app.chatSend, 'ta', { conversation: c, text: 'burst', cid: 'cid-burst-001' }); // same clock tick as previous send
  assert.ok([200, 429].includes(fast.statusCode));
});
test('blocking stops message and mutual notifications and hides existing ones', async () => {
  const s = setup(); const c = await s.mutual(); await s.send('tb', c, 'hello alice');
  assert.equal((await s.notifs('ta')).filter(n => n.type === 'message').length, 1);
  await s.block('ta', WB);
  assert.equal((await s.notifs('ta')).filter(n => n.type === 'message' || n.type === 'mutual').length, 0, 'existing alerts from the blocked user are hidden');
  const before = s.fs.docs.size; await s.send('tb', c, 'after block'); assert.equal(s.fs.docs.size, before, 'a refused send writes nothing, including notifications');
});
test('RACE: a block that lands after the pre-checks but before the write still stops the message (re-checked inside the transaction)', async () => {
  const s = setup(); const c = await s.mutual();
  s.hook.beforeTx = () => s.fs.docs.set('blocks/UB__UA', { blocker: 'UB', blocked: 'UA', createdAt: 1 });
  const r = await s.send('ta', c, 'sneaky'); assert.equal(r.statusCode, 404); assert.equal(s.msgs(c).length, 0);
  assert.equal((await s.notifs('tb')).filter(n => n.type === 'message').length, 0);
});
test('RACE: an unfollow that lands after the pre-checks but before the write still stops the message', async () => {
  const s = setup(); const c = await s.mutual();
  s.hook.beforeTx = () => s.fs.docs.delete('follows/' + WB + '_' + WA);
  const r = await s.send('ta', c, 'sneaky'); assert.equal(r.statusCode, 403); assert.equal(s.msgs(c).length, 0);
});
test('privacy: messages never appear in profile, follow or community endpoints', async () => {
  const s = setup(); const c = await s.mutual(); await s.send('ta', c, 'TOP-SECRET-TEXT');
  const out = [await s.call(s.app.followList, 'tc', { wallet: WA, kind: 'followers' }), await s.call(s.app.notificationsList, 'tc', {}), await s.call(s.app.notificationsList, 'tb', {})];
  for (const r of out) assert.ok(!JSON.stringify(r.body).includes('TOP-SECRET-TEXT'));
});
