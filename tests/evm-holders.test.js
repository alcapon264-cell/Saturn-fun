// GitHub destination: Saturn-fun/tests/evm-holders.test.js  — MOCKED provider, no network.
import test from 'node:test';import assert from 'node:assert/strict';import {evmHolders} from '../lib/evm-holders.js';
const T='0x'+'ab'.repeat(20),O1='0x'+'01'.repeat(20),env={EVM_HOLDERS_PROVIDER:'moralis',EVM_HOLDERS_API_KEY:'k'};
const ok=body=>async()=>({ok:true,json:async()=>body});
test('unsupported chain',async()=>assert.equal((await evmHolders({chain:'robinhood',token:T},{env,fetchImpl:ok({})})).body.error,'unsupported_chain'));
test('not configured',async()=>assert.equal((await evmHolders({chain:'eth',token:T},{env:{},fetchImpl:ok({})})).body.error,'not_configured'));
test('bad token',async()=>assert.equal((await evmHolders({chain:'eth',token:'0x1'},{env,fetchImpl:ok({})})).status,400));
test('maps holders + cursor',async()=>{const r=await evmHolders({chain:'base',token:T,limit:'2'},{env,fetchImpl:ok({result:[{owner_address:O1,balance:'5000'}],cursor:'c2'})});assert.deepEqual(r.body,{ok:true,holders:[{address:O1,balance:'5000'}],nextCursor:'c2'})});
test('malformed provider data is rejected, not repaired',async()=>assert.equal((await evmHolders({chain:'eth',token:T},{env,fetchImpl:ok({result:[{owner_address:O1,balance:12.5}]})})).body.error,'provider_bad_response'));
test('provider down',async()=>assert.equal((await evmHolders({chain:'eth',token:T},{env,fetchImpl:async()=>{throw new Error('x')}})).body.error,'provider_unreachable'));
