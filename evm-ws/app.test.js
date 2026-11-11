/* OFFLINE integration: real `ws` server + real browser-side `ws` client, fake BlockVectra upstream and mocked HTTP RPC. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../src/app.js';
import { CHAIN_CONFIG } from '../src/chains.js';
import { createWorld, addr, buildPool, makeFetch, LOW, v3SwapLog, sqrtPFromHumanPrice, until, tick } from './helpers.js';
import { FakeUpstreamWS } from './fakes.js';

const KEY = 'secret-key-should-never-leak';
/* HTTP JSON-RPC shim over the in-memory world (supports single and batch requests) */
function fetchFor(world, chain = 'arb') {
  return async (url, opts) => {
    assert.equal(opts.headers['x-api-key'], KEY, 'API key travels only server -> provider');
    const b = JSON.parse(opts.body);
    const run = async r => { try { return { jsonrpc: '2.0', id: r.id, result: await world.rpc.call(chain, r.method, r.params) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { message: e.message } }; } };
    return { ok: true, status: 200, json: async () => Array.isArray(b) ? Promise.all(b.map(run)) : run(b) };
  };
}
async function start(extra = {}) {
  FakeUpstreamWS.reset();
  const world = createWorld(); world.deployConfig('arb');
  const USDC = Object.keys(CHAIN_CONFIG.arb.stables)[0], pool = addr(0x8001);
  buildPool(world, 'arb', { protocolId: 'uniswap_v3', pool, token: LOW, quote: USDC, price: 0.02, quoteDec: 6, tokenBal: 3_000_000 });
  const catalog = { arb: { supported: true, logs: true } };
  const app = createApp({ env: { BLOCKVECTRA_API_KEY: KEY, EVM_RECONCILE_MS: '0', ALLOWED_ORIGINS: 'https://saturn.test', ...extra }, WebSocketImpl: FakeUpstreamWS, WebSocketServer, fetchImpl: fetchFor(world), catalog: { ...Object.fromEntries(Object.keys(CHAIN_CONFIG).map(k => [k, { supported: false, logs: false }])), ...catalog }, log: () => {} });
  const port = await app.start({ port: 0, host: '127.0.0.1' });
  return { app, world, pool, port, up: FakeUpstreamWS.for('arb_mainnet') };
}
const connect = (port, origin = 'https://saturn.test') => new Promise((res, rej) => { const ws = new WebSocket('ws://127.0.0.1:' + port + '/live', { headers: origin ? { origin } : {} }); ws.inbox = []; ws.on('message', d => ws.inbox.push(JSON.parse(d.toString()))); ws.on('open', () => res(ws)); ws.on('error', rej); });

test('end to end: browser subscribes by token, a swap on the (fake) chain arrives as a priced evm_market update', async () => {
  const S = await start(), ws = await connect(S.port);
  try {
    assert.ok(await until(() => ws.inbox.find(m => m.type === 'evm_ws_snapshot')) && await until(() => ws.inbox.find(m => m.type === 'evm_hello')));
    S.up.open(); S.up.ackAll();
    ws.send(JSON.stringify({ type: 'subscribe_token', chain: 'arb', token: LOW }));
    const ack = await until(() => ws.inbox.find(m => m.type === 'evm_subscribed')); assert.equal(ack.status, 'live');
    const snap = await until(() => ws.inbox.find(m => m.type === 'evm_market' && m.snapshot)); assert.ok(Math.abs(snap.priceUsd - 0.02) < 1e-6);
    S.up.ackAll(); assert.ok(S.up.subIdFor(S.pool), 'relay subscribed upstream to the verified pool, not to anything the browser named');
    ws.inbox.length = 0;
    S.up.pushLog(S.pool, v3SwapLog({ pool: S.pool, block: 1500, logIndex: 2, amount0: -(10n ** 18n), amount1: 25_000n, sqrtP: sqrtPFromHumanPrice(0.025, 18, 6) }));
    const upd = await until(() => ws.inbox.find(m => m.type === 'evm_market'));
    assert.equal(upd.trigger, 'swap'); assert.ok(Math.abs(upd.priceUsd - 0.025) < 1e-6); assert.equal(upd.token, LOW); assert.equal(upd.mcKind, 'fdv');
    assert.ok(upd.timing.serverMs >= 0 && upd.sentAt >= upd.timing.receivedAt);
    // reconnect scenario: upstream drops while the swap that happens in the gap is only visible through getLogs
    const gapLog = v3SwapLog({ pool: S.pool, block: 1503, logIndex: 0, tx: 31337, amount0: -(10n ** 18n), amount1: 30_000n, sqrtP: sqrtPFromHumanPrice(0.03, 18, 6) });
    S.world.pushLog('arb', gapLog); S.world.ch('arb').block = 1504; S.world.setV3Price('arb', S.pool, sqrtPFromHumanPrice(0.03, 18, 6));
    ws.inbox.length = 0; S.up.close(); await until(() => ws.inbox.find(m => m.type === 'evm_token_status' && m.status === 'degraded'));
    // the manager schedules a real timer; trigger the same path the timer would
    S.app.parts.upstream.connect('arb'); const ws2 = FakeUpstreamWS.for('arb_mainnet'); ws2.open(); ws2.ackAll();
    const rec = await until(() => ws.inbox.find(m => m.type === 'evm_market' && m.trigger === 'recovered')); assert.ok(Math.abs(rec.priceUsd - 0.03) < 1e-6);
    assert.ok(ws2.sent.some(m => m.params && m.params[0] === 'logs' && m.params[1].address === S.pool), 'pool resubscribed after reconnect');
    // healthz: observable, and never contains the API key
    const h = await fetch('http://127.0.0.1:' + S.port + '/healthz').then(r => r.text()); assert.ok(!h.includes(KEY)); const j = JSON.parse(h);
    assert.equal(j.engine.tokens, 1); assert.ok(j.metrics.counters.market_updates >= 3); assert.ok(j.metrics.latencyMs.server_total_ms.n >= 1);
  } finally { ws.close(); await S.app.shutdown(); }
});
test('server hardening: wrong origin and wrong path are refused; oversize frames and per-IP flood are bounded', async () => {
  const S = await start({ EVM_MAX_CONN_PER_IP: '2' });
  try {
    await assert.rejects(connect(S.port, 'https://evil.example')); await assert.rejects(connect(S.port, null));
    const a = await connect(S.port), b = await connect(S.port); await assert.rejects(connect(S.port), 'third connection from the same IP is refused');
    const closed = new Promise(r => a.on('close', c => r(c))); a.send('x'.repeat(10000)); assert.equal(await closed, 1009, 'oversize frame closes the socket (maxPayload)');
    b.close();
    const r = await fetch('http://127.0.0.1:' + S.port + '/nope'); assert.equal(r.status, 404);
  } finally { await S.app.shutdown(); }
});
