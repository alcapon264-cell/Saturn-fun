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

const state = Object.fromEntries(Object.keys(CHAINS).map(k => [k, {
  supported: false, connected: false, subscribed: false, lastHeadAt: null,
  lastBlock: null, reconnects: 0, lastError: null
}]));
const clients = new Set();
const upstreams = new Map();
let shuttingDown = false;

function send(client, payload) {
  if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 256 * 1024) {
    client.send(JSON.stringify(payload));
  }
}
function broadcast(payload) {
  for (const client of clients) send(client, payload);
}
function safeOrigin(origin) {
  return !ORIGINS.size || (origin && ORIGINS.has(origin));
}

function findChainEntry(payload, slug) {
  const seen = new Set();
  const stack = [payload];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { stack.push(...value); continue; }
    const id = value.slug ?? value.name ?? value.chain ?? value.id;
    if (String(id || '').toLowerCase() === slug.toLowerCase()) return value;
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
  }
  return null;
}

async function loadCatalog() {
  const response = await fetch(CATALOG_URL, {
    headers: { 'x-api-key': API_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`catalog_http_${response.status}`);
  const payload = await response.json();
  for (const [key, chain] of Object.entries(CHAINS)) {
    const entry = findChainEntry(payload, chain.slug);
    const subs = Array.isArray(entry?.subscriptions) ? entry.subscriptions : [];
    state[key].supported = entry?.ws === true && subs.includes('newHeads');
    state[key].lastError = state[key].supported ? null : 'websocket_not_confirmed_by_catalog';
  }
}

function connectChain(key, chain) {
  if (shuttingDown) return;
  const s = state[key];
  if (!s.supported || !API_KEY) return;
  const url = `wss://api.blockvectra.com/v1/${chain.slug}/${encodeURIComponent(API_KEY)}`;
  const ws = new WebSocket(url, { handshakeTimeout: 12000, perMessageDeflate: false });
  upstreams.set(key, ws);
  let subscribed = false;
  let requestId = 1;
  let retryTimer;

  ws.on('open', () => {
    s.connected = true;
    s.lastError = null;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'eth_subscribe', params: ['newHeads'] }));
  });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id === requestId) {
      if (msg.result && typeof msg.result === 'string') {
        subscribed = true;
        s.subscribed = true;
        broadcast({ type: 'evm_ws_status', chain: key, chainId: chain.chainId, connected: true, subscribed: true });
      } else {
        s.lastError = 'subscription_rejected';
        ws.close();
      }
      return;
    }
    if (msg.method !== 'eth_subscription' || !msg.params?.result) return;
    const head = msg.params.result;
    s.lastHeadAt = new Date().toISOString();
    s.lastBlock = head.number || null;
    broadcast({
      type: 'evm_head', chain: key, chainId: chain.chainId,
      number: head.number || null, hash: head.hash || null,
      parentHash: head.parentHash || null, timestamp: head.timestamp || null,
      receivedAt: s.lastHeadAt
    });
  });
  ws.on('error', err => { s.lastError = String(err?.message || 'upstream_error').slice(0, 120); });
  ws.on('close', () => {
    s.connected = false;
    s.subscribed = false;
    if (upstreams.get(key) === ws) upstreams.delete(key);
    broadcast({ type: 'evm_ws_status', chain: key, chainId: chain.chainId, connected: false, subscribed: false });
    if (shuttingDown) return;
    s.reconnects += 1;
    const cap = Math.min(60000, 1000 * (2 ** Math.min(s.reconnects, 6)));
    const delay = Math.floor(Math.random() * cap);
    retryTimer = setTimeout(() => connectChain(key, chain), delay);
    retryTimer.unref?.();
  });
  ws.on('pong', () => { /* upstream liveness acknowledged */ });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'saturn-evm-ws', chains: state }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"ok":false,"error":"not_found"}');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (req.url !== '/live' || !safeOrigin(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
});
wss.on('connection', client => {
  clients.add(client);
  send(client, { type: 'evm_ws_snapshot', chains: state });
  client.on('close', () => clients.delete(client));
  client.on('error', () => clients.delete(client));
  // This relay is intentionally read-only; clients cannot submit arbitrary RPC or filters.
});

const heartbeat = setInterval(() => {
  for (const [key, ws] of upstreams) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch { state[key].lastError = 'heartbeat_failed'; }
    }
  }
}, 25000);
heartbeat.unref?.();

async function start() {
  if (!API_KEY) throw new Error('BLOCKVECTRA_API_KEY is required');
  await loadCatalog();
  server.listen(PORT, '0.0.0.0', () => console.log(`[saturn-evm-ws] listening on ${PORT}`));
  for (const [key, chain] of Object.entries(CHAINS)) if (state[key].supported) connectChain(key, chain);
}
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  for (const ws of upstreams.values()) { try { ws.close(1001, 'service_shutdown'); } catch {} }
  for (const client of clients) { try { client.close(1001, 'service_shutdown'); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
start().catch(err => { console.error('[saturn-evm-ws] startup_failed:', err.message); process.exit(1); });
