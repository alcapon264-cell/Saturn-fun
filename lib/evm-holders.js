// GitHub destination: Saturn-fun/lib/evm-holders.js   (NEW FILE)
// Provider-backed EVM token holders. Adapter below targets Moralis "ERC20 token owners".
// UNVERIFIED against the live provider (written offline). Env: EVM_HOLDERS_PROVIDER=moralis, EVM_HOLDERS_API_KEY=<server-side secret>.
// No data is ever invented: any missing/odd provider answer becomes an error the frontend shows as "unavailable".
const CHAINS={eth:'eth',base:'base',arb:'arbitrum',poly:'polygon',bsc:'bsc'}; // robinhood: not mapped -> unsupported_chain until the provider supports it
const ADDR=/^0x[0-9a-fA-F]{40}$/;
export async function evmHolders({chain,token,limit,cursor},{env=process.env,fetchImpl=fetch}={}){
  if(!Object.prototype.hasOwnProperty.call(CHAINS,chain))return{status:200,body:{ok:false,error:'unsupported_chain'}};
  if(!ADDR.test(token||''))return{status:400,body:{ok:false,error:'bad_token'}};
  if(env.EVM_HOLDERS_PROVIDER!=='moralis'||!env.EVM_HOLDERS_API_KEY)return{status:200,body:{ok:false,error:'not_configured'}};
  const lim=Math.min(Math.max(parseInt(limit,10)||50,1),100);
  const q=new URLSearchParams({chain:CHAINS[chain],limit:String(lim),order:'DESC'});
  if(cursor&&/^[\w.\-=+/]{1,512}$/.test(cursor))q.set('cursor',cursor);
  let r;try{r=await fetchImpl('https://deep-index.moralis.io/api/v2.2/erc20/'+token+'/owners?'+q,{headers:{'X-API-Key':env.EVM_HOLDERS_API_KEY,accept:'application/json'}})}catch(e){return{status:200,body:{ok:false,error:'provider_unreachable'}}}
  if(!r.ok)return{status:200,body:{ok:false,error:'provider_error'}};
  let j;try{j=await r.json()}catch(e){return{status:200,body:{ok:false,error:'provider_bad_response'}}}
  if(!j||!Array.isArray(j.result))return{status:200,body:{ok:false,error:'provider_bad_response'}};
  const holders=[];for(const h of j.result){const a=h.owner_address,b=h.balance;if(!ADDR.test(a||'')||typeof b!=='string'||!/^\d+$/.test(b))return{status:200,body:{ok:false,error:'provider_bad_response'}};holders.push({address:a,balance:b})}
  return{status:200,body:{ok:true,holders,nextCursor:typeof j.cursor==='string'&&j.cursor?j.cursor:null}};
}
