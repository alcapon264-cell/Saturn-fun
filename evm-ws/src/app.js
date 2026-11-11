/* Wiring for the Saturn EVM market-data relay. Everything environment-specific is injected so tests can run it offline. */
import http from 'node:http';
import { CHAIN_CONFIG, CHAIN_KEYS } from './chains.js';
import { createRpc } from './rpc.js';
import { createRegistry } from './registry.js';
import { createQuoteService } from './quote.js';
import { createEngine } from './engine.js';
import { createUpstream } from './upstream.js';
import { createHub } from './hub.js';
import { createMetrics } from './metrics.js';

const CATALOG_URL = 'https://api.blockvectra.com/v1/chains';

function findEntry(payload, slug) {
  const stack = [payload], seen = new Set();
  while (stack.length) {
    const v = stack.pop(); if (!v || typeof v !== 'object' || seen.has(v)) continue; seen.add(v);
    if (Array.isArray(v)) { stack.push(...v); continue; }
    if (String(v.chain || v.slug || v.id || v.name || '').toLowerCase() === slug.toLowerCase()) return v;
    for (const x of Object.values(v)) if (x && typeof x === 'object') stack.push(x);
  }
  return null;
}
export async function loadCatalog(fetchImpl, apiKey) {
  const r = await fetchImpl(CATALOG_URL, { headers: { 'x-api-key': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('catalog_http_' + r.status);
  const payload = await r.json(); if (!Array.isArray(payload?.chains)) throw new Error('catalog_invalid_shape');
  const out = {};
  for (const k of CHAIN_KEYS) {
    const e = findEntry(payload, CHAIN_CONFIG[k].slug), subs = Array.isArray(e?.subscriptions) ? e.subscriptions : [];
    out[k] = { supported: e?.ws === true && subs.includes('newHeads'), logs: e?.ws === true && subs.includes('logs') };
  }
  return out;
}

export function createApp({ env = process.env, WebSocketImpl, WebSocketServer, fetchImpl = globalThis.fetch, now = Date.now, catalog = null, engineOpts = {}, hubLimits = {}, log = console.log } = {}) {
  const API_KEY = env.BLOCKVECTRA_API_KEY;
  const ORIGINS = new Set(String(env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  const metrics = createMetrics();
  const rpc = createRpc({ apiKey: API_KEY, fetchImpl, metrics });
  const registry = createRegistry({ rpc, metrics, now });
  const quotes = createQuoteService({ registry, fetchImpl, now, metrics, ttlMs: num(env.EVM_QUOTE_TTL_MS, 15000), minRefLiqUsd: num(env.EVM_REF_POOL_MIN_USD, 100000) });
  let engine, hub;
  const upstream = createUpstream({
    WebSocketImpl, apiKey: API_KEY, catalog: catalog || {}, metrics,
    onLog: (chain, l) => engine.onLog(chain, l),
    onHead: (chain, h) => hub && hub.headFor(chain, h),
    onUp: chain => { hub && hub.broadcastStatus({ type: 'evm_ws_status', chain, chainId: CHAIN_CONFIG[chain].chainId, connected: true, subscribed: true, logs: upstream.state[chain].logs }); return engine.onUpstreamUp(chain); },
    onDown: chain => { hub && hub.broadcastStatus({ type: 'evm_ws_status', chain, chainId: CHAIN_CONFIG[chain].chainId, connected: false, subscribed: false, logs: upstream.state[chain].logs }); engine.onUpstreamDown(chain); }
  });
  engine = createEngine({ rpc, registry, quotes, upstream, metrics, now, log: (...a) => log('[saturn-evm-ws]', ...a), opts: {
    maxTokens: num(env.EVM_MAX_TOKENS, 500), minPoolTvlUsd: num(env.EVM_MIN_POOL_TVL_USD, 1000), reconcileMs: num(env.EVM_RECONCILE_MS, 120000), maxBackfillBlocks: num(env.EVM_MAX_BACKFILL_BLOCKS, 2000), ...engineOpts } });
  hub = createHub({ engine, registry, metrics, now, limits: { maxTokensPerClient: num(env.EVM_MAX_TOKENS_PER_CLIENT, 8), ...hubLimits } });

  const ipConns = new Map(), MAX_PER_IP = num(env.EVM_MAX_CONN_PER_IP, 20);
  const safeOrigin = o => !ORIGINS.size || (o && ORIGINS.has(o));
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  const server = http.createServer((req, res) => {
    let pathname = '/'; try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch {}
    if (pathname === '/healthz' || pathname === '/') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'saturn-evm-ws', version: 2, chains: upstream.state, verification: registry.chainStatus(), engine: engine.stats(), hub: hub.stats(), metrics: metrics.snapshot() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"not_found"}');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const ip = ipOf(req);
    if (req.url !== '/live' || !safeOrigin(req.headers.origin) || (ipConns.get(ip) || 0) >= MAX_PER_IP) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, c => { ipConns.set(ip, (ipConns.get(ip) || 0) + 1); c.on('close', () => { const n = (ipConns.get(ip) || 1) - 1; n ? ipConns.set(ip, n) : ipConns.delete(ip); }); wss.emit('connection', c, req); });
  });
  wss.on('connection', (c, req) => {
    c.send(JSON.stringify({ type: 'evm_ws_snapshot', chains: upstream.state }));
    hub.attach(c, { ip: ipOf(req) });
  });
  const heartbeat = setInterval(() => upstream.ping(), 25000); heartbeat.unref?.();

  async function start({ port = Number(env.PORT || 8080), host = '0.0.0.0' } = {}) {
    if (!API_KEY) throw new Error('BLOCKVECTRA_API_KEY is required');
    const cat = catalog || await loadCatalog(fetchImpl, API_KEY);
    for (const k of CHAIN_KEYS) Object.assign(upstream.state[k], { supported: !!cat[k]?.supported, logs: !!cat[k]?.logs, lastError: cat[k]?.supported ? null : 'websocket_not_confirmed_by_catalog' });
    await new Promise(r => server.listen(port, host, r));
    log('[saturn-evm-ws] listening on ' + server.address().port);
    // Startup verification: chain id + code at each configured factory/manager, V4 StateView and wrapped-native token. Failures are visible in /healthz.
    Promise.all(CHAIN_KEYS.map(k => registry.verifyChain(k, { force: true }).then(v => log('[saturn-evm-ws] verify', k, JSON.stringify(v))))).catch(() => {});
    upstream.start(); engine.startReconcile();
    return server.address().port;
  }
  function shutdown() {
    clearInterval(heartbeat); engine.shutdown(); upstream.close();
    for (const c of wss.clients) try { c.close(1001, 'service_shutdown'); } catch {}
    return new Promise(r => server.close(() => r()));
  }
  return { server, wss, start, shutdown, parts: { rpc, registry, quotes, engine, upstream, hub, metrics } };
}
