// Route table for the consolidated API dispatcher (api/[route].js). Keeps the project at 3 Vercel functions
// (this dispatcher, api/owner.js, api/irys-upload.js) instead of one function per route; URLs are unchanged (/api/<name>).
// Each entry maps the URL segment to the existing handler on the app object built in lib/app.js. No handler logic lives here.
export const ROUTES = {
  'account': 'account',
  'link-wallet': 'linkWallet',
  'link-identity': 'linkIdentity',
  'events': 'events',
  'rewards': 'rewards',
  'rpc': 'rpcProxy',
  'profile-save': 'profileSave',
  'profile-get': 'profileGet',
  'profile-search': 'profileSearch',
  'follow-set': 'followSet',
  'follow-list': 'followList',
  'follow-counts': 'followCounts',
  'copy-set': 'copySet',
  'copy-count': 'copyCount'
};

export function routeName(url) {
  try {
    const seg = new URL(url || '/', 'http://x').pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
    return Object.prototype.hasOwnProperty.call(ROUTES, seg) ? seg : null;
  } catch { return null; }
}

function fail(res, code, body) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function dispatch(getApp, req, res) {
  const name = routeName(req.url);
  if (!name) return fail(res, 404, { error: 'Not found.' });
  try {
    const app = await getApp();
    const fn = app[ROUTES[name]];
    if (typeof fn !== 'function') return fail(res, 404, { error: 'Not found.' });
    return await fn(req, res);
  } catch (e) {
    console.error('[' + name + ']', e && e.message);
    return fail(res, 500, { error: 'Server error.' });
  }
}
