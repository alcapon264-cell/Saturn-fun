import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/registry.js';
import { CHAIN_CONFIG } from '../src/chains.js';

/* RPC double: eth_chainId always answers; eth_getCode answers with code, or fails (rate limit) when `fail` is on. */
function rpcDouble(chain) {
  const st = { fail: false, failChainId: false, calls: 0 };
  const rpc = {
    async call(c, m) { if (m === 'eth_chainId') { if (st.failChainId) throw new Error('429'); return '0x' + CHAIN_CONFIG[c].chainId.toString(16); } throw new Error('unexpected ' + m); },
    async batch(c, reqs) { st.calls++; return reqs.map(() => st.fail ? { ok: false, error: 'rate limited' } : { ok: true, result: '0x6080604052' }); },
  };
  return { rpc, st };
}

test('a transient eth_getCode failure after a good check does NOT switch the chain off (was: wrapped_native_missing for 60 s)', async () => {
  let t = 0; const { rpc, st } = rpcDouble('eth');
  const R = createRegistry({ rpc, now: () => t, chainVerifyTtlMs: 1000 });
  const a = await R.verifyChain('eth'); assert.equal(a.ok, true);
  st.fail = true; t += 5000;
  const b = await R.verifyChain('eth'); assert.equal(b.ok, true); assert.notEqual(b.reason, 'wrapped_native_missing');
});

test('code once seen is remembered: later checks do not re-ask for it', async () => {
  let t = 0; const { rpc, st } = rpcDouble('base');
  const R = createRegistry({ rpc, now: () => t, chainVerifyTtlMs: 1000 });
  await R.verifyChain('base'); const n = st.calls; t += 5000; await R.verifyChain('base');
  assert.equal(st.calls, n);
});

test('eth_chainId failing after a good check keeps the last good state', async () => {
  let t = 0; const { rpc, st } = rpcDouble('arb');
  const R = createRegistry({ rpc, now: () => t, chainVerifyTtlMs: 1000 });
  assert.equal((await R.verifyChain('arb')).ok, true);
  st.failChainId = true; t += 5000;
  assert.equal((await R.verifyChain('arb')).ok, true);
});

test('first check failing is reported as rpc_unreachable, not as a missing contract', async () => {
  const { rpc, st } = rpcDouble('bsc'); st.fail = true;
  const R = createRegistry({ rpc, now: () => 0 });
  const v = await R.verifyChain('bsc'); assert.equal(v.ok, false); assert.equal(v.reason, 'rpc_unreachable');
});

test('a successful answer of EMPTY code still disables the chain (real misconfiguration is still caught)', async () => {
  const rpc = { async call(c) { return '0x' + CHAIN_CONFIG[c].chainId.toString(16); }, async batch(c, reqs) { return reqs.map(() => ({ ok: true, result: '0x' })); } };
  const R = createRegistry({ rpc, now: () => 0 });
  const v = await R.verifyChain('eth'); assert.equal(v.ok, false); assert.equal(v.reason, 'wrapped_native_missing');
});
