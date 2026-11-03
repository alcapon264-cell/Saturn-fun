// Targeted user reports (token / user / community message) with optional image evidence.
// New, additive route: POST /api/report. Writes to the SAME `reports` collection the Settings problem-report uses, so the admin
// dashboard shows both. The public Saturn HTML does not call this route yet (a later, separately approved frontend change).
import crypto from 'node:crypto';

export const TARGET_TYPES = ['token', 'user', 'message', 'other'];
export const REPORT_CATEGORIES_V2 = ['spam', 'scam', 'rug', 'impersonation', 'harassment', 'abuse', 'copyright', 'trading', 'other'];
export const LIMITS = { min: 10, max: 2000, images: 3, imgChars: 180000, gapMs: 30000 };
const IMG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (v, max) => typeof v === 'string' ? v.normalize('NFC').replace(CTRL, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max) : '';

export function createReports({ db, store, now = () => Date.now() }) {
  const bad = (status, error) => ({ status, body: { ok: false, error } });
  async function submit(user, b) {
    if (!user || !user.uid) return bad(401, 'sign_in_required');
    if (!TARGET_TYPES.includes(b.targetType)) return bad(400, 'invalid_target_type');
    if (!REPORT_CATEGORIES_V2.includes(b.category)) return bad(400, 'invalid_category');
    if (typeof b.message !== 'string' || b.message.length > LIMITS.max * 4) return bad(400, 'message_too_long');
    const message = clean(b.message, LIMITS.max + 1);
    if (message.length < LIMITS.min) return bad(400, 'message_too_short');
    if (message.length > LIMITS.max) return bad(400, 'message_too_long');
    const rec = { uid: user.uid, category: b.category, message, targetType: b.targetType, status: 'new', notes: [], history: [] };
    if (b.mint != null && b.mint !== '') { if (typeof b.mint !== 'string' || !MINT_RE.test(b.mint)) return bad(400, 'invalid_mint'); rec.mint = b.mint; }
    if (b.signature != null && b.signature !== '') { if (typeof b.signature !== 'string' || !SIG_RE.test(b.signature)) return bad(400, 'invalid_signature'); rec.signature = b.signature; }
    if (b.targetWallet != null && b.targetWallet !== '') {
      if (typeof b.targetWallet !== 'string' || !MINT_RE.test(b.targetWallet)) return bad(400, 'invalid_wallet');
      rec.targetWallet = b.targetWallet;
      const l = await store.get('walletLinks/' + b.targetWallet);
      if (l && typeof l.uid === 'string') rec.targetUid = l.uid;
    }
    if (b.targetType === 'message') {
      if (typeof b.room !== 'string' || !ROOM_RE.test(b.room) || typeof b.messageId !== 'string' || !MID_RE.test(b.messageId)) return bad(400, 'invalid_message_target');
      rec.room = b.room; rec.messageId = b.messageId;
    }
    if (b.targetType === 'token' && !rec.mint) return bad(400, 'mint_required');
    if (b.targetType === 'user' && !rec.targetWallet && !b.targetUid) return bad(400, 'user_target_required');
    if (b.targetUid != null && b.targetUid !== '') { if (typeof b.targetUid !== 'string' || !/^[A-Za-z0-9:_.-]{3,128}$/.test(b.targetUid)) return bad(400, 'invalid_target_uid'); rec.targetUid = rec.targetUid || b.targetUid; }
    if (rec.targetUid && rec.targetUid === user.uid) return bad(400, 'cannot_report_self');
    const ev = b.evidence == null ? [] : b.evidence;
    if (!Array.isArray(ev) || ev.length > LIMITS.images) return bad(400, 'too_many_images');
    for (const i of ev) if (typeof i !== 'string' || i.length > LIMITS.imgChars || !IMG_RE.test(i)) return bad(400, 'invalid_image');
    rec.evidence = ev;
    const t = now(), id = crypto.createHash('sha256').update(user.uid + ':' + t + ':' + crypto.randomBytes(8).toString('hex')).digest('hex').slice(0, 24);
    rec.createdAt = t;
    const rl = db.collection('reportUsers').doc(String(user.uid).replace(/\//g, '_'));
    let limited = false;
    await db.runTransaction(async tx => {
      const s = await tx.get(rl), last = s.exists ? Number(s.data().lastAt) || 0 : 0;
      if (t - last < LIMITS.gapMs) { limited = true; return; }
      tx.set(rl, { lastAt: t });
      tx.create(db.collection('reports').doc(id), rec);
    });
    if (limited) return bad(429, 'too_fast');
    return { status: 200, body: { ok: true, id } };
  }
  return { submit };
}
