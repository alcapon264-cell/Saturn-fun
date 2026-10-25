import { getApp } from '../lib/deps.js';

export default async function handler(req, res) {
  try {
    const app = await getApp();

    if (req.method === 'POST') {
      return await app.ownerSweep(req, res);
    }

    return await app.owner(req, res);
  } catch (e) {
    console.error('[owner]', e && e.message);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end('{"error":"Server error."}');
  }
}
