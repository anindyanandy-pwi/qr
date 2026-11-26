// Receives files/links from the Android Share menu and hands them to the page.
// ---- offline copy of the app: network first (always fresh when online), cache when offline
const APP_CACHE='jp-app-v4';
const PRE=['./','home.html','credit.js','index.html','offline.html','present.html','shop.html','desk.html','manifest.json','icon-192.png',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js','https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'];
const LIB=/^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
self.addEventListener('install',e=>e.waitUntil((async()=>{
  const c=await caches.open(APP_CACHE);
  await Promise.all(PRE.map(async u=>{try{const abs=new URL(u,self.registration.scope);const same=abs.origin===location.origin;
    const r=await fetch(abs.href,same?{cache:'no-cache'}:{mode:'no-cors'});if(r.ok||r.type==='opaque')await c.put(same?abs.origin+abs.pathname:abs.href,r)}catch(x){}}));
  await self.skipWaiting();
})()));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url),same=u.origin===location.origin;
  if(!same&&!LIB.test(u.host))return;
  if(same&&/__auth/.test(u.pathname))return;
  e.respondWith((async()=>{
    const key=same?u.origin+u.pathname:e.request.url;
    try{
      const r=same?await fetch(u.href,{cache:'no-cache'}):await fetch(e.request);
      if(r&&(r.ok||r.type==='opaque')){const c=await caches.open(APP_CACHE);c.put(key,r.clone())}
      return r;
    }catch(err){const m=await caches.match(key);if(m)return m;if(same&&e.request.mode==='navigate'){const o=await caches.match(u.origin+self.registration.scope.replace(location.origin,'')+'offline.html');if(o)return o}throw err}
  })());
});
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='POST'||!u.pathname.endsWith('/share'))return;
  e.respondWith((async()=>{
    const scope=self.registration.scope;
    try{
      const fd=await e.request.formData();
      const c=await caches.open('qrp-share');
      for(const k of await c.keys())await c.delete(k);
      let i=0;
      for(const f of fd.getAll('files')){
        if(typeof f==='string')continue;
        await c.put(new Request(scope+'qrp-share/f'+(i++)),new Response(f,{headers:{'x-name':encodeURIComponent(f.name||'file'),'content-type':f.type||'application/octet-stream'}}));
      }
      const txt=[fd.get('title'),fd.get('text'),fd.get('url')].filter(v=>typeof v==='string'&&v.trim()).join('\n').trim();
      if(txt)await c.put(new Request(scope+'qrp-share/text'),new Response(txt));
    }catch(err){}
    return Response.redirect(scope+'#share',303);
  })());
});

// ---- "files waiting" notifications for desk/shop owners (pushed by the drop box)
const PUSH_N={bn:n=>`${n}টি নতুন ফাইল/বার্তা অপেক্ষায় — খুলতে ট্যাপ করুন`,hi:n=>`${n} नई फ़ाइल/संदेश इंतज़ार में — खोलने के लिए टैप करें`,en:n=>`${n} new item${n>1?'s':''} waiting — tap to open`};
const PUSH_G={bn:'নতুন ফাইল এসেছে — খুলতে ট্যাপ করুন',hi:'नई फ़ाइल आई है — खोलने के लिए टैप करें',en:'New files arrived — tap to open'};
self.addEventListener('push',e=>{e.waitUntil((async()=>{
  let total=0,page='desk.html',lang='bn',name='';
  try{
    const c=await caches.open('jp-auth');
    for(const req of await c.keys()){
      const a=await (await c.match(req)).json();lang=a.lang||lang;
      try{const r=await fetch(a.api+'/d/'+a.code+'/inbox',{headers:{Authorization:'Bearer '+a.tok},cache:'no-store'});const l=await r.json();
        if(Array.isArray(l)&&l.length){total+=l.length;page=a.page||page;name=a.name||name}}catch(x){}
    }
  }catch(x){}
  const body=total?(PUSH_N[lang]||PUSH_N.en)(total):(PUSH_G[lang]||PUSH_G.en);
  await self.registration.showNotification('ঝটপট'+(name?' · '+name:''),{body,icon:'icon-192.png',badge:'icon-192.png',tag:'jp-drop',renotify:true,data:{page}});
})())});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil((async()=>{
  const url=new URL((e.notification.data&&e.notification.data.page)||'desk.html',self.registration.scope).href;
  for(const c of await clients.matchAll({type:'window',includeUncontrolled:true})){
    if(c.url.split(/[?#]/)[0]===url){await c.focus();c.postMessage('inbox');return}
  }
  await clients.openWindow(url);
})())});
