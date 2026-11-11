import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvm } from '../lib/evm.js';

test('evm market: only the Robinhood chain is accepted', async () => {
  const evm=createEvm({env:{BLOCKVECTRA_API_KEY:'test'},fetchImpl:async()=>{throw new Error('should_not_fetch')}});
  const r=await evm.market({method:'GET',query:{chain:'base',token:'0x'+'1'.repeat(40),pair:'0x'+'2'.repeat(40)}});
  assert.equal(r.status,400); assert.equal(r.body.error,'unsupported_chain_market');
});

test('evm market: rejects malformed token and pool addresses', async () => {
  const evm=createEvm({env:{BLOCKVECTRA_API_KEY:'test'},fetchImpl:async()=>{throw new Error('should_not_fetch')}});
  const r=await evm.market({method:'GET',query:{chain:'robinhood',token:'bad',pair:'bad'}});
  assert.equal(r.status,400); assert.equal(r.body.error,'bad_params');
});

test('evm market: rejects unsupported quote assets before attempting a valuation', async () => {
  const token='0x'+'1'.repeat(40), pair='0x'+'2'.repeat(40), other='0x'+'3'.repeat(40);
  const word=a=>'0x'+a.slice(2).padStart(64,'0');
  const fetchImpl=async(url,opts)=>{
    const body=JSON.parse(opts.body), data=body.params?.[0]?.data||'';
    let result;
    if(body.method==='eth_chainId')result='0x1237';
    else if(data==='0x0dfe1681')result=word(token);
    else if(data==='0xd21220a7')result=word(other);
    else result='0x'+'0'.repeat(64);
    return {ok:true,status:200,json:async()=>({jsonrpc:'2.0',id:1,result})};
  };
  const evm=createEvm({env:{BLOCKVECTRA_API_KEY:'test'},fetchImpl});
  const r=await evm.market({method:'GET',query:{chain:'robinhood',token,pair}});
  assert.equal(r.status,200); assert.equal(r.body.ok,false); assert.equal(r.body.error,'unsupported_quote_asset');
});
