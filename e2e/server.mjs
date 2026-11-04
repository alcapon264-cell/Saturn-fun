// E2E harness server: REAL Saturn backend (createApp) + in-memory fake Firestore. Token "tok-<UID>" => uid.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const BE = process.env.BE || fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { createApp } = await import(BE + '/lib/app.js');
const { makeStore } = await import(BE + '/lib/deps.js');
const { fakeFirestore } = await import(BE + '/tests/fake-firestore.js');
const fs = fakeFirestore(), store = makeStore(fs);
const ORIGIN = 'https://saturn.test';
const app = createApp({ auth: { async verifyIdToken(t) { if (!/^tok-/.test(t)) throw new Error('bad'); return { uid: t.slice(4), auth_time: Math.floor(Date.now() / 1000), email: t.slice(4) + '@x.test' }; }, async deleteUser() {} }, store, rpc: {}, db: fs, env: { SATURN_ALLOWED_ORIGINS: ORIGIN, PLATFORM_TREASURY_WALLET: '' } });
const src = (await import('node:fs')).readFileSync(BE + '/api/[route].js', 'utf8');
const routes = {}; for (const m of src.matchAll(/'?([a-z-]+)'?:\s*'([A-Za-z]+)'/g)) routes[m[1]] = m[2];
const WA = '7'.repeat(44), WB = '8'.repeat(44), WC = '9'.repeat(44);
const seed = (u, w, name) => { fs.docs.set('users/' + u, { uid: u, wallets: [w], createdAt: 1 }); fs.docs.set('walletLinks/' + w, { uid: u, wallet: w }); fs.docs.set('profiles/' + w, { wallet: w, username: name, displayName: name.toUpperCase(), avatar: '' }); };
seed('UA', WA, 'alice'); seed('UB', WB, 'bob'); seed('UC', WC, 'carol');
http.createServer((rq, rs) => { let d = ''; rq.on('data', c => d += c); rq.on('end', async () => {
  const route = rq.url.split('?')[0].replace('/api/', '');
  if (route === '__dump') { rs.end(JSON.stringify([...fs.docs])); return; }
  const m = routes[route];
  const res = { statusCode: 200, setHeader: (k, v) => rs.setHeader(k, v), end: v => { rs.statusCode = res.statusCode; rs.end(v); } };
  res.json = o => res.end(JSON.stringify(o));
  if (!m || !app[m]) { rs.statusCode = 404; return rs.end('{}'); }
  rq.body = d || '{}'; rq.query = {}; rq.headers.origin = rq.headers.origin || ORIGIN;
  try { await app[m](rq, res); } catch (e) { console.error(e); rs.statusCode = 500; rs.end('{}'); } }); }).listen(8811, () => console.log('up', JSON.stringify({ WA, WB, WC })));
