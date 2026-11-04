# Browser E2E: REAL Saturn backend (fake Firestore) + the REAL frontend HTML (test copy with Privy disabled, Firebase auth stubbed).
import sys, json
from playwright.sync_api import sync_playwright
from lib import *
res=[]
def check(n,c):
    res.append((n,bool(c)));print(('PASS' if c else 'FAIL'),n)
def pcall(pg,route,body):
    # call the backend FROM the page, so the page's registered Saturn session header is included (as in production)
    return pg.evaluate("([r,b])=>SyncService._post('/api/'+r,b,true)",[route,body])
def chat_btn(pg): return pg.locator('.pr-chat').inner_text() if pg.locator('.pr-chat').count() else None
with sync_playwright() as p:
    br=p.chromium.launch()
    ca,pa,la=new_page(br,'UA'); enter(pa,'#/u/'+WB); pa.wait_for_timeout(1500)
    check('profile: no follow -> "needs mutual following", no Message button',chat_btn(pa)=='Chat needs mutual following' and pa.locator('.pr-chat button').count()==0)
    r=pcall(pa,'follow-set',{'wallet':WB,'from':WA,'follow':True});check('A follows B through the backend',r.get('ok') and r.get('following'))
    pa.evaluate("location.hash='#/inbox'");pa.wait_for_timeout(500);pa.evaluate("location.hash='#/u/%s'"%WB);pa.wait_for_timeout(3000)
    check('profile: one-way follow still shows "needs mutual following"',chat_btn(pa)=='Chat needs mutual following')
    api('tok-UB','follow-set',{'wallet':WA,'from':WB,'follow':True})  # B has no page/session yet
    pa.evaluate("location.hash='#/inbox'");pa.wait_for_timeout(500);pa.evaluate("location.hash='#/u/%s'"%WB);pa.wait_for_timeout(3500)
    check('profile: after follow-back the Message button appears AND survives re-renders (3.5 s)',chat_btn(pa)=='Message')
    pa.evaluate("(()=>{const r=document.querySelector('.prf .pr-fl');r.querySelector('.pr-chat').remove();r.appendChild(document.createElement('i'))})()");pa.wait_for_timeout(800)  # simulate the profile page re-rendering and dropping the injected button
    check('profile: button is re-applied after a forced page re-render',chat_btn(pa)=='Message')
    pa.click('.pr-chat button');pa.wait_for_selector('#chx-in')
    check('Message button opens the private chat',pa.evaluate('S.view')=='chat' and pa.evaluate('Chat.canSend'))
    pa.fill('#chx-in','hello bob');pa.click('.chx-s');pa.wait_for_selector('.chx-m.me')
    check('A sends a message and sees it with a timestamp',pa.locator('.chx-m.me .chx-b').inner_text()=='hello bob' and pa.locator('.chx-m.me .chx-t').inner_text()!='Sending…')
    cb,pb,lb=new_page(br,'UB'); enter(pb,'#/inbox'); pb.wait_for_selector('.ibx-it')
    check('B: bell shows an unread alert',not pb.evaluate("document.getElementById('bellc').hidden"))
    txt=pb.inner_text('#ibx')
    check('B: inbox shows "sent you a message" and the mutual-follow notice','sent you a message' in txt and 'follow each other' in txt)
    pb.click('[data-k=messages]');pb.wait_for_selector('.chx-row')
    row=pb.inner_text('.chx-row')
    check('B: conversation list shows username, last message, unread dot','alice' in row.lower() and 'hello bob' in row and pb.locator('.chx-dot').count()==1)
    pb.click('.chx-row');pb.wait_for_selector('#chx-in');pb.wait_for_selector('.chx-m.th')
    check('B opens the right conversation and sees the message',pb.locator('.chx-m.th .chx-b').inner_text()=='hello bob' and 'alice' in pb.inner_text('.chx-who').lower())
    pb.fill('#chx-in','hi alice');pb.click('.chx-s');pb.wait_for_selector('.chx-m.me')
    pa.wait_for_function("document.querySelectorAll('.chx-m.th').length===1",timeout=15000)
    check('A receives B\'s reply by polling, in correct order',pa.evaluate("[...document.querySelectorAll('.chx-m .chx-b')].map(e=>e.textContent).join('|')")=='hello bob|hi alice')
    pb.evaluate("location.hash='#/inbox'");pb.wait_for_timeout(600);pb.evaluate("Inbox.load()");pb.wait_for_timeout(1500)
    check('B: after reading, the message alert is read and the conversation unread count is 0 (other alerts such as the follow notice stay unread)',pb.evaluate("Inbox.items.filter(x=>x.type==='message'&&!x.read).length")==0 and pcall(pb,'chat-list',{})['items'][0]['unread']==0 and pb.evaluate("Inbox.items.some(x=>x.type==='follow'&&!x.read)"))
    # chat menu -> block
    pa.click('.chx-mn');pa.wait_for_selector('.chx-menu')
    check('chat menu shows View profile and Block user','Block user' in pa.inner_text('.chx-menu') and 'View profile' in pa.inner_text('.chx-menu'))
    pa.once('dialog',lambda d:d.accept());pa.click('[data-cx=block]');pa.wait_for_timeout(2000)
    check('Block user from chat menu: returns to inbox',pa.evaluate('S.view')=='inbox')
    ro=pcall(pb,'chat-open',{'wallet':WA}); rs=pcall(pb,'chat-send',{'conversation':pb.evaluate('Chat.conv'),'text':'x','cid':'cid-blocked-01'})
    check('backend: blocked user can no longer open (404) or send into the old conversation (404)',ro.get('http')==404 and rs.get('http')==404)
    pa.evaluate("location.hash='#/settings'");pa.wait_for_timeout(1500)
    check('Settings still lists the blocked user (unblock available)','bob' in pa.inner_text('body').lower() or 'Blocked' in pa.inner_text('body'))
    pb.evaluate("location.hash='#/chat/%s'"%WA);pb.wait_for_timeout(2500)
    check('blocked user opening the chat URL sees a generic "isn\'t available" message',"isn’t available" in pb.inner_text('#chx') or "isn't available" in pb.inner_text('#chx'))
    # mobile layout
    cm,pm,lm=new_page(br,'UB',{'width':360,'height':740});enter(pm,'#/inbox');pm.wait_for_timeout(800)
    check('mobile (360px): no horizontal overflow in inbox',pm.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
    errs=[l for l in la+lb+lm if 'PAGEERR' in l]
    check('no uncaught JavaScript errors in any page',not errs)
    if errs: print(errs[:3])
    pa.screenshot(path='/tmp/final-a.png');pb.screenshot(path='/tmp/final-b.png')
    br.close()
bad=[n for n,c in res if not c];print('\nTOTAL',len(res),'FAILED',len(bad));sys.exit(1 if bad else 0)
