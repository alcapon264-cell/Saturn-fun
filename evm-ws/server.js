import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.BLOCKVECTRA_API_KEY;
const ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
const CATALOG_URL = 'https://api.blockvectra.com/v1/chains';
const CHAINS = Object.freeze({
  eth: { slug: 'eth_mainnet', chainId: 1 },
  base: { slug: 'base_mainnet', chainId: 8453 },
  arb: { slug: 'arb_mainnet', chainId: 42161 },
  poly: { slug: 'polygon_mainnet', chainId: 137 },
  robinhood: { slug: 'robinhood_mainnet', chainId: 4663 },
  bsc: { slug: 'bsc_mainnet', chainId: 56 }
});
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const state = Object.fromEntries(Object.keys(CHAINS).map(k => [k, {
  supported:false, logs:false, connected:false, subscribed:false, lastHeadAt:null,
  lastBlock:null, reconnects:0, lastError:null
}]));
const clients = new Set(), upstreams = new Map(), poolSubs = new Map(), subIndex = new Map();
let shuttingDown = false;

function send(c,p){if(c.readyState===WebSocket.OPEN&&c.bufferedAmount<256*1024)c.send(JSON.stringify(p))}
function broadcast(p){for(const c of clients)send(c,p)}
function safeOrigin(o){return !ORIGINS.size||(o&&ORIGINS.has(o))}
function chainKey(v){return Object.prototype.hasOwnProperty.call(CHAINS,v)?v:null}
function findEntry(payload,slug){
 const stack=[payload],seen=new Set();
 while(stack.length){const v=stack.pop();if(!v||typeof v!=='object'||seen.has(v))continue;seen.add(v);
  if(Array.isArray(v)){stack.push(...v);continue}
  if(String(v.chain||v.slug||v.id||v.name||'').toLowerCase()===slug.toLowerCase())return v;
  for(const x of Object.values(v))if(x&&typeof x==='object')stack.push(x)
 }return null
}
function poolKey(chain,address){return chain+':'+address.toLowerCase()}
function removeClientPool(c,key){
 if(c._satPools)c._satPools.delete(key);
 const rec=poolSubs.get(key);if(!rec)return;rec.clients.delete(c);
 if(!rec.clients.size){
  poolSubs.delete(key);
  const up=upstreams.get(rec.chain);
  if(up&&up.readyState===WebSocket.OPEN&&rec.subId){
   const id=up._satNextId++;up.send(JSON.stringify({jsonrpc:'2.0',id,method:'eth_unsubscribe',params:[rec.subId]}));
  }
  if(rec.subId)subIndex.delete(rec.chain+':'+rec.subId);
 }
}
function subscribePool(c,chain,address){
 if(!chain||!ADDR.test(address||''))return;
 const addr=address.toLowerCase(),key=poolKey(chain,addr);
 for(const k of [...(c._satPools||[])])if(k!==key)removeClientPool(c,k);
 c._satPools=c._satPools||new Set();c._satPools.add(key);
 let rec=poolSubs.get(key);
 if(!rec){rec={chain,address:addr,clients:new Set(),subId:null,pendingId:null};poolSubs.set(key,rec)}
 rec.clients.add(c);
 const up=upstreams.get(chain);
 if(!rec.subId&&!rec.pendingId&&up&&up.readyState===WebSocket.OPEN&&state[chain].logs){
  const id=up._satNextId++;rec.pendingId=id;up._satPending.set(id,{kind:'pool',key});
  up.send(JSON.stringify({jsonrpc:'2.0',id,method:'eth_subscribe',params:['logs',{address:addr}]}));
 }
}
function subscribeExistingPools(chain,ws){
 for(const [key,rec] of poolSubs){
  if(rec.chain!==chain||!rec.clients.size)continue;
  rec.subId=null;rec.pendingId=null;
  const id=ws._satNextId++;rec.pendingId=id;ws._satPending.set(id,{kind:'pool',key});
  ws.send(JSON.stringify({jsonrpc:'2.0',id,method:'eth_subscribe',params:['logs',{address:rec.address}]}));
 }
}
async function loadCatalog(){
 const r=await fetch(CATALOG_URL,{headers:{'x-api-key':API_KEY,accept:'application/json'},signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw new Error('catalog_http_'+r.status);
 const payload=await r.json();if(!Array.isArray(payload?.chains))throw new Error('catalog_invalid_shape');
 for(const [k,ch] of Object.entries(CHAINS)){
  const e=findEntry(payload,ch.slug),subs=Array.isArray(e?.subscriptions)?e.subscriptions:[];
  state[k].supported=e?.ws===true&&subs.includes('newHeads');
  state[k].logs=e?.ws===true&&subs.includes('logs');
  state[k].lastError=state[k].supported?null:'websocket_not_confirmed_by_catalog';
  if(!e)state[k].lastError='chain_not_listed_in_catalog';
 }
}
function connectChain(key,chain){
 if(shuttingDown||!state[key].supported||!API_KEY)return;
 const s=state[key],ws=new WebSocket(`wss://api.blockvectra.com/v1/${chain.slug}/${encodeURIComponent(API_KEY)}`,{handshakeTimeout:12000,perMessageDeflate:false});
 upstreams.set(key,ws);ws._satNextId=1;ws._satPending=new Map();ws._satHeads=null;
 ws.on('open',()=>{
  s.connected=true;s.lastError=null;
  const id=ws._satNextId++;ws._satPending.set(id,{kind:'heads'});
  ws.send(JSON.stringify({jsonrpc:'2.0',id,method:'eth_subscribe',params:['newHeads']}));
  subscribeExistingPools(key,ws);
 });
 ws.on('message',raw=>{
  let m;try{m=JSON.parse(raw.toString())}catch{return}
  if(m.id!=null){
   const p=ws._satPending.get(m.id);if(!p)return;ws._satPending.delete(m.id);
   if(p.kind==='heads'){
    if(typeof m.result==='string'){ws._satHeads=m.result;s.subscribed=true;broadcast({type:'evm_ws_status',chain:key,chainId:chain.chainId,connected:true,subscribed:true,logs:s.logs})}
    else{s.lastError='newHeads_subscription_rejected';}
   }else if(p.kind==='pool'){
    const rec=poolSubs.get(p.key);if(!rec)return;rec.pendingId=null;
    if(typeof m.result==='string'){rec.subId=m.result;subIndex.set(key+':'+m.result,p.key);for(const c of rec.clients)send(c,{type:'evm_pool_subscribed',chain:key,address:rec.address})}
    else{s.lastError='pool_logs_subscription_rejected'}
   }
   return;
  }
  if(m.method!=='eth_subscription'||!m.params?.result)return;
  const result=m.params.result,idx=key+':'+m.params.subscription,pool=subIndex.get(idx);
  if(pool){
   const rec=poolSubs.get(pool);if(!rec)return;
   if(result.removed===true){for(const c of rec.clients)send(c,{type:'evm_pool_log',chain:key,address:rec.address,removed:true,blockNumber:result.blockNumber,blockHash:result.blockHash,transactionHash:result.transactionHash,logIndex:result.logIndex,receivedAt:Date.now()});return}
   for(const c of rec.clients)send(c,{type:'evm_pool_log',chain:key,address:rec.address,removed:false,blockNumber:result.blockNumber,blockHash:result.blockHash,transactionHash:result.transactionHash,logIndex:result.logIndex,topics:result.topics||[],data:result.data||'',receivedAt:Date.now()});
   return;
  }
  if(m.params.subscription===ws._satHeads){
   const h=result;s.lastHeadAt=new Date().toISOString();s.lastBlock=h.number||null;
   broadcast({type:'evm_head',chain:key,chainId:chain.chainId,number:h.number||null,hash:h.hash||null,parentHash:h.parentHash||null,timestamp:h.timestamp||null,receivedAt:s.lastHeadAt});
  }
 });
 ws.on('error',e=>{s.lastError=String(e?.message||'upstream_error').slice(0,120)});
 ws.on('close',()=>{
  s.connected=false;s.subscribed=false;
  if(upstreams.get(key)===ws)upstreams.delete(key);
  for(const [idx,pool] of [...subIndex])if(idx.startsWith(key+':'))subIndex.delete(idx);
  for(const rec of poolSubs.values())if(rec.chain===key){rec.subId=null;rec.pendingId=null}
  broadcast({type:'evm_ws_status',chain:key,chainId:chain.chainId,connected:false,subscribed:false,logs:s.logs});
  if(shuttingDown)return;s.reconnects++;
  const cap=Math.min(20000,500*Math.pow(2,Math.min(s.reconnects,6)));
  setTimeout(()=>connectChain(key,chain),Math.floor(Math.random()*cap)).unref?.();
 });
}
const server=http.createServer((req,res)=>{
 if(req.url==='/healthz'||req.url==='/'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true,service:'saturn-evm-ws',chains:state,poolSubscriptions:poolSubs.size}));return}
 res.writeHead(404,{'content-type':'application/json'});res.end('{"ok":false,"error":"not_found"}')
});
const wss=new WebSocketServer({noServer:true,maxPayload:16*1024});
server.on('upgrade',(req,socket,head)=>{
 if(req.url!=='/live'||!safeOrigin(req.headers.origin)){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return}
 wss.handleUpgrade(req,socket,head,c=>wss.emit('connection',c,req))
});
wss.on('connection',c=>{
 c._satPools=new Set();clients.add(c);send(c,{type:'evm_ws_snapshot',chains:state});
 c.on('message',raw=>{
  let m;try{m=JSON.parse(raw.toString())}catch{return}
  if(!m||m.type!=='subscribe_pool')return;
  const chain=chainKey(String(m.chain||''));if(!chain||!state[chain].logs)return;
  subscribePool(c,chain,String(m.address||''));
 });
 c.on('close',()=>{for(const k of [...c._satPools])removeClientPool(c,k);clients.delete(c)});
 c.on('error',()=>{for(const k of [...c._satPools])removeClientPool(c,k);clients.delete(c)});
});
const heartbeat=setInterval(()=>{for(const [k,ws] of upstreams)if(ws.readyState===WebSocket.OPEN){try{ws.ping()}catch{state[k].lastError='heartbeat_failed'}}},25000);heartbeat.unref?.();
async function start(){if(!API_KEY)throw new Error('BLOCKVECTRA_API_KEY is required');await loadCatalog();server.listen(PORT,'0.0.0.0',()=>console.log('[saturn-evm-ws] listening on '+PORT));for(const [k,ch] of Object.entries(CHAINS))connectChain(k,ch)}
function shutdown(){if(shuttingDown)return;shuttingDown=true;clearInterval(heartbeat);for(const ws of upstreams.values())try{ws.close(1001,'service_shutdown')}catch{};for(const c of clients)try{c.close(1001,'service_shutdown')}catch{};server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref()}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);start().catch(e=>{console.error('[saturn-evm-ws] startup_failed:',e.message);process.exit(1)});
