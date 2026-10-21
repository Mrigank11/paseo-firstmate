// The page's inline script, adapted from lh-dev-status.html.
// Lavish's iframe has an opaque origin: localStorage may throw and fetch() cannot read the live data,
// so the live block arrives by re-adding a <script> tag that calls window.__fdLive(html). Open/closed
// <details> state lives in memory, mirrored to localStorage when allowed, else to window.name.
export function pageScript(project: string, liveFile: string, tickSeconds: number): string {
  const j = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  return `(function(){
  var K=${j("fd:" + project + ":state")},P=K+"|",F=${j(liveFile)},ls=null,S={};
  try{localStorage.setItem(K+"t","1");localStorage.removeItem(K+"t");ls=localStorage}catch(e){}
  try{var raw=(ls&&ls.getItem(K))||(window.name.indexOf(P)===0?window.name.slice(P.length):"");if(raw)S=JSON.parse(raw)||{}}catch(e){}
  function save(){var s=JSON.stringify(S);try{if(ls)ls.setItem(K,s)}catch(e){}
    try{if(!window.name||window.name.indexOf(P)===0)window.name=P+s}catch(e){}}
  function live(){return document.getElementById("live")}
  function snapshot(){var el=live();if(!el)return;el.querySelectorAll("details[id]").forEach(function(d){S[d.id]=d.open?1:0});save()}
  function restore(root){root.querySelectorAll("details[id]").forEach(function(d){if(d.id in S)d.open=!!S[d.id]})}
  document.addEventListener("toggle",function(e){var d=e.target;if(d&&d.id){S[d.id]=d.open?1:0;save()}},true);
  function reveal(id){var t=id&&document.getElementById(id);for(var p=t&&t.parentElement;p;p=p.parentElement)if(p.tagName==="DETAILS")p.open=true}
  document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest('a[href^="#"]');if(a)reveal(a.getAttribute("href").slice(1))});
  function fill(){var el=live();if(!el)return;document.querySelectorAll("[data-trail-slot]").forEach(function(s){
    var k=s.getAttribute("data-trail-slot"),src=null;el.querySelectorAll("[data-trail-for]").forEach(function(x){if(x.getAttribute("data-trail-for")===k)src=x});
    s.innerHTML=src?src.innerHTML:""})}
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
  restore(document);reveal(location.hash.slice(1));fill();
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
  function stale(){var b=document.getElementById("fd-stale");if(b)b.hidden=!((Date.now()-changedAt)>STALE)}
  setInterval(stale,5000);
  window.__fdLive=function(html,iso,seq){var tk=seq!==undefined&&seq!==null?"s"+seq:(iso?"i"+iso:null);
    if(tk!==null&&tk!==token){token=tk;changedAt=Date.now();stale()}
    var el=live();if(!el||html===last)return;last=html;
    var fk=fkey();snapshot();var y=window.scrollY,M="<!--LIVE-";el.innerHTML=M+"START-->"+html+M+"END-->";restore(el);reapply(el);fill();refocus(fk);window.scrollTo(0,y)};
  function tick(){var s=document.createElement("script");s.src=F+"?t="+Date.now();s.onload=s.onerror=function(){s.remove()};document.head.appendChild(s)}
  tick();setInterval(tick,${Math.max(1, Math.round(tickSeconds)) * 1000});
})();`;
}
