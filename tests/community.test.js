import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunity } from '../lib/community.js';

const ROOM = 'So11111111111111111111111111111111111111112';
const WALLET = '11111111111111111111111111111111';
function dbFake() {
  const docs = new Map();
  const ref = path => ({
    async get() { const v = docs.get(path); return { exists: v !== undefined, data: () => structuredClone(v) }; },
    async create(v) { if (docs.has(path)) throw new Error('exists'); docs.set(path, structuredClone(v)); },
    async delete() { docs.delete(path); },
    collection(name) { return collection(path + '/' + name); }
  });
  const collection = path => ({ doc: id => ref(path + '/' + id) });
  return { docs, collection, async runTransaction(fn) {
    const writes=[]; const tx={async get(r){return r.get()},set(r,v){writes.push(()=>r.create(v))},create(r,v){writes.push(()=>r.create(v))}};
    const out=await fn(tx); for(const w of writes)w(); return out;
  }};
}
const req={headers:{authorization:'Bearer test'}};

test('community resolves a sole linked wallet when the browser omits its wallet cache', async()=>{
 const db=dbFake(); db.docs.set('profiles/'+WALLET,{wallet:WALLET,displayName:'Cato',username:'cato_user',avatar:''});
 const svc=createCommunity({db,verify:async()=>({uid:'USER1'}),linkedWallets:async()=>[WALLET],now:()=>1700000000000});
 const r=await svc.post(req,{room:ROOM,cid:'cid_12345678',text:'hello'});
 assert.equal(r.status,200); assert.equal(r.body.by,'Cato');
 const saved=[...db.docs.entries()].find(([k])=>k.startsWith('communityRooms/'))[1];
 assert.equal(saved.wallet,WALLET); assert.equal(saved.by,'Cato');
});

test('community does not attach a wallet when the account has multiple linked wallets and none is selected', async()=>{
 const db=dbFake(); db.docs.set('profiles/'+WALLET,{wallet:WALLET,displayName:'Cato'});
 const svc=createCommunity({db,verify:async()=>({uid:'USER1'}),linkedWallets:async()=>[WALLET,'22222222222222222222222222222222'],now:()=>1700000000000});
 const r=await svc.post(req,{room:ROOM,cid:'cid_abcdefgh',text:'hello'});
 assert.equal(r.status,200); assert.equal(r.body.by,'Trader');
});
