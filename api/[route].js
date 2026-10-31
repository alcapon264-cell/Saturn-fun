import { getApp } from '../lib/deps.js';

const routes = {
  account: 'account',
  'community-post': 'communityPost',
  'community-delete': 'communityDelete',
  events: 'events',
  'follow-counts': 'followCounts',
  'follow-list': 'followList',
  'follow-set': 'followSet',
  'link-identity': 'linkIdentity',
  'link-wallet': 'linkWallet',
  owner: 'owner',
  'profile-get': 'profileGet',
  'profile-save': 'profileSave',
  'profile-search': 'profileSearch',
  rpc: 'rpcProxy',
};

export default async function handler(req, res) {
  try {
    const route = req.query.route;
    const methodName = routes[route];

    if (!methodName) {
      res.statusCode = 404;
      return res.json({ ok: false, error: 'not_found' });
    }

    const app = await getApp();

    if (route === 'owner' && req.method === 'POST') {
      return await app.ownerSweep(req, res);
    }

    const endpoint = app[methodName];

    if (typeof endpoint !== 'function') {
      res.statusCode = 404;
      return res.json({ ok: false, error: 'not_found' });
    }

    return await endpoint(req, res);
  } catch (e) {
    console.error('[api-router]', e && e.message);
    res.statusCode = 500;
    return res.json({ ok: false, error: 'server_error' });
  }
}
