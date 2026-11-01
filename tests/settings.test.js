import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../lib/app.js';

function setup() {
  const data = new Map();
  const store = { async get(p) { return data.has(p) ? structuredClone(data.get(p)) : null; }, async set(p,v) { data.set(p, structuredClone(v)); } };
  const app = createApp({ auth: { async verifyIdToken(t) { if (t !== 'valid') throw Error('bad'); return { uid: 'user-1' }; } }, store, rpc: {}, env: { SATURN_ALLOWED_ORIGINS: 'https://saturn.test' }, now: () => 123456 });
  const call = async (token, body) => { const res = { headers:{}, setHeader(k,v){this.headers[k]=v}, end(v){this.body=v?JSON.parse(v):null} }; await app.settings({method:'POST',headers:{origin:'https://saturn.test',...(token?{authorization:'Bearer '+token}:{})},body,query:{}},res); return res; };
  return { call, data, app };
}

test('settings requires verified authentication', async () => { const s=setup(); assert.equal((await s.call(null,{action:'get'})).statusCode,401); assert.equal((await s.call('invalid',{action:'get'})).statusCode,401); });
test('settings defaults are returned and saved preferences persist across reload', async () => { const s=setup(); const d=await s.call('valid',{action:'get'}); assert.equal(d.statusCode,200); assert.deepEqual(d.body.settings,{profileVisibility:'public',showBalance:true,showPnl:true,displayCurrency:'USD',priorityFee:'medium'}); const saved=await s.call('valid',{action:'save',settings:{profileVisibility:'private',showBalance:false,showPnl:false,displayCurrency:'NGN',priorityFee:'high'}}); assert.equal(saved.statusCode,200); const again=await s.call('valid',{action:'get'}); assert.deepEqual(again.body.settings,saved.body.settings); });
test('settings reject unknown keys and invalid values without changing stored preferences', async () => { const s=setup(); assert.equal((await s.call('valid',{action:'save',settings:{admin:true}})).statusCode,400); assert.equal((await s.call('valid',{action:'save',settings:{showBalance:'false'}})).statusCode,400); assert.equal((await s.call('valid',{action:'save',settings:{displayCurrency:'BTC'}})).statusCode,400); assert.equal(s.data.size,0); });
