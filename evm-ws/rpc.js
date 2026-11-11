/* Server-side JSON-RPC over HTTPS (BlockVectra). The API key never leaves this process; callers can only use the fixed read-only
 * method allowlist below, and only for a chain key from CHAIN_CONFIG. */
import { CHAIN_CONFIG } from './chains.js';
import { HASH_RE } from './abi.js';

const ALLOW = new Set(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getCode', 'eth_getLogs']);
const BASE = 'https://api.blockvectra.com/v1/';

export function createRpc({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 8000, baseUrl = BASE, metrics = null } = {}) {
  let id = 0;
  async function post(chain, body) {
    const cfg = CHAIN_CONFIG[chain];
    if (!cfg) throw new Error('unknown_chain');
    if (!apiKey) throw new Error('rpc_not_configured');
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      metrics?.inc('rpc_requests');
      const r = await fetchImpl(baseUrl + cfg.slug, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify(body), signal: ac.signal });
      if (!r.ok) throw new Error('rpc_http_' + r.status);
      return await r.json();
    } catch (e) { metrics?.inc('rpc_errors'); throw e; } finally { clearTimeout(t); }
  }
  function check(method) { if (!ALLOW.has(method)) throw new Error('rpc_method_not_allowed'); }
  async function call(chain, method, params = []) {
    check(method);
    const p = await post(chain, { jsonrpc: '2.0', id: ++id, method, params });
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('rpc_invalid_response');
    if (p.error) throw new Error('rpc_json_error');
    return p.result;
  }
  /* One HTTP request for many calls. Falls back to parallel single calls if the provider does not answer a batch with an array. */
  async function batch(chain, calls) {
    if (!calls.length) return [];
    calls.forEach(c => check(c.method));
    if (calls.length > 100) throw new Error('rpc_batch_too_large');
    const base = id; id += calls.length;
    const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: base + i + 1, method: c.method, params: c.params || [] }));
    let res;
    try { res = await post(chain, body); } catch (e) { res = null; }
    if (Array.isArray(res) && res.length === calls.length) {
      const byId = new Map(res.map(r => [r && r.id, r]));
      return body.map(b => { const r = byId.get(b.id); return r && !r.error && r.result !== undefined ? { ok: true, result: r.result } : { ok: false, error: 'rpc_json_error' }; });
    }
    return Promise.all(calls.map(c => call(chain, c.method, c.params).then(result => ({ ok: true, result }), () => ({ ok: false, error: 'rpc_failed' }))));
  }
  const ethCall = (chain, to, data) => call(chain, 'eth_call', [{ to, data }, 'latest']);
  const blockNumber = async chain => Number(BigInt(await call(chain, 'eth_blockNumber')));
  async function getLogs(chain, { address, topics, fromBlock, toBlock }) {
    const hex = n => '0x' + n.toString(16);
    const logs = await call(chain, 'eth_getLogs', [{ address, topics, fromBlock: hex(fromBlock), toBlock: hex(toBlock) }]);
    if (!Array.isArray(logs)) throw new Error('rpc_invalid_logs');
    return logs.filter(l => l && HASH_RE.test(l.blockHash || '') && HASH_RE.test(l.transactionHash || ''));
  }
  return Object.freeze({ call, batch, ethCall, blockNumber, getLogs });
}
