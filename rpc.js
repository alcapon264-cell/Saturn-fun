import { getApp } from '../lib/deps.js';
export default async function handler(req, res) {
  try { const app = await getApp(); return await app.rpcProxy(req, res); }
  catch (e) { console.error('[rpc]', e && e.message); res.statusCode = 500; res.setHeader('content-type', 'application/json'); res.end('{"error":"Server error."}'); }
}
