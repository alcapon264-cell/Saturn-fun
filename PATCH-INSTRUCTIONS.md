# Saturn Live Support backend patch

This patch is intentionally separate from the Admin frontend. Do not deploy the Admin UI until these backend changes are applied; otherwise the new Live Support view will return `unknown_action`.

## 1) Add `lib/support.js`
Copy the included `lib/support.js` into the backend repository at `lib/support.js`.

## 2) Patch `lib/app.js`

Add with the other imports:
```js
import { createSupport } from './support.js';
```

After the `chat` service is created (or immediately before `const isOwner = ...`), add:
```js
const support = db ? createSupport({ db, now }) : null;
```

After the existing `chatRoute` helper and chat route declarations, add:
```js
const supportRoute = (fn, name, limit = 30) =>
  guard('POST', async (req, res, user, b) => {
    if (!support) return send(res, 503, { ok: false, error: 'support_unavailable' });
    const r = await support[fn](user, b);
    return send(res, r.status, r.body);
  }, { needAuth: true, name, limit });

const supportOpen = supportRoute('open', 'support-open', 5);
const supportList = supportRoute('list', 'support-list');
const supportHistory = supportRoute('history', 'support-history');
const supportSend = supportRoute('send', 'support-send', 20);
```

In the `return { ... }` object at the bottom of `createApp`, add:
```js
supportOpen,
supportList,
supportHistory,
supportSend,
```

## 3) Patch `api/[route].js`

Add these entries to the `routes` object:
```js
'support-open': 'supportOpen',
'support-list': 'supportList',
'support-history': 'supportHistory',
'support-send': 'supportSend',
```

## 4) Patch `lib/admin.js`

### Permissions
Add `'support.read'` and `'support.reply'` to `PERMS`.
Update the support role to:
```js
support: ['overview.read', 'users.read', 'tokens.read', 'reports.read', 'support.read', 'support.reply'],
```
Add to `ACTIONS`:
```js
'support-list': ['support.read', false],
'support-get': ['support.read', false],
'support-reply': ['support.reply', true],
'support-status': ['support.reply', true],
```

### Support methods
Inside `createAdmin`, add these methods before the `// ---------------- entry point` comment:
```js
  const supportCol = db.collection('supportTickets');
  const validTicket = id => typeof id === 'string' && /^[A-Za-z0-9_-]{12,64}$/.test(id);
  async function supportList(b) {
    const status = ['open','closed','all'].includes(b.status) ? b.status : 'open';
    const snap = await supportCol.orderBy('updatedAt','desc').limit(100).get();
    const tickets = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .filter(t => status === 'all' || (status === 'open' ? t.status !== 'closed' : t.status === 'closed'));
    return ok({ tickets });
  }
  async function supportGet(b) {
    const id = b.ticketId;
    if (!validTicket(id)) return bad(400,'invalid_ticket_id');
    const ref = supportCol.doc(id), snap = await ref.get();
    if (!snap.exists) return bad(404,'ticket_not_found');
    const ms = await ref.collection('messages').orderBy('createdAt','asc').limit(200).get();
    await ref.set({ unreadForAgent:false },{ merge:true });
    return ok({ ticket:{ id, ...snap.data() }, messages:ms.docs.map(d=>({ id:d.id, ...d.data() })) });
  }
  async function supportReply(b, actor, role) {
    const id = b.ticketId, text = clean(b.text,4000);
    if (!validTicket(id) || !text) return bad(400,'invalid_message');
    const ref = supportCol.doc(id), snap = await ref.get();
    if (!snap.exists) return bad(404,'ticket_not_found');
    if (snap.data().status === 'closed') return bad(409,'ticket_closed');
    const t = now(), mid = String(t)+'_'+crypto.randomBytes(5).toString('hex');
    await ref.collection('messages').doc(mid).create({
      senderUid:actor.uid, senderRole:'agent', senderName:clean(actor.name || actor.email || role,80),
      text, createdAt:t
    });
    await ref.set({ updatedAt:t,lastMessageAt:t,lastMessagePreview:text.slice(0,160),unreadForUser:true },{ merge:true });
    await audit(actor,role,'support-reply','support:'+id,{ messageId:mid });
    return ok({ message:{ id:mid,text,senderRole:'agent',createdAt:t } });
  }
  async function supportStatus(b, actor, role) {
    const id=b.ticketId, status=b.status;
    if (!validTicket(id) || !['open','closed'].includes(status)) return bad(400,'invalid_ticket_status');
    const ref=supportCol.doc(id), snap=await ref.get();
    if (!snap.exists) return bad(404,'ticket_not_found');
    const t=now();
    await ref.set({ status,updatedAt:t,closedAt:status==='closed'?t:null,unreadForAgent:false },{ merge:true });
    await audit(actor,role,'support-status','support:'+id,{ status });
    return ok({ ticketId:id,status });
  }
```

### Admin action switch
Add these cases to the `switch (action)` inside `handle`:
```js
case 'support-list': return await supportList(b);
case 'support-get': return await supportGet(b);
case 'support-reply': return await supportReply(b,user,role);
case 'support-status': return await supportStatus(b,user,role);
```

## 5) Firestore
No client Firestore rules should be opened for these collections. The support API uses the Firebase Admin SDK on the server. Customer access is enforced by matching `supportTickets/{ticketId}.uid` to the authenticated user UID. Admin access is checked by the existing `/api/admin` role and permission gate.

## 6) Deployment and verification
1. Apply all backend changes together and commit to `main`.
2. Wait for Vercel production deployment to become READY.
3. Only then upload the Admin frontend ZIP's `index.html` to the existing `saturn-admin` Netlify site.
4. Next, wire the Saturn app's Live Chat screen to `/api/support-open`, `/api/support-list`, `/api/support-history`, and `/api/support-send`.
5. Test with two separate accounts: customer sends a message, support agent replies, customer receives reply; verify one customer cannot read another customer's ticket.

No API keys, wallet keys, or new environment variables are needed.
