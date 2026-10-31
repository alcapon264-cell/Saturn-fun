
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunity, messageId } from '../lib/community.js';

function makeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  const ref = path => ({
    path,
    async get() {
      const value = docs.get(path);
      return { exists: value !== undefined, data: () => structuredClone(value) };
    },
    async delete() { docs.delete(path); }
  });
  const collection = path => ({
    doc(id) {
      const p = path + '/' + id;
      return {
        ...ref(p),
        collection(child) { return collection(p + '/' + child); }
      };
    }
  });
  return {
    docs,
    collection,
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(r) { return r.get(); },
        set(r, value) { writes.push(() => docs.set(r.path, structuredClone(value))); },
        create(r, value) {
          writes.push(() => {
            if (docs.has(r.path)) throw new Error('already exists');
            docs.set(r.path, structuredClone(value));
          });
        }
      };
      const result = await fn(tx);
      for (const write of writes) write();
      return result;
    }
  };
}

const ROOM = '11111111111111111111111111111111';
const WALLET_A = '22222222222222222222222222222222';
const WALLET_B = '33333333333333333333333333333333';
const PHOTO_A = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const PHOTO_B = 'data:image/jpeg;base64,/9j/2Q==';

function harness() {
  let clock = 10000;
  const db = makeDb({
    ['profiles/' + WALLET_A]: {
      uid: 'USER_A', wallet: WALLET_A,
      displayName: 'Alice', username: 'alice', avatar: PHOTO_A
    },
    ['profiles/' + WALLET_B]: {
      uid: 'USER_B', wallet: WALLET_B,
      displayName: 'Bob', username: 'bob', avatar: PHOTO_B
    }
  });

  const tokenUsers = {
    'token-a': { uid: 'USER_A' },
    'token-b': { uid: 'USER_B' }
  };
  const wallets = {
    USER_A: [WALLET_A],
    USER_B: [WALLET_B]
  };

  const community = createCommunity({
    db,
    verify: async req => {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!tokenUsers[token]) throw new Error('invalid token');
      return tokenUsers[token];
    },
    linkedWallets: async uid => wallets[uid] || [],
    now: () => (clock += 2000)
  });

  const req = token => ({
    headers: { authorization: 'Bearer ' + token }
  });

  return { db, community, req };
}

test('community: stores each authenticated account identity independently', async () => {
  const { db, community, req } = harness();

  const a = await community.post(req('token-a'), {
    room: ROOM, cid: 'messageA1', wallet: WALLET_A, text: 'Hello Alice'
  });
  const b = await community.post(req('token-b'), {
    room: ROOM, cid: 'messageB1', wallet: WALLET_B, text: 'Hello Bob'
  });

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const rowA = db.docs.get(
    'communityRooms/' + ROOM + '/messages/' + messageId('USER_A', 'messageA1')
  );
  const rowB = db.docs.get(
    'communityRooms/' + ROOM + '/messages/' + messageId('USER_B', 'messageB1')
  );

  assert.equal(rowA.uid, 'USER_A');
  assert.equal(rowA.by, 'Alice');
  assert.equal(rowA.ph, PHOTO_A);
  assert.equal(rowB.uid, 'USER_B');
  assert.equal(rowB.by, 'Bob');
  assert.equal(rowB.ph, PHOTO_B);
});

test('community: ignores forged browser name, photo and uid', async () => {
  const { db, community, req } = harness();

  const result = await community.post(req('token-a'), {
    room: ROOM, cid: 'forged001', wallet: WALLET_A,
    uid: 'USER_B', by: 'Impersonator', ph: PHOTO_B,
    text: 'Do not trust client identity'
  });

  assert.equal(result.status, 200);

  const row = db.docs.get(
    'communityRooms/' + ROOM + '/messages/' + messageId('USER_A', 'forged001')
  );

  assert.equal(row.uid, 'USER_A');
  assert.equal(row.by, 'Alice');
  assert.equal(row.ph, PHOTO_A);
});

test('community: rejects a wallet not linked to the verified account', async () => {
  const { community, req } = harness();

  const result = await community.post(req('token-a'), {
    room: ROOM, cid: 'wrongwal1', wallet: WALLET_B,
    text: 'Impersonation attempt'
  });

  assert.equal(result.status, 403);
});

test('community: old message identity remains unchanged after profile update', async () => {
  const { db, community, req } = harness();

  const result = await community.post(req('token-a'), {
    room: ROOM, cid: 'snapshot1', wallet: WALLET_A,
    text: 'Original identity'
  });

  assert.equal(result.status, 200);

  const path =
    'communityRooms/' + ROOM + '/messages/' + messageId('USER_A', 'snapshot1');

  db.docs.set('profiles/' + WALLET_A, {
    uid: 'USER_A', wallet: WALLET_A,
    displayName: 'Alice Updated', avatar: PHOTO_B
  });

  assert.equal(db.docs.get(path).by, 'Alice');
  assert.equal(db.docs.get(path).ph, PHOTO_A);
});

test('community: only the authenticated author can delete a message', async () => {
  const { db, community, req } = harness();

  const posted = await community.post(req('token-a'), {
    room: ROOM, cid: 'delete001', wallet: WALLET_A,
    text: 'Alice message'
  });

  const id = messageId('USER_A', 'delete001');
  const path = 'communityRooms/' + ROOM + '/messages/' + id;

  assert.equal(posted.status, 200);

  const denied = await community.remove(req('token-b'), {
    room: ROOM, id
  });

  assert.equal(denied.status, 403);
  assert.ok(db.docs.has(path));

  const allowed = await community.remove(req('token-a'), {
    room: ROOM, id
  });

  assert.equal(allowed.status, 200);
  assert.equal(db.docs.has(path), false);
});

test('community: rejects unauthenticated requests and malformed wallets', async () => {
  const { community, req } = harness();

  const unauthenticated = await community.post({ headers: {} }, {
    room: ROOM, cid: 'unauth001',
    wallet: WALLET_A, text: 'No token'
  });

  assert.equal(unauthenticated.status, 401);

  const malformed = await community.post(req('token-a'), {
    room: ROOM, cid: 'badwallet1',
    wallet: 'not-a-wallet', text: 'Bad wallet'
  });

  assert.equal(malformed.status, 403);
});
