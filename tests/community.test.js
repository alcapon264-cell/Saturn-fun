import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunity, ROOM_RE } from '../lib/community.js';

const ROOM = 'So11111111111111111111111111111111111111112';
const EVM_ROOM = 'eth_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const BASE_ROOM = 'base_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WALLET = '11111111111111111111111111111111';
function dbFake() {
  const docs = new Map();
  const ref = path => ({
    __path: path,
    async get() { const v = docs.get(path); return { exists: v !== undefined, data: () => structuredClone(v) }; },
    async create(v) { if (docs.has(path)) throw new Error('exists'); docs.set(path, structuredClone(v)); },
    async delete() { docs.delete(path); },
    collection(name) { return collection(path + '/' + name); }
  });
  const collection = path => ({ doc: id => ref(path + '/' + id) });
  return { docs, collection, async runTransaction(fn) {
    const writes=[]; const tx={async get(r){return r.get()},set(r,v){writes.push(async()=>{docs.set(r.__path,structuredClone(v))})},create(r,v){writes.push(()=>r.create(v))}};
    const out=await fn(tx); for(const w of writes)w(); return out;
  }};
}
const req={headers:{authorization:'Bearer test'}};

test('room validation accepts existing Solana IDs and supported chain-prefixed EVM IDs',()=>{
 assert.equal(ROOM_RE.test(ROOM),true);
 assert.equal(ROOM_RE.test(EVM_ROOM),true);
 assert.equal(ROOM_RE.test(BASE_ROOM),true);
});

test('room validation rejects unprefixed EVM addresses and unknown chain prefixes',()=>{
 assert.equal(ROOM_RE.test('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),false);
 assert.equal(ROOM_RE.test('unknown_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),false);
 assert.equal(ROOM_RE.test('eth_0x1234'),false);
});

test('community accepts and stores a message in an EVM-specific room',async()=>{
 const db=dbFake();
 const svc=createCommunity({db,verify:async()=>({uid:'USER1'}),now:()=>1700000000000});
 const r=await svc.post(req,{room:EVM_ROOM,cid:'cid_12345678',text:'hello EVM'});
 assert.equal(r.status,200);
 assert.equal(r.body.ok,true);
 assert.ok(db.docs.has(`communityRooms/${EVM_ROOM}/messages/${r.body.id}`));
});

test('community keeps identical contract addresses isolated by chain',async()=>{
 const db=dbFake();
 let clock=1700000000000;
 const svc=createCommunity({db,verify:async()=>({uid:'USER1'}),now:()=>{clock+=1001;return clock}});
 const a=await svc.post(req,{room:EVM_ROOM,cid:'cid_eth_1234',text:'Ethereum'});
 const b=await svc.post(req,{room:BASE_ROOM,cid:'cid_base_1234',text:'Base'});
 assert.equal(a.status,200); assert.equal(b.status,200);
 assert.ok(db.docs.has(`communityRooms/${EVM_ROOM}/messages/${a.body.id}`));
 assert.ok(db.docs.has(`communityRooms/${BASE_ROOM}/messages/${b.body.id}`));
});

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
