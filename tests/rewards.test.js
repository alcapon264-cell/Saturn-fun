import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../lib/app.js';
import { makeStore } from '../lib/deps.js';
import { fakeFirestore } from './fake-firestore.js';

const wallet = '11111111111111111111111111111111';
const sig = '1'.repeat(64);
const mint = 'So11111111111111111111111111111111111111112';
const origin = 'https://site.test';
function setup() {
  const fs = fakeFirestore(), store = makeStore(fs);
  const app = createApp({ auth: { async verifyIdToken(t) { if (t !== 'good') throw Error('bad'); return { uid: 'u1', auth_time: 1 }; } }, store, rpc: {}, db: fs, env: { SATURN_ALLOWED_ORIGINS: origin } });
  const call = async (body, token = 'good') => {
    const res = { headers: {}, setHeader(k,v){this.headers[k.toLowerCase()]=v;}, end(b){this.body=b?JSON.parse(b):null;} };
    await app.rewards({ method:'POST', headers:{ origin, authorization: token ? `Bearer ${token}` : '' }, body, query:{} }, res);
    return res;
  };
  return { fs, store, call };
}

test('rewards requires authenticated linked wallet', async () => {
  const s = setup();
  assert.equal((await s.call({ action:'summary', wallet })).statusCode, 403);
  assert.equal((await s.call({ action:'summary', wallet }, null)).statusCode, 401);
});

test('rewards summary returns explicit zero ledger and keeps claims disabled', async () => {
  const s = setup(); await s.store.set('walletLinks/' + wallet, { uid:'u1' });
  const r = await s.call({ action:'summary', wallet });
  assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true);
  assert.equal(r.body.cashback.claimable, '0');
  assert.equal(r.body.creator.claimable, '0');
  assert.equal(r.body.total.claimable, '0');
  assert.equal(r.body.config.payoutsEnabled, false);
});

test('rewards claims cannot pay while no verified payout source is configured', async () => {
  const s = setup(); await s.store.set('walletLinks/' + wallet, { uid:'u1' });
  const r = await s.call({ action:'claim', wallet, kind:'all', key:'a'.repeat(32) });
  assert.equal(r.statusCode, 503); assert.equal(r.body.error, 'payouts_disabled');
});

test('launch registration requires a matching previously verified Saturn launch event', async () => {
  const s = setup(); await s.store.set('walletLinks/' + wallet, { uid:'u1' });
  assert.equal((await s.call({ action:'register-launch', wallet, mint, sig, kind:'PUMP_LAUNCH' })).statusCode, 202);
  await s.store.set('events/' + sig, { type:'launch', wallet, mint, launchKind:'PUMP_LAUNCH' });
  const r = await s.call({ action:'register-launch', wallet, mint, sig, kind:'PUMP_LAUNCH' });
  assert.equal(r.statusCode, 200); assert.equal(r.body.feeShareConfigured, false);
  const saved = await s.store.get('rewardsLaunches/' + mint);
  assert.equal(saved.saturnShareBps, 2000); assert.equal(saved.creatorShareBps, 8000);
  assert.equal(saved.feeShareAuthorized, false);
});

test('launch cannot be registered to a different wallet or mint', async () => {
  const s = setup(); await s.store.set('walletLinks/' + wallet, { uid:'u1' });
  await s.store.set('events/' + sig, { type:'trade', wallet, mint });
  assert.equal((await s.call({ action:'register-launch', wallet, mint, sig })).statusCode, 403);
});
