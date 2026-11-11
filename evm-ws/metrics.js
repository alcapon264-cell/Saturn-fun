/* Counters + bounded latency histograms (ring buffers). Nothing here is a benchmark: values are measured at runtime and reported by /healthz. */
export function createMetrics({ ringSize = 500 } = {}) {
  const counters = Object.create(null), rings = Object.create(null);
  const inc = (k, n = 1) => { counters[k] = (counters[k] || 0) + n; };
  const observe = (k, ms) => { if (!Number.isFinite(ms)) return; const r = rings[k] || (rings[k] = { a: [], i: 0 }); if (r.a.length < ringSize) r.a.push(ms); else { r.a[r.i] = ms; r.i = (r.i + 1) % ringSize; } };
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3) : null; };
  const snapshot = () => ({
    counters: { ...counters },
    latencyMs: Object.fromEntries(Object.entries(rings).map(([k, r]) => [k, { n: r.a.length, p50: pct(r.a, .5), p95: pct(r.a, .95), max: Math.max(...r.a) }]))
  });
  return Object.freeze({ inc, observe, snapshot });
}
