#!/usr/bin/env node
/* LIVE RPC CHECK - the only part of this package that talks to real chains. It was NOT run during development (the build sandbox had no network).
 * Run it once from a machine that has the key BEFORE trusting any chain as "supported":
 *   BLOCKVECTRA_API_KEY=... node scripts/live-check.mjs [chain:0xTokenAddress ...]
 * It is read-only (eth_chainId, eth_getCode, eth_call, eth_blockNumber) and never sends a transaction. */
import { CHAIN_CONFIG, CHAIN_KEYS } from '../src/chains.js';
import { createRpc } from '../src/rpc.js';
import { createRegistry } from '../src/registry.js';
import { createQuoteService } from '../src/quote.js';
import { createMetrics } from '../src/metrics.js';

const key = process.env.BLOCKVECTRA_API_KEY;
if (!key) { console.error('BLOCKVECTRA_API_KEY is required'); process.exit(2); }
const metrics = createMetrics(), rpc = createRpc({ apiKey: key, metrics }), registry = createRegistry({ rpc, metrics }), quotes = createQuoteService({ registry, metrics });
let failed = 0; const row = (ok, ...a) => { if (!ok) failed++; console.log(ok ? 'PASS' : 'FAIL', ...a); };

for (const k of CHAIN_KEYS) {
  const cfg = CHAIN_CONFIG[k];
  const v = await registry.verifyChain(k, { force: true });
  row(v.ok, k, 'chainId', cfg.chainId, 'rpc+factories', JSON.stringify({ ok: v.ok, reason: v.reason, enabled: v.protocols, disabled: v.disabled }));
  if (!v.ok) continue;
  try { const n = await rpc.blockNumber(k); row(n > 0, k, 'head block', n); } catch (e) { row(false, k, 'blockNumber', e.message); }
  const q = await quotes.get(k, cfg.native.wrapped);
  row(!!q, k, 'native quote USD', q ? `${q.usd} via ${q.basis} (${q.source})` : 'unavailable');
}
for (const arg of process.argv.slice(2)) {
  const [chain, token] = arg.split(':');
  if (!CHAIN_CONFIG[chain] || !/^0x[0-9a-fA-F]{40}$/.test(token || '')) { row(false, 'bad argument', arg); continue; }
  const found = [];
  for (const qa of [...Object.keys(CHAIN_CONFIG[chain].stables), CHAIN_CONFIG[chain].native.wrapped]) { try { found.push(...await registry.findPools(chain, token, qa)); } catch (e) { /* reported below */ } }
  row(found.length > 0, chain, token, 'verified pools:', found.map(p => `${p.protocol}:${p.address} tvlQuote=${p.tvlQuote.toFixed(2)} price=${p.state.price}`).join(' | ') || 'none');
  try { const s = await registry.totalSupplyOf(chain, token); row(true, chain, token, 'totalSupply', s.supply); } catch (e) { row(false, chain, token, 'totalSupply', e.message); }
}
console.log(JSON.stringify(metrics.snapshot().counters));
process.exit(failed ? 1 : 0);
