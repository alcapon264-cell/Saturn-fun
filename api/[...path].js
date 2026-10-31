import { getApp } from '../lib/deps.js';

const ROUTES = Object.freeze({
  account: 'account',
  'community-delete': 'communityDelete',
  'community-post': 'communityPost',
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
});

function routeName(req) {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const match = /^\/api\/([^/]+)\/?$/.exec(pathname);
  return match ? match[1] : null;
}

export default async function handler(req, res) {
  const route = routeName(req);
  const method = route && ROUTES[route];

  if (!method) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    return res.end('{"error":"Not found."}');
  }

  try {
    const app = await getApp();
    if (route === 'owner' && req.method === 'POST') {
      return await app.ownerSweep(req, res);
    }
    return await app[method](req, res);
  } catch (e) {
    console.error('[api-' + route + ']', e && e.message);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end('{"error":"Server error."}');
  }
}
