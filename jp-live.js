/* Jhatpat — live link for big files: phone/PC to phone/PC directly, nothing stored on any server.
   The sender's page is the server while it stays open. The receiver asks for a file from a byte
   offset, so a dropped connection simply continues where it stopped (resume).
   WebRTC encrypts everything on the wire (DTLS); the link ID is random and unguessable. */
(()=>{
const PREFIX='jplive-',CHUNK=65536,HIGH=8<<20;
const ICE={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'},
  {urls:['turn:eu-0.turn.peerjs.com:3478','turn:us-0.turn.peerjs.com:3478'],username:'peerjs',credential:'peerjsp'}]};
const rid=n=>[...crypto.getRandomValues(new Uint8Array(n))].map(x=>'abcdefghjkmnpqrstuvwxyz23456789'[x%31]).join('');
const js=(c,o)=>{try{c.open&&c.send(JSON.stringify(o))}catch(e){}};
const dev=()=>{const u=navigator.userAgent;return /iPhone/.test(u)?'iPhone':/iPad/.test(u)?'iPad':/Android/.test(u)?'Android':/Windows/.test(u)?'Windows PC':/Mac/.test(u)?'Mac':'PC'};
async function viaRelay(c){
  try{const st=await c.peerConnection.getStats();let pair=null;const cand={};
    st.forEach(r=>{if(r.type==='transport'&&r.selectedCandidatePairId)pair=st.get(r.selectedCandidatePairId);if(r.type==='candidate-pair'&&r.selected)pair=r;if(r.type==='local-candidate'||r.type==='remote-candidate')cand[r.id]=r});
    if(!pair)st.forEach(r=>{if(r.type==='candidate-pair'&&r.state==='succeeded'&&r.nominated)pair=r});
    if(!pair)return null;const l=cand[pair.localCandidateId],r=cand[pair.remoteCandidateId];
    return(l&&l.candidateType==='relay')||(r&&r.candidateType==='relay')}catch(e){return null}
}
const base=()=>location.href.split('#')[0].split('?')[0].replace(/[^/]*$/,'');

/* ---------------- sender ---------------- */
function host(files,info,cb={}){
  return new Promise((resolve,reject)=>{
    const id=rid(12);let peer=null,stopped=false;const conns=new Map();
    const list=files.map((f,i)=>({i,name:f.name,size:f.size,type:f.type||''}));
    function start(){
      peer=new Peer(PREFIX+id,{config:ICE});
      peer.on('open',()=>resolve(api));
      peer.on('connection',c=>{
        const st={c,dev:'',file:-1,got:0,rate:0,done:new Set(),relay:null,offs:[]};conns.set(c,st);
        c.on('open',async()=>{js(c,{t:'list',from:info.from||'',msg:info.msg||'',files:list});cb.change&&cb.change();st.relay=await viaRelay(c);cb.change&&cb.change()});
        c.on('data',d=>{if(typeof d!=='string')return;let m;try{m=JSON.parse(d)}catch(e){return}
          if(m.t==='hi')st.dev=String(m.dev||'').slice(0,30);
          else if(m.t==='get'&&files[m.i])stream(c,st,+m.i,Math.max(0,+m.off||0),m.seq);
          else if(m.t==='prog'){st.file=+m.i;st.got=+m.got||0;st.rate=+m.rate||0}
          else if(m.t==='got')st.done.add(+m.i);
          cb.change&&cb.change()});
        const gone=()=>{conns.delete(c);cb.change&&cb.change()};c.on('close',gone);c.on('error',gone);
      });
      peer.on('disconnected',()=>{if(!stopped)setTimeout(()=>{try{peer&&peer.disconnected&&peer.reconnect()}catch(e){}},1500)});
      peer.on('error',e=>{if(e.type==='unavailable-id'){peer.destroy();reject(e)}else if(/network|server|socket/.test(e.type))cb.net&&cb.net(false)});
    }
    async function stream(c,st,i,off,seq){
      st.seq=seq;st.offs.push(off);st.file=i;const f=files[i],dc=c.dataChannel;dc.bufferedAmountLowThreshold=1<<20;
      const max=Math.min(CHUNK,(c.peerConnection&&c.peerConnection.sctp&&c.peerConnection.sctp.maxMessageSize)||CHUNK);
      js(c,{t:'s',i,off,seq});
      while(off<f.size){
        if(!c.open||st.seq!==seq||stopped)return;
        if(dc.bufferedAmount>HIGH)await new Promise(r=>{const k=()=>{dc.removeEventListener('bufferedamountlow',k);r()};dc.addEventListener('bufferedamountlow',k);setTimeout(k,2000)});
        const b=await f.slice(off,off+max*8).arrayBuffer();
        for(let p=0;p<b.byteLength;p+=max){if(!c.open||st.seq!==seq)return;c.send(b.slice(p,p+max))}
        off+=b.byteLength;
      }
      js(c,{t:'e',i,seq});
    }
    const api={id,url:base()+'send.html#live='+id,get conns(){return[...conns.values()]},
      stop(){stopped=true;for(const c of conns.keys())try{c.close()}catch(e){}conns.clear();try{peer.destroy()}catch(e){}}};
    start();
  });
}

/* ---------------- receiver ---------------- */
function join(id,cb={}){
  let peer=null,c=null,list=null,job=null,seq=0,closed=false,retryT=0,everOpen=false;
  const api={get list(){return list},download,close(){closed=true;try{peer.destroy()}catch(e){}},get open(){return!!(c&&c.open)}};
  function connect(){
    if(closed)return;
    if(!peer||peer.destroyed){peer=new Peer({config:ICE});peer.on('error',e=>{if(e.type==='peer-unavailable'){cb.state&&cb.state(everOpen?'senderGone':'offline');retry(5000)}else if(/network|server|socket/.test(e.type)){cb.state&&cb.state('noNet');retry(4000)}});
      peer.on('open',dial);peer.on('disconnected',()=>{try{peer.reconnect()}catch(e){}})}
    else dial();
  }
  function dial(){
    c=peer.connect(PREFIX+id,{serialization:'raw',reliable:true});
    const to=setTimeout(()=>{if(!c.open){cb.state&&cb.state(everOpen?'senderGone':'slow');retry(3000)}},15000);
    c.on('open',async()=>{clearTimeout(to);everOpen=true;js(c,{t:'hi',dev:dev()});cb.state&&cb.state('connected');
      const r=await viaRelay(c);cb.relay&&cb.relay(r);
      if(job){seq++;job.seq=seq;js(c,{t:'get',i:job.i,off:job.sink.written,seq})}});
    c.on('data',onData);
    c.on('close',()=>{if(closed)return;cb.state&&cb.state(job?'paused':'senderGone');retry(2500)});
  }
  function retry(ms){clearTimeout(retryT);if(!closed)retryT=setTimeout(()=>{if(!(c&&c.open))connect()},ms)}
  let live=false,lastP=0,rateBytes=0,rateT=0,rate=0;
  function onData(d){
    if(typeof d==='string'){let m;try{m=JSON.parse(d)}catch(e){return}
      if(m.t==='list'){list=m;cb.list&&cb.list(m)}
      else if(m.t==='s'&&job&&m.seq===job.seq&&m.i===job.i){live=m.off===job.sink.written}
      else if(m.t==='e'&&job&&m.seq===job.seq&&m.i===job.i){live=false;finish()}
      return}
    if(!job||!live)return;
    const n=d.byteLength??d.size??0;
    try{job.sink.write(d)}catch(e){const j=job;job=null;live=false;j.fail(e);return}
    rateBytes+=n;const now=performance.now();
    if(now-rateT>1000){rate=rate?rate*.6+rateBytes/((now-rateT)/1000)*.4:rateBytes/((now-rateT)/1000);rateBytes=0;rateT=now}
    if(now-lastP>250){lastP=now;cb.prog&&cb.prog(job.i,job.sink.written,rate);js(c,{t:'prog',i:job.i,got:job.sink.written,rate})}
  }
  async function finish(){
    const j=job;job=null;
    try{if(j.sink.written!==j.size)throw new Error('size');const f=await j.sink.close();js(c,{t:'got',i:j.i});j.ok(f)}catch(e){j.fail(e)}
  }
  function download(i,sink){
    return new Promise((ok,fail)=>{
      const f=list.files[i];seq++;rateT=performance.now();rateBytes=0;rate=0;
      job={i,sink,size:f.size,seq,ok,fail};
      if(sink.written>=f.size){live=false;finish();return}
      if(c&&c.open)js(c,{t:'get',i,off:sink.written,seq});
    });
  }
  connect();
  return api;
}
window.JPLive={host,join};
})();
