/* Jhatpat — maker credit shown on every page.
   CONTACT: leave '' for now. To turn the link on, set it to
   'https://jhatpat-drop.jhatpat-drop.workers.dev/contact' after the WhatsApp
   number is saved as the CONTACT_WA secret on the worker (the number never
   appears in this site's code). */
(()=>{
const CONTACT='https://jhatpat-drop.jhatpat-drop.workers.dev/contact';
const N={bn:'বানিয়েছেন অনিন্দ্য নন্দী',hi:'निर्माता: अनिंद्य नंदी',en:'Made by Anindya Nandy'};
window.JP_CREDIT={contact:CONTACT,text:l=>N[l]||N.en,all:'বানিয়েছেন অনিন্দ্য নন্দী · निर्माता: अनिंद्य नंदी · Made by Anindya Nandy'};
const st=document.createElement('style');
st.textContent='#jpCredit{display:block;width:max-content;max-width:100%;margin:28px auto 10px;padding:6px 10px;font-size:13px;line-height:1.3;color:#8a8a8a;text-align:center;text-decoration:none;border-radius:8px}#jpCredit[href]:hover{color:#e4002b}@media print{#jpCredit{display:none}}';
document.head.append(st);
function draw(){
  let a=document.getElementById('jpCredit');
  if(!a){a=document.createElement('a');a.id='jpCredit';(document.querySelector('main')||document.body).append(a)}
  const tx=N[document.documentElement.lang]||N.en;if(a.textContent!==tx)a.textContent=tx;
  if(CONTACT){a.href=CONTACT;a.target='_blank';a.rel='noopener'}else a.removeAttribute('href');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',draw);else draw();
new MutationObserver(draw).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
})();
