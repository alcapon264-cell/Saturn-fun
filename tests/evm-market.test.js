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

test('evm market: factory verification uses the pool\'s own token0/token1 (token may be token0 OR token1)', async () => {
  const WETH='0x0bd7d308f8e1639fab988df18a8011f41eacad73', pair='0x'+'2'.repeat(40), word=a=>'0x'+a.slice(2).padStart(64,'0'), uint=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
  for (const tokenIs0 of [true,false]) {
    const token = tokenIs0 ? '0x'+'1'.repeat(40) : '0x'+'f'.repeat(40);
    const [t0,t1] = tokenIs0 ? [token,WETH] : [WETH,token];
    const sqrt = 1n<<96n; // price ratio 1.0 token1/token0, equal decimals
    let factoryPairArgs=null;
    const fetchImpl=async(url,opts)=>{
      if(String(url).includes('coinbase')) return {ok:true,status:200,json:async()=>({data:{amount:'3000'}})};
      const body=JSON.parse(opts.body), data=body.params?.[0]?.data||'', to=(body.params?.[0]?.to||'').toLowerCase();
      let result;
      if(body.method==='eth_chainId')result='0x1237';
      else if(data==='0x0dfe1681')result=word(t0);
      else if(data==='0xd21220a7')result=word(t1);
      else if(data.startsWith('0x1698ee82')){ factoryPairArgs=[data.slice(34,74),data.slice(98,138)]; result=word(data.endsWith(uint(3000).slice(2))?pair:'0x'+'0'.repeat(40)); }
      else if(data==='0x313ce567')result=uint(18);
      else if(data==='0x18160ddd')result=uint(10n**27n);
      else if(data==='0x3850c7bd')result='0x'+sqrt.toString(16).padStart(64,'0')+'0'.repeat(64*6);
      else result='0x'+'0'.repeat(64);
      return {ok:true,status:200,json:async()=>({jsonrpc:'2.0',id:1,result})};
    };
    const evm=createEvm({env:{BLOCKVECTRA_API_KEY:'test'},fetchImpl});
    const r=await evm.market({method:'GET',query:{chain:'robinhood',token,pair}});
    assert.equal(r.status,200,JSON.stringify(r.body)); assert.equal(r.body.ok,true,JSON.stringify(r.body));
    assert.deepEqual(factoryPairArgs,[t0.slice(2),t1.slice(2)],'factory is asked about the sorted (token0, token1) pair');
    assert.equal(r.body.mcKind,'fdv');
  }
});
