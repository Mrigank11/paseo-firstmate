// The page's inline script, adapted from lh-dev-status.html.
// Lavish's iframe has an opaque origin: localStorage may throw and fetch() cannot read the live data,
// so the live block arrives by re-adding a <script> tag that calls window.__fdLive(html). Open/closed
// <details> state lives in memory, mirrored to localStorage when allowed, else to window.name. Read marks ("Done,
// unread" cards) live in the same place (S._r) and are shared between browsers through the plugin's marks endpoint
// (marksUrl); when it cannot be reached the page simply keeps them local and shows nothing about it.
import { ANCHOR_JS } from "./anchors.ts";

export function pageScript(project: string, liveFile: string, tickSeconds: number, marksUrl = ""): string {
  const j = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  return `(function(){
  var K=${j("fd:" + project + ":state")},P=K+"|",F=${j(liveFile)},V=${j(liveFile.replace(/\.js$/, ".v.js"))},MU=${j(marksUrl)},ls=null,S={};
  try{localStorage.setItem(K+"t","1");localStorage.removeItem(K+"t");ls=localStorage}catch(e){}
  try{var raw=(ls&&ls.getItem(K))||(window.name.indexOf(P)===0?window.name.slice(P.length):"");if(raw)S=JSON.parse(raw)||{}}catch(e){}
  function save(){var s=JSON.stringify(S);try{if(ls)ls.setItem(K,s)}catch(e){}
    try{if(!window.name||window.name.indexOf(P)===0)window.name=P+s}catch(e){}}
  var R=(S._r&&typeof S._r==="object")?S._r:{};S._r=R;
  // small per-page preferences other scripts keep in this state (the task navigator's fold): saved like the rest, synced
  window.__fdPref=function(k,v){if(arguments.length<2)return S[k];S[k]=v;save();push()};
  window.__fdPrefKeys=function(p){return Object.keys(S).filter(function(k){return k.indexOf(p)===0&&S[k]===1})};
  ${ANCHOR_JS}
  function live(){return document.getElementById("live")}
  function snapshot(){var el=live();if(!el)return;el.querySelectorAll("details[id]").forEach(function(d){S[d.id]=d.open?1:0});save()}
  function restore(root){root.querySelectorAll("details[id]").forEach(function(d){if(d.id in S)d.open=!!S[d.id]})}
  document.addEventListener("toggle",function(e){var d=e.target;if(d&&d.id){S[d.id]=d.open?1:0;save()}},true);
  // ---- read marks: a done card is read when R["t-<task>"] equals the card's hash (data-h); editing the card makes it unread again
  function place(box,list){var kids=[].slice.call(box.children),same=kids.length===list.length;
    for(var i=0;same&&i<list.length;i++)if(kids[i]!==list[i])same=false;
    if(!same)list.forEach(function(t){box.appendChild(t)})}
  function arrange(root){root=root||document;var g=function(i){return root===document?document.getElementById(i):root.querySelector("#"+i)},u=g("g-doneu"),d=g("g-done");if(!u||!d)return;
    // cards the server already placed in Done are read (it applied the stored marks): adopt that, so an unreachable endpoint does not undo it
    [].slice.call(d.querySelectorAll(".task[data-h]")).forEach(function(t){if(!(t.id in R))R[t.id]=t.getAttribute("data-h")});
    var all=[].slice.call(u.querySelectorAll(".task")).concat([].slice.call(d.querySelectorAll(".task")));
    all.sort(function(x,y){return x.getAttribute("data-i")-y.getAttribute("data-i")});
    var ur=u.querySelector(".rows"),dr=d.querySelector(".rows"),ul=[],dl=[],cu=0,cd=0;
    all.forEach(function(t){var h=t.getAttribute("data-h"),unread=!!h&&R[t.id]!==h,bad=t.classList.contains("s-failed");
      (unread?ul:dl).push(t);if(!bad){if(unread)cu++;else cd++}});
    place(ur,ul);place(dr,dl);
    u.querySelector(".cn").textContent=ul.length;d.querySelector(".cn").textContent=dl.length;u.hidden=!ul.length;d.hidden=!dl.length;
    [].slice.call(root.querySelectorAll(".sum[data-k]")).forEach(function(a){var un=a.getAttribute("data-k")==="u",n=un?cu:cd;
      a.hidden=!n;a.textContent=n+(un?" done, unread":" done")});if(root===document)tn()}
  // the task navigator (nav-script.ts) rebuilds from the live block's data-tn template and re-reads the unread marks
  function tn(){if(window.__tn)try{window.__tn()}catch(e){}}
  var pt=null;
  function push(){if(!MU)return;clearTimeout(pt);pt=setTimeout(function(){try{var o={};Object.keys(S).forEach(function(k){if(k!=="_r")o[k]=S[k]});
    fetch(MU,{method:"POST",headers:{"Content-Type":"text/plain"},body:JSON.stringify({o:o,r:R})}).catch(function(){})}catch(e){}},400)}
  function pull(){if(!MU)return;try{fetch(MU).then(function(r){return r.json()}).then(function(j){var ch=false,rr=(j&&j.r)||{},oo=(j&&j.o)||{};
    Object.keys(rr).forEach(function(k){if(R[k]!==rr[k]){R[k]=rr[k];ch=true}});
    Object.keys(oo).forEach(function(k){if(!(k in S)){S[k]=oo[k];ch=true}});
    if(j&&j.s&&j.s.at>SA){SA=j.s.at;SEEN=j.s.keys||{};attn()}
    if(ch){save();restore(document);arrange();tn()}}).catch(function(){})}catch(e){}}
  document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("button.mr,button.mra");if(!b)return;
    if(b.classList.contains("mr")){var t=b.closest(".task"),h=t&&t.getAttribute("data-h");if(h)R[t.id]=h}
    else [].slice.call(document.querySelectorAll("#g-doneu .task")).forEach(function(t){var h=t.getAttribute("data-h");if(h)R[t.id]=h});
    save();arrange();push()});
  if(MU)setInterval(pull,30000);
  function reveal(id){var t=id&&document.getElementById(id);for(var p=t&&t.parentElement;p;p=p.parentElement)if(p.tagName==="DETAILS")p.open=true}
  document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest('a[href^="#"]');if(a)reveal(a.getAttribute("href").slice(1))});
  function fill(){var el=live();if(!el)return;document.querySelectorAll("[data-trail-slot]").forEach(function(s){
    var k=s.getAttribute("data-trail-slot"),src=null;el.querySelectorAll("[data-trail-for]").forEach(function(x){if(x.getAttribute("data-trail-for")===k)src=x});
    var h=src?src.innerHTML:"";if(s.innerHTML!==h)s.innerHTML=h});
    // the "last update" stamp and the session banner live in the shell and arrive with every payload
    document.querySelectorAll("[data-slot]").forEach(function(s){var k=s.getAttribute("data-slot"),src=null;
      el.querySelectorAll("[data-slot-for]").forEach(function(x){if(x.getAttribute("data-slot-for")===k)src=x});
      if(src&&s.innerHTML!==src.innerHTML)s.innerHTML=src.innerHTML});tn();attn()}
  // ---- the browser tab and the "new" dots. The live block carries (data-attn) the Needs-you count, one attention key per
  // task and the keys the captain last saw. Unseen = keys that differ from the seen ones (nothing is unseen until
  // something has been stored). Looking at the page for 3 s while its tab is visible marks what it showed as seen, and
  // that is shared through the marks endpoint. The tab itself is set through Lavish's window.lavish.setDocumentMeta when
  // the Lavish serving this page has it (stock Lavish does not: then only the dots work).
  var A=null,SEEN=null,SA="",SV=null,metaSig=null,staleNow=false;
  function unseen(){var u=[];if(!A||!SEEN)return u;Object.keys(A.keys).forEach(function(k){if(SEEN[k]!==A.keys[k])u.push(k)});return u}
  function dots(u){var st=document.getElementById("fd-new");
    if(!st){st=document.createElement("style");st.id="fd-new";document.head.appendChild(st)}
    var css=u.filter(function(k){return /^t-[\\w.-]+$/.test(k)}).map(function(k){
      return '[id="'+k+'"] .ttl::after{content:"new";margin-left:8px;padding:1px 6px;border-radius:9px;background:#2563eb;color:#fff;font:600 10px/14px system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;vertical-align:2px}'+
        '.tn-a[data-t="'+k+'"]::after{content:"";position:absolute;right:7px;top:50%;width:7px;height:7px;margin-top:-3.5px;border-radius:50%;background:#2563eb}'}).join("");
    if(st.textContent!==css)st.textContent=css}
  function icon(n,newer){var bad=staleNow,s='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="'+(bad?"#9ca3af":"#1c1b19")+'"/>'+
      '<text x="16" y="23" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="20" fill="#fff">F</text>';
    if(!bad&&n>0)s+='<circle cx="22" cy="22" r="10" fill="#d97706"/><text x="22" y="26.5" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="13" fill="#fff">'+(n>9?"9+":n)+'</text>';
    if(!bad&&newer)s+='<circle cx="25" cy="7" r="6" fill="#2563eb" stroke="#fff" stroke-width="2"/>';
    return "data:image/svg+xml,"+encodeURIComponent(s+"</svg>")}
  function meta(){if(!A)return;var u=unseen(),lv=window.lavish;if(!lv||!lv.setDocumentMeta)return;
    var t=staleNow?"\u26a0 "+A.title:(A.n>0?"("+A.n+") ":"")+(u.length?"* ":"")+A.title,sig=t+"|"+(staleNow?"s":A.n+"/"+(u.length?1:0));
    if(sig===metaSig)return;try{lv.setDocumentMeta({title:t,icon:icon(A.n,u.length>0)});metaSig=sig}catch(e){}}
  function seeSoon(u){if(SV&&(!u.length||document.visibilityState!=="visible")){clearTimeout(SV);SV=null}
    if(SV||!u.length||document.visibilityState!=="visible")return;var shown=JSON.parse(JSON.stringify(A.keys));
    SV=setTimeout(function(){SV=null;if(document.visibilityState!=="visible")return;
      var at=new Date().toISOString();if(at<=SA)at=new Date(Date.parse(SA)+1).toISOString();SA=at;SEEN=shown;
      if(MU)try{fetch(MU,{method:"POST",headers:{"Content-Type":"text/plain"},body:JSON.stringify({s:{at:at,keys:shown}})}).catch(function(){})}catch(e){}
      attn()},3000)}
  function attn(){var el=live(),a=el&&el.querySelector&&el.querySelector("[data-attn]");if(!a)return;var keys={},seen=null;
    try{keys=JSON.parse(a.getAttribute("data-keys")||"{}")}catch(e){}
    try{var sj=a.getAttribute("data-seen");seen=sj?JSON.parse(sj):null}catch(e){}
    if(seen&&seen.at&&seen.at>SA){SA=seen.at;SEEN=seen.keys||{}}
    A={n:parseInt(a.getAttribute("data-n"),10)||0,title:a.getAttribute("data-title")||"",keys:keys};
    var u=unseen();dots(u);meta();seeSoon(u)}
  document.addEventListener("visibilitychange",function(){attn()});
  var Q={};
  function mark(box,opt,msg){box.querySelectorAll("button.opt").forEach(function(b){var on=b.getAttribute("data-opt")===opt;
      b.classList.toggle("on",on);b.setAttribute("aria-pressed",on?"true":"false");
      if(on)b.removeAttribute("disabled");else b.disabled=true});
    var l=box.querySelector(".pickline");if(l){l.hidden=false;l.textContent=msg}}
  function reapply(root){var now=Date.now(),seen={};
    root.querySelectorAll(".opts[data-key]").forEach(function(box){var k=box.getAttribute("data-key"),p=Q[k];if(p&&now-p.at<120000){seen[k]=1;mark(box,p.opt,"You picked "+p.opt+" \u00b7 sending\u2026")}});
    Object.keys(Q).forEach(function(k){if(!seen[k])delete Q[k]})}
  document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("button.opt");if(!b||b.disabled||b.classList.contains("on"))return;
    var box=b.closest(".opts"),card=b.closest("article")||b,l=box.querySelector(".pickline"),lv=window.lavish;
    if(!lv||!lv.queuePrompt){if(l){l.hidden=false;l.textContent="open this page in Lavish to answer"}return}
    var opt=b.getAttribute("data-opt"),k=box.getAttribute("data-key");
    Q[k]={opt:opt,at:Date.now()};mark(box,opt,"You picked "+opt+" \u00b7 sending\u2026");
    try{lv.queuePrompt("Picked: "+opt,{tag:"choice",text:b.getAttribute("data-title")+": "+opt,element:card,queueKey:k,
      data:{kind:"ask-choice",task:b.getAttribute("data-task"),ask:b.getAttribute("data-ask"),option:opt}});
      if(lv.sendQueuedPrompts)lv.sendQueuedPrompts()}
    catch(err){delete Q[k];box.querySelectorAll("button.opt").forEach(function(x){x.disabled=false;x.classList.remove("on");x.setAttribute("aria-pressed","false")});if(l){l.hidden=false;l.textContent="could not send, comment on the card instead"}}});
  restore(document);arrange();pull();reveal(location.hash.slice(1));fill();
  // Keyboard focus survives a live swap: remember the focused element's id (or its <details> id, for a summary) and put focus back.
  function fkey(){var a=document.activeElement,el=live();if(!a||!el||!el.contains||!el.contains(a))return null;
    if(a.id)return a.id;var p=a.parentElement;return a.tagName==="SUMMARY"&&p&&p.id?"sum:"+p.id:null}
  function refocus(k){if(!k)return;var t=null;
    if(k.indexOf("sum:")===0){var d=document.getElementById(k.slice(4));t=d&&d.querySelector&&d.querySelector("summary")}else t=document.getElementById(k);
    if(t&&t.focus)try{t.focus({preventScroll:true})}catch(e){}}
  var last=null,changedAt=Date.now(),token=null,STALE=60000;
  // Staleness is measured on THIS browser's clock only: how long ago the payload last CHANGED (the plugin stamps every
  // render with a growing sequence number and re-renders at least every 20 s). The daemon's timestamp is never compared
  // with the browser's, so a skewed phone clock cannot raise a false alarm or hide a real stall.
  function stale(){var b=document.getElementById("fd-stale");staleNow=(Date.now()-changedAt)>STALE;if(b)b.hidden=!staleNow;meta()}
  setInterval(stale,5000);
  // The page polls a tiny version file (V) every second and loads the full payload (F) only when its content hash moved:
  // an idle tab costs bytes, not the whole page. have is the hash of the payload on screen; loading stops a second fetch
  // while one is in flight.
  var have=null,loading=false;
  function seen(seq,iso){var tk=seq!==undefined&&seq!==null?"s"+seq:(iso?"i"+iso:null);
    if(tk!==null&&tk!==token){token=tk;changedAt=Date.now();stale()}}
  window.__fdVer=function(hash,seq,iso){seen(seq,iso);if(hash&&hash!==have&&!loading)full()};
  window.__fdLive=function(html,iso,seq,hash){seen(seq,iso);loading=false;if(hash)have=hash;
    var el=live();if(!el||html===last)return;last=html;
    var fk=fkey();snapshot();var y=window.scrollY,M="<!--LIVE-",I=window.Idiomorph;
    if(I&&I.morph&&window.Element&&el instanceof window.Element){
      // Morph, do not replace: build the new block off-screen, bring it in line with what this browser has done to the
      // page (open folds, read marks, picked options), then let the morph touch only the nodes that differ. Nothing
      // unchanged is re-created or moved, so embedded canvas frames do not reload and scroll, hover and selection stay.
      var nx=document.createElement("div");nx.innerHTML=html;restore(nx);arrange(nx);reapply(nx);anchorIds(nx);
      I.morph(el,nx,{morphStyle:"innerHTML",restoreFocus:true,callbacks:{
        beforeAttributeUpdated:function(a,n){if(a==="open"&&n.id&&n.id in S)return false},
        beforeNodeMorphed:function(n,m){if(n.nodeName==="IFRAME"&&m.nodeName==="IFRAME"&&n.getAttribute("srcdoc")===m.getAttribute("srcdoc"))return false}}});
      arrange();fill();refocus(fk);if(window.scrollY!==y)window.scrollTo(0,y);return}
    el.innerHTML=M+"START-->"+html+M+"END-->";restore(el);arrange();reapply(el);anchorIds(el);fill();refocus(fk);window.scrollTo(0,y)};
  function load(file,done){var s=document.createElement("script");s.src=file+"?t="+Date.now();s.onload=s.onerror=function(){s.remove();if(done)done()};document.head.appendChild(s)}
  // a full fetch that never answers must not block the next one for good
  function full(){loading=true;load(F,function(){setTimeout(function(){loading=false},4000)})}
  function tick(){if(!loading)load(V)}
  full();tick();setInterval(tick,${Math.max(1, Math.round(tickSeconds)) * 1000});
})();`;
}
