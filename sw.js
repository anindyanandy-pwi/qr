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
