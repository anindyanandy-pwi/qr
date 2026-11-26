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
st.textContent='#jpCredit{display:block;width:max-content;max-width:100%;margin:8px auto 0;padding:3px 12px;font-size:13px;font-weight:600;line-height:1.4;color:inherit;opacity:.72;text-align:center;text-decoration:none;border:1px solid currentColor;border-color:color-mix(in srgb,currentColor 25%,transparent);border-radius:999px}#jpCredit[href]:hover{color:#e4002b;opacity:1}@media print{#jpCredit{display:none}}';
document.head.append(st);
function draw(){
  let a=document.getElementById('jpCredit');
  if(!a){a=document.createElement('a');a.id='jpCredit';const m=document.querySelector('main')||document.body;m.prepend(a)}
  const tx=N[document.documentElement.lang]||N.en;if(a.textContent!==tx)a.textContent=tx;
  if(CONTACT){a.href=CONTACT;a.target='_blank';a.rel='noopener'}else a.removeAttribute('href');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',draw);else draw();
new MutationObserver(draw).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
})();
