/* Client hub: validation, limits, token subscriptions, coalescing and backpressure for browser WebSocket clients.
 * Browsers send only {type:'subscribe_token'|'unsubscribe_token'|'subscribe_pool'(legacy)|'ping'} with a chain key and a 0x address.
 * They can never name an RPC URL, method, or pool that has not been verified on-chain by the engine. */
import { chainKey, CHAIN_CONFIG } from './chains.js';
import { isAddr, lc } from './abi.js';

export function createHub({ engine, registry, metrics, now = Date.now, limits = {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const L = { maxTokensPerClient: 8, maxMsgPerWindow: 30, windowMs: 10000, flushMs: 100, hardBufferBytes: 1024 * 1024, softBufferBytes: 256 * 1024, slowCloseAfterMs: 15000, ...limits };
  const clients = new Set();
  let nextId = 1;

  function attach(ws, { ip = '' } = {}) {
    const c = { id: 'c' + nextId++, ws, ip, tokens: new Map(), pending: new Map(), msgTimes: [], slowSince: null, lastSeq: new Map(), closed: false, dropped: 0 };
    clients.add(c); metrics?.inc('clients_connected');
    rawSend(c, { type: 'evm_hello', v: 1, serverTime: now(), chains: Object.fromEntries(Object.values(CHAIN_CONFIG).map(x => [x.key, x.chainId])), limits: { maxTokensPerClient: L.maxTokensPerClient } });
    ws.on('message', raw => onMessage(c, raw));
    ws.on('close', () => detach(c)); ws.on('error', () => detach(c));
    c.timer = setIntervalImpl(() => flush(c), L.flushMs); c.timer.unref?.();
    return c;
  }
  function detach(c) {
    if (c.closed) return; c.closed = true; clientsDelete(c);
    clearIntervalImpl(c.timer);
    for (const [k, t] of c.tokens) engine.untrack(t.chain, t.token, c.id);
    c.tokens.clear(); c.pending.clear();
  }
  const clientsDelete = c => { clients.delete(c); };
  function rawSend(c, p) { if (c.ws.readyState === 1) { try { c.ws.send(JSON.stringify(p)); return true; } catch { return false; } } return false; }
  function rateLimited(c) { const t = now(); c.msgTimes = c.msgTimes.filter(x => t - x < L.windowMs); c.msgTimes.push(t); return c.msgTimes.length > L.maxMsgPerWindow; }
  function err(c, code, extra = {}) { metrics?.inc('client_errors'); rawSend(c, { type: 'evm_error', v: 1, code, ...extra }); }

  function onMessage(c, raw) {
    if (c.closed) return;
    if (rateLimited(c)) { metrics?.inc('client_rate_limited'); return err(c, 'rate_limited'); }
    let m; try { m = JSON.parse(raw.toString()); } catch { return err(c, 'bad_json'); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') return err(c, 'bad_message');
    if (m.type === 'ping') return void rawSend(c, { type: 'pong', t: now() });
    if (m.type === 'subscribe_token') return subscribeToken(c, m.chain, m.token);
    if (m.type === 'unsubscribe_token') { const chain = chainKey(m.chain); if (chain && isAddr(m.token)) unsubscribeToken(c, chain, lc(m.token)); return; }
    if (m.type === 'subscribe_pool') return legacyPool(c, m);
    return err(c, 'unknown_type');
  }
  function subscribeToken(c, chainIn, token) {
    const chain = chainKey(chainIn);
    if (!chain) return err(c, 'unsupported_chain');
    if (!isAddr(token)) return err(c, 'bad_token', { chain });
    token = lc(token); const key = chain + ':' + token;
    if (c.tokens.has(key)) return void ack(c, chain, token, 'already_subscribed');
    if (c.tokens.size >= L.maxTokensPerClient) return err(c, 'too_many_tokens', { chain, token });
    c.tokens.set(key, { chain, token });
    const listener = msg => deliver(c, key, msg);
    engine.track(chain, token, c.id, listener).then(r => {
      if (c.closed || !c.tokens.has(key)) return;
      ack(c, chain, token, r.status, r.reason);
    }).catch(() => err(c, 'subscribe_failed', { chain, token }));
  }
  function unsubscribeToken(c, chain, token) { const key = chain + ':' + token; if (!c.tokens.has(key)) return; c.tokens.delete(key); c.pending.delete(key); engine.untrack(chain, token, c.id); }
  const ack = (c, chain, token, status, reason = null) => rawSend(c, { type: 'evm_subscribed', v: 1, chain, chainId: CHAIN_CONFIG[chain].chainId, token, status, reason });

  /* Legacy compatibility for cached frontends that still send subscribe_pool: the pool address is ONLY a hint to find the token. It is
     verified on-chain (token0/token1 + factory) via normal token discovery, and the client receives evm_market for the non-quote token. */
  async function legacyPool(c, m) {
    const chain = chainKey(m.chain); if (!chain || !isAddr(m.address)) return err(c, 'bad_pool');
    metrics?.inc('legacy_subscribe_pool');
    err(c, 'subscribe_pool_deprecated', { chain, hint: 'use subscribe_token' });
  }

  /* Coalesce: only the LATEST message per token is kept between flushes (bursts collapse), except trade-bearing messages are summarised in `coalesced`. */
  function deliver(c, key, msg) {
    if (c.closed) return;
    if (msg.type !== 'evm_market') return void rawSend(c, msg);
    const prev = c.pending.get(key);
    if (prev && prev.seq > msg.seq) return;
    const merged = prev ? { ...msg, coalesced: (prev.coalesced || 1) + 1 } : msg;
    if (prev) metrics?.inc('coalesced_updates');
    c.pending.set(key, merged);
    if (msg.snapshot || msg.reorg) flush(c);
  }
  function flush(c) {
    if (c.closed || !c.pending.size) { checkSlow(c); return; }
    const buffered = c.ws.bufferedAmount || 0;
    if (buffered >= L.softBufferBytes) { c.dropped += c.pending.size; metrics?.inc('client_backpressure_drops', c.pending.size); c.pending.clear(); checkSlow(c, buffered); return; }
    c.slowSince = null;
    for (const [k, msg] of c.pending) { msg.sentAt = now(); if (rawSend(c, msg)) { metrics?.inc('market_messages_sent'); if (msg.timing && msg.timing.receivedAt) metrics?.observe('recv_to_send_ms', msg.sentAt - msg.timing.receivedAt); } }
    c.pending.clear();
  }
  function checkSlow(c, buffered = c.ws.bufferedAmount || 0) {
    if (buffered < L.softBufferBytes) { c.slowSince = null; return; }
    if (!c.slowSince) c.slowSince = now();
    if (buffered >= L.hardBufferBytes || now() - c.slowSince > L.slowCloseAfterMs) { metrics?.inc('client_slow_closed'); try { c.ws.close(1013, 'slow_consumer'); } catch {} detach(c); }
  }
  const broadcastStatus = payload => { for (const c of clients) rawSend(c, payload); };
  /* Block heads go only to clients that watch a token on that chain, at most once per second per chain (existing evm_head contract). */
  const headSent = new Map();
  function headFor(chain, h) {
    const t = now(); if (t - (headSent.get(chain) || 0) < 1000) return; headSent.set(chain, t);
    const msg = { type: 'evm_head', chain, chainId: CHAIN_CONFIG[chain].chainId, number: h.number || null, hash: h.hash || null, parentHash: h.parentHash || null, timestamp: h.timestamp || null, receivedAt: new Date(t).toISOString() };
    for (const c of clients) for (const x of c.tokens.values()) if (x.chain === chain) { if (c.ws.bufferedAmount < L.softBufferBytes) rawSend(c, msg); break; }
  }
  return Object.freeze({ attach, detach, onMessage, broadcastStatus, headFor, flushAll: () => clients.forEach(flush), stats: () => ({ clients: clients.size }), _clients: clients });
}
