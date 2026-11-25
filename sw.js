// Receives files/links from the Android Share menu and hands them to the page.
self.addEventListener('install',()=>self.skipWaiting());
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
