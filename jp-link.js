/* Jhatpat — send-as-link engine (used by send.html and the meeting screen).
   Files are encrypted on this device (AES-256-GCM). The key goes only into the
   link's #fragment, which browsers never send to any server, so the drop box
   stores data it cannot read. */
(()=>{
const API='https://jhatpat-drop.jhatpat-drop.workers.dev';
const CH=1<<20; // 1 MB pieces
const b64u=b=>{let s='';const u=new Uint8Array(b);for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
const ub64=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0))};
const aes=raw=>crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
async function seal(key,data){const iv=crypto.getRandomValues(new Uint8Array(12));const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,data));const o=new Uint8Array(12+ct.length);o.set(iv);o.set(ct,12);return o}
async function open(key,buf){const u=new Uint8Array(buf);return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:u.subarray(0,12)},key,u.subarray(12)))}
const partsOf=f=>Math.max(1,Math.ceil(f.size/CH));
const dir=()=>location.href.split('#')[0].split('?')[0].replace(/[^/]*$/,'');

async function pushEndpoint(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return null;
  if(Notification.permission!=='granted'&&await Notification.requestPermission()!=='granted')return null;
  try{
    const reg=await navigator.serviceWorker.ready;let s=await reg.pushManager.getSubscription();
    if(!s){const k=(await(await fetch(API+'/vapid')).json()).key;s=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:ub64(k)})}
    return s.endpoint;
  }catch(e){return null}
}

/* opts: {from,msg,exp(seconds),once,pin,notify,vo,lang}; onProg(fraction) */
async function createLink(files,opts,onProg){
  const raw=crypto.getRandomValues(new Uint8Array(32)),key=await aes(raw);
  const man={v:1,from:(opts.from||'').slice(0,60),msg:(opts.msg||'').slice(0,4000),vo:!!opts.vo,files:files.map(f=>({name:f.name.slice(0,120),type:f.type||'',size:f.size,parts:partsOf(f)}))};
  const sub=opts.notify?await pushEndpoint():null;
  const total=files.reduce((a,f)=>a+f.size,0);
  const r=await fetch(API+'/l',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    parts:man.files.map(f=>f.parts),total,manifest:b64u(await seal(key,new TextEncoder().encode(JSON.stringify(man)))),
    exp:opts.exp||86400,maxdl:opts.once?1:0,pin:opts.pin||undefined,sub:sub||undefined,lang:opts.lang})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(j.error||'http'+r.status);e.code=j.error||'http';throw e}
  const H={Authorization:'Bearer '+j.up};
  const jobs=[];files.forEach((f,n)=>{for(let k=0;k<partsOf(f);k++)jobs.push([f,n,k])});
  let done=0;onProg&&onProg(0);
  const worker=async()=>{while(jobs.length){const[f,n,k]=jobs.shift();
    const body=await seal(key,new Uint8Array(await f.slice(k*CH,(k+1)*CH).arrayBuffer()));
    for(let t=0;;t++){try{const u=await fetch(`${API}/l/${j.id}/${n}/${k}`,{method:'PUT',headers:H,body});if(u.ok)break;if(u.status<500||t>3)throw new Error('up'+u.status)}catch(e){if(t>3)throw e;await new Promise(z=>setTimeout(z,800*(t+1)))}}
    done++;onProg&&onProg(done/(done+jobs.length+1e-9)*0.999)}};
  await Promise.all([worker(),worker(),worker()]);
  const d=await fetch(`${API}/l/${j.id}/done`,{method:'POST',headers:H});if(!d.ok)throw new Error('done');
  onProg&&onProg(1);
  const url=dir()+'send.html#g='+j.id+'.'+b64u(raw);
  const rec={id:j.id,up:j.up,url,exp:j.exp,at:Date.now(),n:files.length,names:files.slice(0,3).map(f=>f.name),pin:opts.pin||'',once:!!opts.once};
  try{const l=JSON.parse(localStorage.getItem('jp-links')||'[]').filter(x=>x.exp>Date.now());l.unshift(rec);localStorage.setItem('jp-links',JSON.stringify(l.slice(0,30)))}catch(e){}
  return rec;
}
async function deleteLink(rec){
  try{await fetch(`${API}/l/${rec.id}/del`,{method:'POST',headers:{Authorization:'Bearer '+rec.up}})}catch(e){}
  try{const l=JSON.parse(localStorage.getItem('jp-links')||'[]').filter(x=>x.id!==rec.id);localStorage.setItem('jp-links',JSON.stringify(l))}catch(e){}
}
function myLinks(){try{return JSON.parse(localStorage.getItem('jp-links')||'[]').filter(x=>x.exp>Date.now())}catch(e){return[]}}

/* ---------- receiving side ---------- */
async function info(id){return(await fetch(`${API}/l/${id}`,{cache:'no-store'})).json()}
async function openLink(id,keyB64,pin){
  const r=await fetch(`${API}/l/${id}/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pin||''})});
  const j=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(j.error||'http');e.code=j.error;e.left=j.left;throw e}
  const key=await aes(ub64(keyB64));
  const man=JSON.parse(new TextDecoder().decode(await open(key,ub64(j.manifest))));
  return{man,key,tok:j.tok,exp:j.exp,once:j.once,id};
}
async function fetchFile(L,n,onProg){
  const f=L.man.files[n],out=[];
  for(let k=0;k<f.parts;k++){
    let buf;for(let t=0;;t++){try{const r=await fetch(`${API}/l/${L.id}/${n}/${k}?t=${L.tok}`,{cache:'no-store'});if(!r.ok)throw new Error('dl'+r.status);buf=await r.arrayBuffer();break}catch(e){if(t>3)throw e;await new Promise(z=>setTimeout(z,800*(t+1)))}}
    out.push(await open(L.key,buf));onProg&&onProg((k+1)/f.parts);
  }
  return new File(out,f.name,{type:f.type||'application/octet-stream'});
}
async function report(id){try{await fetch(`${API}/l/${id}/report`,{method:'POST'})}catch(e){}}

window.JPLink={API,createLink,deleteLink,myLinks,info,openLink,fetchFile,report,partsOf};
})();
