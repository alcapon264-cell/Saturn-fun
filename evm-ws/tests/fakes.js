import { EventEmitter } from 'node:events';
/* Fake upstream WebSocket (BlockVectra stand-in) and fake browser socket. OFFLINE test doubles. */
export class FakeUpstreamWS extends EventEmitter {
  static instances = [];
  constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; this.acked = new Set(); FakeUpstreamWS.instances.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  ping() {}
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  open() { this.readyState = 1; this.emit('open'); }
  /* answer every un-acked eth_subscribe with subscription id "sub<id>" */
  ackAll() { for (const m of this.sent) if (m.method === 'eth_subscribe' && !this.acked.has(m.id)) { this.acked.add(m.id); this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 'sub' + m.id }))); } }
  subIdFor(addr) { const m = this.sent.filter(x => x.method === 'eth_subscribe' && x.params[0] === 'logs' && x.params[1].address === addr).pop(); return m && 'sub' + m.id; }
  pushLog(addr, log) { this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: this.subIdFor(addr), result: log } }))); }
  static for(slug) { return FakeUpstreamWS.instances.filter(i => i.url.includes('/' + slug + '/')).pop(); }
  static reset() { FakeUpstreamWS.instances = []; }
}
export class FakeBrowserWS extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.out = []; this.bufferedAmount = 0; this.closed = null; }
  send(s) { this.out.push(JSON.parse(s)); }
  close(code, why) { this.closed = { code, why }; this.readyState = 3; this.emit('close'); }
  recv(obj) { this.emit('message', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  of(type) { return this.out.filter(m => m.type === type); }
}
