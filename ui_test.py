import asyncio, json, urllib.request, sys
from playwright.async_api import async_playwright
HTML=open('/mnt/user-data/outputs/Saturn-Settings-Backend-Complete.html',encoding='utf-8').read()
BACK='https://saturn-backend-saturn-81f4.vercel.app'
res=[]
def ok(n,c,x=''): res.append((n,bool(c),x)); print(('PASS' if c else 'FAIL'),n,x)
async def run():
  async with async_playwright() as p:
    b=await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args=['--no-sandbox'])
    async def newpage(tok,w=390,h=844):
      ctx=await b.new_context(viewport={'width':w,'height':h},user_agent='Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36')
      pg=await ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
      async def handle(route):
        u=route.request.url
        if u.startswith('https://saturn.test/'): return await route.fulfill(status=200,content_type='text/html',body=HTML)
        if u.startswith(BACK):
          rq=route.request; hdr={k:v for k,v in rq.headers.items() if k in('authorization','content-type','x-saturn-session','user-agent')}; hdr['origin']='https://saturn.test'
          r=urllib.request.Request('http://127.0.0.1:8799'+u[len(BACK):],data=(rq.post_data or '{}').encode(),headers=hdr,method='POST')
          try: resp=urllib.request.urlopen(r); code=resp.status; body=resp.read()
          except urllib.error.HTTPError as e: code=e.code; body=e.read()
          return await route.fulfill(status=code,body=body,headers={'access-control-allow-origin':'https://saturn.test','access-control-allow-headers':'*','content-type':'application/json'})
        return await route.abort()
      await ctx.route('**/*',handle)
      await pg.goto('https://saturn.test/#/settings',wait_until='domcontentloaded'); await pg.wait_for_timeout(1500)
      await pg.evaluate("""(t)=>{SyncService._tok=async()=>t;AuthService.user={uid:t==='t1'?'U1':'U2',email:'x@test'};AuthService.status='in';AuthService._emit()}""",tok)
      await pg.wait_for_timeout(1500); return pg,errs,ctx
    pg,errs,ctx=await newpage('t1')
    await pg.evaluate("S.view='settings';window.setSub='';$('#app').innerHTML=SettingsPage()"); await pg.wait_for_timeout(800)
    txt=await pg.inner_text('#app')
    ok('no dev messages',('integration required' not in txt.lower()) and 'SATURN_LINKS' not in txt)
    ok('no NGN','NGN' not in txt)
    ok('settings loaded from server',await pg.evaluate("SettingsSvc.st")=='ok')
    # toggle confirm before signing
    await pg.wait_for_timeout(1500)
    await pg.dispatch_event('[data-sset="confirmBeforeSigning"]','click'); await pg.wait_for_timeout(800)
    ok('confirm toggle saved',await pg.evaluate("SettingsSvc.get('confirmBeforeSigning')")==False)
    # currency
    await pg.evaluate("window.setSub='currency';$('#app').innerHTML=SettingsPage()"); await pg.dispatch_event('[data-val="SOL"]','click'); await pg.wait_for_timeout(800)
    ok('currency SOL saved',await pg.evaluate("SettingsSvc.ccy()")=='SOL')
    ok('only USD/SOL options',(await pg.inner_text('#app')).count('USD')>=1 and 'NGN' not in await pg.inner_text('#app'))
    # fee
    await pg.evaluate("window.setSub='fee';$('#app').innerHTML=SettingsPage()"); await pg.dispatch_event('[data-val="high"]','click'); await pg.wait_for_timeout(800)
    ok('priority fee high -> 0.0005',await pg.evaluate("pumpPrioSol('buy')")==0.0005 and await pg.evaluate("pumpPrioSol('create')")==0.0001)
    # privacy
    await pg.evaluate("window.setSub='';$('#app').innerHTML=SettingsPage()"); await pg.dispatch_event('[data-sset="privacyBP"]','click'); await pg.wait_for_timeout(800)
    ok('show balance/pnl off saved',await pg.evaluate("[SettingsSvc.get('showBalance'),SettingsSvc.get('showPnl')]")==[False,False])
    await pg.evaluate("(()=>{const x=document.querySelector('[data-sset-select=profileVisibility]');x.value='private';x.dispatchEvent(new Event('change',{bubbles:true}))})()"); await pg.wait_for_timeout(800)
    ok('visibility private saved',await pg.evaluate("SettingsSvc.get('profileVisibility')")=='private')
    # refresh persistence: new page same server
    pg2,e2,c2=await newpage('t1')
    ok('persist after reload',await pg2.evaluate("SettingsSvc.data&&[SettingsSvc.ccy(),SettingsSvc.get('priorityFee'),SettingsSvc.get('profileVisibility')]")==['SOL','high','private'])
    # isolation
    pg3,e3,c3=await newpage('t2')
    ok('user isolation',await pg3.evaluate("[SettingsSvc.ccy(),SettingsSvc.get('priorityFee'),SettingsSvc.get('profileVisibility')]")==['USD','medium','public'])
    # sessions: second device list + revoke
    await pg2.evaluate("S.view='settings';window.setSub='';$('#app').innerHTML=SettingsPage()"); await pg2.wait_for_timeout(300); await pg2.dispatch_event('[data-setsub="sessions"]','click'); await pg2.wait_for_timeout(1500)
    t2=await pg2.inner_text('#app'); ok('sessions list shows this device',('This device' in t2),t2[:120].replace('\n',' '))
    # revoke the other device (pg) from pg2
    btn=await pg2.query_selector('[data-sx="ses-revoke"]'); ok('other device listed',btn is not None)
    if btn:
      await btn.dispatch_event('click'); await pg2.wait_for_timeout(1500)
      r=await pg.evaluate("SyncService._post('/api/settings',{action:'get'},true).then(r=>[r.http,r.code])")
      ok('revoked device refused server-side',r[0]==401 and r[1]=='session_revoked',str(r))
      ok('current device still works',await pg2.evaluate("SyncService._post('/api/settings',{action:'get'},true).then(r=>r.http)")==200)
    # report
    await pg2.evaluate("window.setSub='report';$('#app').innerHTML=SettingsPage()"); await pg2.evaluate("v=>{const e=document.querySelector('#rp-msg');e.value=v}",'The chart is blank on my phone since update.'); await pg2.dispatch_event('[data-sx="rp-send"]','click'); await pg2.wait_for_timeout(1200)
    ok('report confirmed by backend','Report received' in await pg2.inner_text('#sx-msg'))
    await pg2.evaluate("window.setSub='report';$('#app').innerHTML=SettingsPage()"); await pg2.evaluate("v=>{const e=document.querySelector('#rp-msg');e.value=v}",'short'); await pg2.dispatch_event('[data-sx="rp-send"]','click')
    ok('report validates','at least 10' in await pg2.inner_text('#sx-msg'))
    # mobile overflow
    for w in (360,390,430):
      await pg2.set_viewport_size({'width':w,'height':844}); await pg2.evaluate("window.setSub='';$('#app').innerHTML=SettingsPage()")
      ok('no horizontal overflow @%d'%w,await pg2.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
    await pg2.screenshot(path='/home/claude/fe/settings.png',full_page=True)
    ok('no page errors',not (errs+e2+e3),str((errs+e2+e3)[:3]))
    await b.close()
asyncio.run(run())
print('SUMMARY',sum(1 for r in res if r[1]),'/',len(res))
