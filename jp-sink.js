/* Jhatpat — save incoming files straight to storage instead of memory.
   Order of preference:
   1. a file/folder the person chose (PC Chrome/Edge: showSaveFilePicker / showDirectoryPicker)
   2. the browser's private storage (OPFS), written from a small worker — Android Chrome, iPhone iOS 16.4+, PCs
   3. memory (old browsers) — fine for small files, capped for big ones
   Every sink supports resume: it knows how many bytes are already safely written. */
(()=>{
const META='jp-sink:';
const W_SRC=`let h=null;
onmessage=async e=>{const m=e.data;try{
 if(m.op==='probe'){const r=await navigator.storage.getDirectory();const d=await r.getDirectoryHandle('jp-in',{create:true});
   const fh=await d.getFileHandle('probe',{create:true});const x=await fh.createSyncAccessHandle();x.close();postMessage({id:m.id,ok:1})}
 else if(m.op==='open'){const r=await navigator.storage.getDirectory();const d=await r.getDirectoryHandle('jp-in',{create:true});
   const fh=await d.getFileHandle(m.path,{create:true});h=await fh.createSyncAccessHandle();
   let s=h.getSize();if(!m.keep){h.truncate(0);s=0}else{const k=s-s%65536;if(k!==s){h.truncate(k);s=k}}postMessage({id:m.id,size:s})}
 else if(m.op==='write'){const u=new Uint8Array(m.buf),n=h.write(u,{at:m.at});if(n!==u.byteLength)throw new Error('space');if(m.id)postMessage({id:m.id})}
 else if(m.op==='close'){if(h){h.flush();h.close();h=null}postMessage({id:m.id})}
}catch(err){postMessage({id:m.id,err:String(err&&err.message||err)})}};`;
let wurl=null;
const clean=s=>String(s).replace(/[^\w.\-]+/g,'_').slice(-80);
async function opfsOK(){
  /* the disk-writing handle only exists inside workers, so ask a worker */
  try{if(!navigator.storage||!navigator.storage.getDirectory||typeof Worker==='undefined')return false;
    wurl=wurl||URL.createObjectURL(new Blob([W_SRC],{type:'text/javascript'}));const w=new Worker(wurl);
    const r=await Promise.race([new Promise(res=>{w.onmessage=e=>res(!!e.data.ok);w.onerror=()=>res(false);w.postMessage({op:'probe',id:1})}),new Promise(res=>setTimeout(()=>res(false),3000))]);
    w.terminate();return r}catch(e){return false}
}
let okP=null;const canDisk=()=>okP||(okP=opfsOK());
async function space(){try{const e=await navigator.storage.estimate();return Math.max(0,(e.quota||0)-(e.usage||0))}catch(e){return Infinity}}

/* OPFS sink, written by a worker so the page never blocks */
async function opfsSink(key,name,size,mime,resume){
  wurl=wurl||URL.createObjectURL(new Blob([W_SRC],{type:'text/javascript'}));
  const w=new Worker(wurl);let seq=0;const wait={};let err=null;
  w.onmessage=e=>{const m=e.data;if(m.err)err=/quota|space/i.test(m.err)?'space':m.err;const f=wait[m.id];if(f){delete wait[m.id];f(m)}};
  const call=(op,o={},tr)=>new Promise(r=>{const id=++seq;wait[id]=r;w.postMessage({op,id,...o},tr||[])});
  const path=clean(key);
  const meta=JSON.parse(localStorage.getItem(META+path)||'null');
  const keep=!!(resume&&meta&&meta.size===size&&meta.name===name);
  const o=await call('open',{path,keep});if(o.err)throw new Error(o.err);
  let at=o.size;
  try{localStorage.setItem(META+path,JSON.stringify({name,size,mime,done:at,t:Date.now()}))}catch(e){}
  let lastSave=0,pend=0;
  return{kind:'disk',get written(){return at},
    write(buf){if(err){const e=new Error(err);e.code=err==='space'?'space':'disk';throw e}const b=buf instanceof ArrayBuffer?buf:buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
      const len=b.byteLength,needAck=(++pend%64===0);w.postMessage({op:'write',at,buf:b,id:needAck?++seq:0},[b]);at+=len;/* b is handed over (detached) after postMessage, so its length must be read first */
      const n=Date.now();if(n-lastSave>1500){lastSave=n;try{localStorage.setItem(META+path,JSON.stringify({name,size,mime,done:at,t:n}))}catch(e){}}
      return needAck?new Promise(r=>{wait[seq]=r}):null},
    async close(){const r=await call('close');w.terminate();if(r.err||err)throw new Error(r.err||err);
      try{localStorage.setItem(META+path,JSON.stringify({name,size,mime,done:at,t:Date.now(),fin:1}))}catch(e){}
      const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('jp-in');const f=await(await d.getFileHandle(path)).getFile();
      if(f.size!==at){const e=new Error('space');e.code='space';throw e}   /* never hand over a short file */
      return new File([f],name,{type:mime||f.type||'application/octet-stream'})},
    async pause(){try{await call('close')}catch(e){}w.terminate()},
    async discard(){try{await call('close')}catch(e){}w.terminate();try{const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('jp-in');await d.removeEntry(path)}catch(e){}try{localStorage.removeItem(META+path)}catch(e){}}};
}
/* a file the person picked on a PC */
async function handleSink(fh,name,size,mime,resumeAt){
  const ws=await fh.createWritable({keepExistingData:!!resumeAt});let at=resumeAt||0;
  if(at){await ws.truncate(at);await ws.seek(at)}
  let chain=Promise.resolve(),err=null;
  return{kind:'picked',get written(){return at},
    write(buf){if(err)throw err;const b=new Uint8Array(buf);at+=b.byteLength;chain=chain.then(()=>ws.write(b)).catch(e=>{err=e});return null},
    async close(){await chain;if(err)throw err;await ws.close();return fh.getFile()},
    async pause(){await chain;try{await ws.close()}catch(e){}},
    async discard(){try{await ws.abort()}catch(e){}}};
}
function memSink(name,size,mime){
  const parts=[];let at=0;
  return{kind:'memory',get written(){return at},write(buf){parts.push(buf);at+=buf.byteLength??buf.size??0;return null},
    async close(){return new File(parts,name,{type:mime||'application/octet-stream'})},async pause(){},async discard(){parts.length=0}};
}
const MEM_LIMIT=300*1048576;
/* open(key,name,size,mime,{resume,handle,resumeAt}) */
async function open(key,name,size,mime,opt={}){
  if(opt.handle)return handleSink(opt.handle,name,size,mime,opt.resumeAt||0);
  if(size>8*1048576&&await canDisk()){
    if(await space()<size*1.05){const e=new Error('space');e.code='space';throw e}
    try{return await opfsSink(key,name,size,mime,!!opt.resume)}catch(e){}
  }
  if(size>MEM_LIMIT){const e=new Error('memory');e.code='memory';throw e}
  return memSink(name,size,mime);
}
/* tidy up finished or abandoned files older than a day */
async function sweep(){
  try{const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('jp-in',{create:true});
    for await(const[n] of d.entries()){const m=JSON.parse(localStorage.getItem(META+n)||'null');
      if(n==='probe'||!m||Date.now()-m.t>86400000){try{await d.removeEntry(n);localStorage.removeItem(META+n)}catch(e){}}}}catch(e){}
}
async function canPick(){return 'showSaveFilePicker' in window&&!/Android|iPhone|iPad/i.test(navigator.userAgent)}
window.JPSink={open,sweep,canDisk,canPick,space,MEM_LIMIT};
setTimeout(sweep,4000);
})();
