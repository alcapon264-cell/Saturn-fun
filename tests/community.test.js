import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunity, messageId, ROOM_RE } from '../lib/community.js';

// minimal in-memory Firestore double (collection/doc/get/create/set/delete/runTransaction)
function fakeDb() {
  const store = new Map();
  const doc = (p) => ({ p, collection: (n) => col(p + '/' + n), async get() { const v = store.get(p); return { exists: v !== undefined, data: () => v }; }, async delete() { store.delete(p); } });
  const col = (p) => ({ doc: (id) => doc(p + '/' + id), collection: undefined });
  return { store, collection: (n) => col(n), async runTransaction(fn) {
    const writes = [];
    const tx = { get: async (r) => r.get(), set: (r, d) => writes.push(['set', r.p, d]), create: (r, d) => { if (store.has(r.p) || writes.some(w => w[1] === r.p)) throw new Error('exists'); writes.push(['set', r.p, d]); } };
    await fn(tx); writes.forEach(([, p, d]) => store.set(p, d)); } };
}
const ROOM = 'So11111111111111111111111111111111111111112';
const tokens = { A: 'uidA', B: 'uidB' };
const verify = async (req) => (tokens[req.token] ? { uid: tokens[req.token] } : null);
const mk = (extra = {}) => { const db = fakeDb(); let t = 1000000; const c = createCommunity({ db, verify, now: () => (t += 5000), ...extra }); return { db, c, tick: (ms) => (t += ms) }; };

test('rejects unauthenticated post', async () => { const { c } = mk(); const r = await c.post({ token: 'nope' }, { room: ROOM, cid: 'abcdefgh1234', text: 'hi' }); assert.equal(r.status, 401); });
test('stores server-verified uid, ignores uid supplied in body', async () => {
  const { c, db } = mk(); const r = await c.post({ token: 'A' }, { room: ROOM, cid: 'abcdefgh1234', text: 'hello', uid: 'uidB', by: 'Alice' });
  assert.equal(r.status, 200); const d = [...db.store.values()].find(x => x.text === 'hello'); assert.equal(d.uid, 'uidA'); assert.equal(r.body.uid, 'uidA'); });
test('validates room, cid, text/image', async () => {
  const { c } = mk(); const A = { token: 'A' };
  assert.equal((await c.post(A, { room: '../x', cid: 'abcdefgh1234', text: 'x' })).status, 400);
  assert.equal((await c.post(A, { room: ROOM, cid: 'x', text: 'x' })).status, 400);
  assert.equal((await c.post(A, { room: ROOM, cid: 'abcdefgh1234', text: '   ' })).status, 400);
  assert.equal((await c.post(A, { room: ROOM, cid: 'abcdefgh1234', img: 'data:image/svg+xml;base64,AAAA' })).status, 400);
  assert.equal((await c.post(A, { room: ROOM, cid: 'abcdefgh1234', img: 'data:text/html;base64,AAAA' })).status, 400); });
test('truncates to 280 chars and strips control characters', async () => {
  const { c, db } = mk(); await c.post({ token: 'A' }, { room: ROOM, cid: 'abcdefgh1234', text: 'a\u0000b\u202e' + 'x'.repeat(500) });
  const d = [...db.store.values()].find(x => x.uid === 'uidA'); assert.ok(d.text.length <= 280); assert.ok(!/[\u0000\u202e]/.test(d.text)); });
test('stored text is plain (HTML is kept as text, never interpreted server-side)', async () => {
  const { c, db } = mk(); await c.post({ token: 'A' }, { room: ROOM, cid: 'abcdefgh1234', text: '<img src=x onerror=alert(1)>' });
  assert.equal([...db.store.values()].find(x => x.uid === 'uidA').text, '<img src=x onerror=alert(1)>'); });
test('retry with same cid is idempotent (one document, ok both times)', async () => {
  const { c, db, tick } = mk(); const b = { room: ROOM, cid: 'abcdefgh1234', text: 'once' };
  const r1 = await c.post({ token: 'A' }, b); tick(10); const r2 = await c.post({ token: 'A' }, b);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200); assert.equal(r1.body.id, r2.body.id);
  assert.equal([...db.store.keys()].filter(k => k.includes('/messages/')).length, 1); });
test('rate limit: second distinct message within 1s is 429', async () => {
  const db = fakeDb(); const c = createCommunity({ db, verify, now: () => 5000 });
  assert.equal((await c.post({ token: 'A' }, { room: ROOM, cid: 'abcdefgh0001', text: 'a' })).status, 200);
  assert.equal((await c.post({ token: 'A' }, { room: ROOM, cid: 'abcdefgh0002', text: 'b' })).status, 429); });
test('wallet only stored when server confirms it is linked to the uid', async () => {
  const W = '7XGVo8SdqUeTP7dFgj3xC7PcmMA6wet4srqnSqnjCSSv';
  const a = mk({ linkedWallets: async () => [W] }); await a.c.post({ token: 'A' }, { room: ROOM, cid: 'abcdefgh1234', text: 'x', wallet: W });
  assert.equal([...a.db.store.values()].find(x => x.uid === 'uidA').wallet, W);
  const b = mk({ linkedWallets: async () => [] }); await b.c.post({ token: 'A' }, { room: ROOM, cid: 'abcdefgh1234', text: 'x', wallet: W });
  assert.equal([...b.db.store.values()].find(x => x.uid === 'uidA').wallet, undefined);
  const n = mk(); await n.c.post({ token: 'A' }, { room: ROOM, cid: 'abcdefgh1234', text: 'x', wallet: W });
  assert.equal([...n.db.store.values()].find(x => x.uid === 'uidA').wallet, undefined); });
test('delete: owner ok, other user 403, anonymous 401, missing 404', async () => {
  const { c } = mk(); const r = await c.post({ token: 'A' }, { room: ROOM, cid: 'abcdefgh1234', text: 'mine' });
  assert.equal((await c.remove({ token: 'B' }, { room: ROOM, id: r.body.id })).status, 403);
  assert.equal((await c.remove({ token: 'x' }, { room: ROOM, id: r.body.id })).status, 401);
  assert.equal((await c.remove({ token: 'A' }, { room: ROOM, id: r.body.id })).status, 200);
  assert.equal((await c.remove({ token: 'A' }, { room: ROOM, id: r.body.id })).status, 404); });
test('room ids accept mints and transaction signatures, reject junk', () => {
  assert.ok(ROOM_RE.test(ROOM)); assert.ok(ROOM_RE.test('5'.repeat(88))); assert.ok(!ROOM_RE.test('abc')); assert.ok(!ROOM_RE.test('a/b'.padEnd(40, 'a'))); });
test('message id is a deterministic hash (different users never collide on same cid)', () => { assert.notEqual(messageId('uidA', 'c1'), messageId('uidB', 'c1')); assert.equal(messageId('uidA', 'c1'), messageId('uidA', 'c1')); });
