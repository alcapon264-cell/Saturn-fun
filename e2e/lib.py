import json, urllib.request, urllib.error
import os
HTML=open(os.environ['HTML']).read()  # path to the frontend HTML TEST COPY (see ../CHAT-SETUP.md)
WA,WB,WC='7'*44,'8'*44,'9'*44
def api(tok,route,body=None):
    rq=urllib.request.Request('http://localhost:8811/api/'+route,data=json.dumps(body or {}).encode(),headers={'content-type':'application/json','authorization':'Bearer '+tok,'origin':'https://saturn.test'})
    try:
        r=urllib.request.urlopen(rq);return r.status,json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:return e.code,json.loads(e.read())
        except Exception:return e.code,{}
STUB_APP="export const initializeApp=c=>({c});"
def stub_auth(uid):
    return """
let cb=null;const u={uid:'%s',displayName:'%s',email:'%s@x.test',photoURL:null,getIdToken:async()=>'tok-%s'};
export const getAuth=()=>({currentUser:u});export class GoogleAuthProvider{setCustomParameters(){}}
export const signInWithPopup=async()=>{};export const signInWithRedirect=async()=>{};export const getRedirectResult=async()=>null;
export const signOut=async()=>{};export const onAuthStateChanged=(a,f)=>{setTimeout(()=>f(u),0)};
"""%(uid,uid,uid,uid)
def new_page(br,uid,vp={'width':390,'height':844}):
    ctx=br.new_context(viewport=vp);pg=ctx.new_page();logs=[]
    pg.add_init_script("try{localStorage.setItem('%s','1')}catch(e){}"%__import__('re').search(r"SO_INTRO_KEY *= *'([^']*)'",HTML).group(1))
    pg.on('pageerror',lambda e:logs.append('PAGEERR '+str(e)));pg.on('console',lambda m:logs.append(m.type+': '+m.text) if m.type in('error',) else None)
    pg.route('https://www.gstatic.com/firebasejs/**/firebase-app.js',lambda r:r.fulfill(content_type='text/javascript',body=STUB_APP))
    pg.route('https://www.gstatic.com/firebasejs/**/firebase-auth.js',lambda r:r.fulfill(content_type='text/javascript',body=stub_auth(uid)))
    def be(route):
        req=route.request
        if req.method=='OPTIONS':
            route.fulfill(status=204,headers={'access-control-allow-origin':'https://saturn.test','access-control-allow-headers':'*','access-control-allow-methods':'*'});return
        rq=urllib.request.Request('http://localhost:8811'+req.url.split('vercel.app')[1],data=(req.post_data or '{}').encode(),headers={k:v for k,v in req.headers.items() if k in('authorization','content-type','x-saturn-session')}|{'origin':'https://saturn.test'})
        try:
            r=urllib.request.urlopen(rq);st,body=r.status,r.read()
        except urllib.error.HTTPError as e: st,body=e.code,e.read()
        route.fulfill(status=st,body=body,headers={'content-type':'application/json','access-control-allow-origin':'https://saturn.test','access-control-expose-headers':'*'})
    pg.route('https://saturn-backend-gilt.vercel.app/**',be)
    pg.route('https://saturn.test/**',lambda r:r.fulfill(content_type='text/html',body=HTML))
    # everything else (RPC, CDNs, fonts) fails fast
    pg.route(lambda u: not (u.startswith('https://saturn.test') or u.startswith('https://saturn-backend-gilt') or u.startswith('https://www.gstatic.com/firebasejs')),lambda r:r.abort())
    return ctx,pg,logs

def enter(pg,hash_):
    pg.goto('https://saturn.test/');pg.wait_for_timeout(1200)
    try:
        b=pg.get_by_text('Use another option')
        if b.count() and b.first.is_visible(): b.first.click();pg.wait_for_timeout(500)
        pg.evaluate("try{onbLeave()}catch(e){console.error('onbLeave',e)};window.onbLeave=function(){};window.onbEnter=function(){};window.soGo=function(){}");pg.wait_for_timeout(600)
    except Exception as e: print('skip err',e)
    pg.evaluate("(()=>{const o=document.getElementById('onb');o&&o.remove();document.body.classList.remove('onb-on');document.body.style.overflow='auto';ONB.active=false})()");pg.evaluate("location.hash=%r;route(true)"%hash_);pg.wait_for_timeout(2200)
