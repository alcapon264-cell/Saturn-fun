// Saturn copy-trading registry (COUNT ONLY). Firestore collection: copiers, document id {copierWallet}_{traderWallet}.
// A row means "this wallet, linked to this signed-in account, has copy trading switched ON for that trader". It never executes, signs or
// influences a trade (all copy execution, limits and signing stay in the browser module); it only feeds the public "N copiers" number.
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const out = (status, body) => ({ status, body });
const bad = (status, error) => out(status, { ok: false, error });

export function createCopyHandlers({ db, verifyUser, linkedWallets }) {
  const col = () => db.collection('copiers');

  async function copySet(req) {
    const user = await verifyUser(req);
    if (!user || !user.uid) return bad(401, 'sign_in_required');
    const body = (req && req.body) || {};
    if (typeof body.wallet !== 'string' || !WALLET.test(body.wallet)) return bad(400, 'invalid_wallet');
    if (typeof body.copy !== 'boolean') return bad(400, 'invalid_copy');
    const linked = ((await linkedWallets(user.uid)) || []).filter(w => typeof w === 'string' && WALLET.test(w));
    if (!linked.length) return bad(403, 'no_linked_wallet');
    let me;
    if (typeof body.from === 'string' && linked.includes(body.from)) me = body.from;
    else if (linked.length === 1) me = linked[0];
    else return bad(409, 'wallet_ambiguous');
    if (me === body.wallet) return bad(400, 'cannot_copy_self');
    const ref = db.doc('copiers/' + me + '_' + body.wallet);
    let changed = false;
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (body.copy) { if (!snap.exists) { tx.set(ref, { copier: me, trader: body.wallet, uid: user.uid, createdAt: Date.now() }); changed = true; } }
      else if (snap.exists) { tx.delete(ref); changed = true; }
    });
    return out(200, { ok: true, copying: body.copy, changed });
  }

  async function copyCount(req) {
    await verifyUser(req);
    const body = (req && req.body) || {};
    if (typeof body.wallet !== 'string' || !WALLET.test(body.wallet)) return bad(400, 'invalid_wallet');
    const q = col().where('trader', '==', body.wallet);
    let n;
    if (typeof q.count === 'function') n = (await q.count().get()).data().count;
    else n = (await q.get()).docs.length;
    return out(200, { ok: true, copiers: n });
  }

  return { copySet, copyCount };
}
