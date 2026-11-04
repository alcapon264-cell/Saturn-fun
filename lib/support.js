// Saturn customer support conversations. All access is authenticated; Firestore Admin SDK only.
import crypto from 'node:crypto';

const clean = (v, n) => typeof v === 'string'
  ? v.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim().slice(0, n)
  : '';
const ID = /^[A-Za-z0-9_-]{12,64}$/;

export function createSupport({ db, now = () => Date.now() }) {
  const tickets = db.collection('supportTickets');
  const bad = (status, error) => ({ status, body: { ok: false, error } });
  const ok = body => ({ status: 200, body: { ok: true, ...body } });

  async function open(user, b) {
    const subject = clean(b.subject, 120);
    const text = clean(b.message, 4000);
    const category = clean(b.category, 40) || 'general';
    if (subject.length < 3 || text.length < 2) return bad(400, 'subject_and_message_required');
    const id = crypto.randomBytes(18).toString('base64url');
    const t = now();
    const ref = tickets.doc(id);
    await ref.create({
      uid: user.uid, email: clean(user.email, 180) || null,
      subject, category, status: 'open', createdAt: t, updatedAt: t,
      lastMessageAt: t, lastMessagePreview: text.slice(0, 160),
      unreadForAgent: true, unreadForUser: false
    });
    await ref.collection('messages').doc(String(t) + '_customer').create({
      senderUid: user.uid, senderRole: 'customer', text, createdAt: t
    });
    return ok({ ticket: { id, subject, category, status: 'open', createdAt: t }, message: { text, createdAt: t, senderRole: 'customer' } });
  }

  async function list(user) {
    const snap = await tickets.where('uid', '==', user.uid).limit(50).get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    return ok({ tickets: items });
  }

  async function history(user, b) {
    const id = clean(b.ticketId, 64);
    if (!ID.test(id)) return bad(400, 'invalid_ticket_id');
    const ref = tickets.doc(id), snap = await ref.get();
    if (!snap.exists || snap.data().uid !== user.uid) return bad(404, 'ticket_not_found');
    const ms = await ref.collection('messages').orderBy('createdAt', 'asc').limit(200).get();
    await ref.set({ unreadForUser: false }, { merge: true });
    return ok({ ticket: { id, ...snap.data() }, messages: ms.docs.map(d => ({ id: d.id, ...d.data() })) });
  }

  async function send(user, b) {
    const id = clean(b.ticketId, 64), text = clean(b.text, 4000);
    if (!ID.test(id) || text.length < 1) return bad(400, 'invalid_message');
    const ref = tickets.doc(id), snap = await ref.get();
    if (!snap.exists || snap.data().uid !== user.uid) return bad(404, 'ticket_not_found');
    if (snap.data().status === 'closed') return bad(409, 'ticket_closed');
    const t = now(), msgId = String(t) + '_' + crypto.randomBytes(5).toString('hex');
    await ref.collection('messages').doc(msgId).create({
      senderUid: user.uid, senderRole: 'customer', text, createdAt: t
    });
    await ref.set({ updatedAt: t, lastMessageAt: t, lastMessagePreview: text.slice(0,160), unreadForAgent: true }, { merge: true });
    return ok({ message: { id: msgId, text, senderRole: 'customer', createdAt: t } });
  }

  return { open, list, history, send };
}
