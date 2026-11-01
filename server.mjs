import http from 'node:http';
import { createApp } from '/home/claude/be/Saturn-fun-main/lib/app.js';
import { makeStore } from '/home/claude/be/Saturn-fun-main/lib/deps.js';
import { fakeFirestore } from '/home/claude/be/Saturn-fun-main/tests/fake-firestore.js';
const fs = fakeFirestore(), store = makeStore(fs);
const TOK = { t1: { uid: 'U1', auth_time: 1 }, t2: { uid: 'U2', auth_time: 1 } };
const app = createApp({ auth: { async verifyIdToken(t) { if (!TOK[t]) throw new Error('bad'); return { ...TOK[t] }; }, async deleteUser() {} }, store, rpc: {}, db: fs, env: { SATURN_ALLOWED_ORIGINS: 'https://saturn.test' } });
const routes = { account:'account','profile-get':'profileGet','profile-save':'profileSave','profile-search':'profileSearch',settings:'settings','link-wallet':'linkWallet','follow-counts':'followCounts','follow-list':'followList','follow-set':'followSet','notifications-list':'notificationsList',events:'events',rpc:'rpcProxy' };
http.createServer((rq, rs) => { let d=''; rq.on('data',c=>d+=c); rq.on('end', async()=>{
  const route = rq.url.split('?')[0].replace('/api/',''); const m = routes[route];
  const res = { statusCode:200, setHeader:(k,v)=>rs.setHeader(k,v), end:v=>{rs.statusCode=res.statusCode;rs.end(v)} };
  if(!m||!app[m]){rs.statusCode=404;return rs.end('{}');}
  rq.body = d||'{}'; rq.query = {};
  await app[m](rq,res); }); }).listen(8799,()=>console.log('up'));
