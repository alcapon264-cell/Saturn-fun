import { getApp } from '../lib/deps.js';

export default async function handler(req, res) {
  try {
    const app = await getApp();
    return await app.communityDelete(req, res);
  } catch (e) {
    console.error('[community-delete]', e && e.message);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end('{"error":"Server error."}');
  }
}
