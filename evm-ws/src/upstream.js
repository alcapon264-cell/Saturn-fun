/* One upstream BlockVectra WebSocket per chain. Subscribes to newHeads (health) and to address+topic-filtered logs for the pools the
 * engine asks for. Reconnects with jittered exponential backoff, resubscribes every pool after a reconnect, and tells the engine so it
 * can backfill the gap. The WebSocket constructor is injected so reconnect behaviour is testable without a network. */
import { CHAIN_CONFIG } from './chains.js';

export function createUpstream({ WebSocketImpl, apiKey, catalog = {}, onLog, onHead = () => {}, onUp = () => {}, onDown = () => {}, metrics = null, setTimeoutImpl = setTimeout, urlFor = (cfg, key) => `wss://api.blockvectra.com/v1/${cfg.slug}/${encodeURIComponent(key)}`, rand = Math.random, maxPoolsPerChain = 300 } = {}) {
  const chains = new Map(); // key -> {ws, ready, nextId, pending:Map, subs:Map(addr->{topics,subId,pendingId}), subIndex:Map(subId->addr), headsId, reconnects, state}
  let closed = false;
  const state = Object.fromEntries(Object.keys(CHAIN_CONFIG).map(k => [k, { supported: !!(catalog[k] && catalog[k].supported), logs: !!(catalog[k] && catalog[k].logs), connected: false, subscribed: false, lastHeadAt: null, lastBlock: null, reconnects: 0, lastError: null, lastLogAt: null }]));

  function conn(key) { let c = chains.get(key); if (!c) { c = { ws: null, nextId: 1, pending: new Map(), subs: new Map(), subIndex: new Map(), headsId: null, timer: null }; chains.set(key, c); } return c; }
  function sendSub(c, key, addr) {
    const rec = c.subs.get(addr); if (!rec || !c.ws || c.ws.readyState !== 1 || rec.subId || rec.pendingId) return;
    const id = c.nextId++; rec.pendingId = id; c.pending.set(id, { kind: 'pool', addr });
    c.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params: ['logs', { address: addr, topics: [rec.topics] }] }));
  }
  function connect(key) {
    const cfg = CHAIN_CONFIG[key], s = state[key], c = conn(key);
    if (closed || !s.supported || !apiKey) return;
    let ws; try { ws = new WebSocketImpl(urlFor(cfg, apiKey), { handshakeTimeout: 12000, perMessageDeflate: false }); } catch (e) { s.lastError = 'connect_failed'; scheduleReconnect(key); return; }
    c.ws = ws; c.pending.clear(); c.subIndex.clear(); c.headsId = null; c.nextId = 1;
    for (const rec of c.subs.values()) { rec.subId = null; rec.pendingId = null; }
    let everOpen = false;
    ws.on('open', () => {
      everOpen = true; s.connected = true; s.lastError = null;
      const id = c.nextId++; c.pending.set(id, { kind: 'heads' });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params: ['newHeads'] }));
      if (s.logs) for (const addr of c.subs.keys()) sendSub(c, key, addr);
    });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { metrics?.inc('upstream_bad_json'); return; }
      if (!m || typeof m !== 'object') return;
      if (m.id != null) {
        const p = c.pending.get(m.id); if (!p) return; c.pending.delete(m.id);
        if (p.kind === 'heads') { if (typeof m.result === 'string') {
          c.headsId = m.result; s.subscribed = true;
          // Report readiness only after the provider confirms the newHeads subscription.
          Promise.resolve(onUp(key)).catch(() => {});
        } else { s.subscribed = false; s.lastError = 'newHeads_subscription_rejected'; } }
        else if (p.kind === 'pool') {
          const rec = c.subs.get(p.addr); if (!rec) { if (typeof m.result === 'string') ws.send(JSON.stringify({ jsonrpc: '2.0', id: c.nextId++, method: 'eth_unsubscribe', params: [m.result] })); return; }
          rec.pendingId = null;
          if (typeof m.result === 'string') { rec.subId = m.result; c.subIndex.set(m.result, p.addr); } else { s.lastError = 'pool_logs_subscription_rejected'; metrics?.inc('upstream_sub_rejected'); }
        }
        return;
      }
      if (m.method !== 'eth_subscription' || !m.params || !m.params.result) return;
      const sid = m.params.subscription, result = m.params.result;
      if (sid === c.headsId) { s.lastHeadAt = new Date().toISOString(); s.lastBlock = result.number || null; onHead(key, result); return; }
      if (c.subIndex.has(sid)) { s.lastLogAt = Date.now(); try { onLog(key, result); } catch { metrics?.inc('log_handler_errors'); } }
    });
    ws.on('error', e => { s.lastError = String((e && e.message) || 'upstream_error').slice(0, 120); });
    ws.on('close', () => {
      if (c.ws !== ws) return;
      s.connected = false; s.subscribed = false; c.ws = null; c.subIndex.clear();
      for (const rec of c.subs.values()) { rec.subId = null; rec.pendingId = null; }
      try { onDown(key); } catch {}
      if (!closed) { s.reconnects++; metrics?.inc('upstream_reconnects'); scheduleReconnect(key); }
    });
  }
  function scheduleReconnect(key) {
    const s = state[key], c = conn(key); if (closed || c.timer) return;
    const cap = Math.min(20000, 500 * Math.pow(2, Math.min(s.reconnects, 6)));
    c.timer = setTimeoutImpl(() => { c.timer = null; connect(key); }, Math.floor(rand() * cap));
    c.timer && c.timer.unref && c.timer.unref();
  }
  function subscribeLogs(key, addr, topics) {
    const s = state[key]; if (!s || !s.logs) return false;
    const c = conn(key);
    if (c.subs.size >= maxPoolsPerChain && !c.subs.has(addr)) { metrics?.inc('upstream_pool_cap'); return false; }
    if (!c.subs.has(addr)) c.subs.set(addr, { topics, subId: null, pendingId: null });
    sendSub(c, key, addr); return true;
  }
  function unsubscribeLogs(key, addr) {
    const c = conn(key), rec = c.subs.get(addr); if (!rec) return;
    c.subs.delete(addr);
    if (rec.subId) { c.subIndex.delete(rec.subId); if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: c.nextId++, method: 'eth_unsubscribe', params: [rec.subId] })); }
  }
  const start = () => { for (const k of Object.keys(CHAIN_CONFIG)) connect(k); };
  function ping() { for (const [k, c] of chains) if (c.ws && c.ws.readyState === 1) { try { c.ws.ping(); } catch { state[k].lastError = 'heartbeat_failed'; } } }
  function close() { closed = true; for (const c of chains.values()) { if (c.timer) clearTimeout(c.timer); try { c.ws && c.ws.close(1001, 'service_shutdown'); } catch {} } }
  return Object.freeze({ start, subscribeLogs, unsubscribeLogs, ping, close, state, _chains: chains, connect });
}
