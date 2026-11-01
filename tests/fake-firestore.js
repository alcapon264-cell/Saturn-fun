// TEST-ONLY Firestore-shaped fake (enforces: all reads before writes inside a transaction; transactions run one at a time). Not real Firestore.
// Supports: documents by path, collection().doc(), where ==, >=, <, array-contains, limit, orderBy (no-op), collectionGroup(), delete().
export function fakeFirestore() {
  const docs = new Map(); let chain = Promise.resolve(); const stats = { queries: 0, maxReturned: 0 };
  const ref = path => ({ path,
    async get() { const v = docs.get(path); return { exists: v !== undefined, id: path.split('/').pop(), data: () => structuredClone(v) }; },
    async set(d, o) { docs.set(path, o && o.merge ? { ...(docs.get(path) || {}), ...structuredClone(d) } : structuredClone(d)); },
    async create(d) { if (docs.has(path)) { const e = new Error('exists'); e.code = 6; throw e; } docs.set(path, structuredClone(d)); },
    async delete() { docs.delete(path); },
    collection: n => fs.collection(path + '/' + n) });
  const match = (v, f) => f.every(([fl, op, x]) => op === '>=' ? v[fl] >= x : op === '<' ? v[fl] < x : op === '==' ? v[fl] === x : op === 'array-contains' ? Array.isArray(v[fl]) && v[fl].includes(x) : false);
  const query = select => { const f = []; let lim = Infinity; const q = {
    doc: id => ref(select.base + '/' + id),
    where(field, op, v) { f.push([field, op, v]); return q; }, limit(n) { lim = n; return q; }, orderBy() { return q; },
    async get() { stats.queries++;
      const rows = select.paths().filter(([, v]) => match(v, f)).slice(0, lim); stats.maxReturned = Math.max(stats.maxReturned, rows.length);
      return { size: rows.length, docs: rows.map(([path, v]) => ({ id: path.split('/').pop(), ref: ref(path), data: () => structuredClone(v) })) }; } }; return q; };
  const fs = { docs, stats, doc: ref, failCollectionGroup: false,
    runTransaction(fn) { const run = chain.then(async () => { let wrote = false; const pend = [];
        const t = { async get(r) { if (wrote) throw new Error('Firestore: all reads must come before writes'); return r.get(); },
          set(r, d) { wrote = true; pend.push(() => docs.set(r.path, structuredClone(d))); }, create(r, d) { wrote = true; pend.push(() => { if (docs.has(r.path)) throw new Error('exists'); docs.set(r.path, structuredClone(d)); }); },
          delete(r) { wrote = true; pend.push(() => docs.delete(r.path)); } };
        const out = await fn(t); pend.forEach(f => f()); return out; }); chain = run.catch(() => {}); return run; },
    collection(c) { return query({ base: c, paths: () => [...docs].filter(([k]) => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/')) }); },
    collectionGroup(name) { if (fs.failCollectionGroup) throw new Error('FAILED_PRECONDITION: missing collection-group index');
      return query({ base: name, paths: () => [...docs].filter(([k]) => { const p = k.split('/'); return p.length >= 2 && p.length % 2 === 0 && p[p.length - 2] === name; }) }); } };
  return fs;
}
