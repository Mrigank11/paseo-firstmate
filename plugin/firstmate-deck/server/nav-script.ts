// The task navigator's inline script. The live block carries a hidden template (render.ts navHtml: one .tn-st per
// non-empty stage, titles linking to the cards); this script builds the chrome from it, outside the live block, so a
// live swap never resets it:
//   - 640 px and up: a fixed left rail. Folded it is a 48 px spine of stage badges (hover or tap one: its titles fly
//     out beside it); unfolded it lists every stage's titles (it pushes the page at 1200 px and up, overlays it below).
//   - under 640 px: a bar under the sticky nav with the stage counts and the first title that needs the captain;
//     tapping it drops down a sheet with the full list.
// The page script calls window.__tn() after every swap and every read-mark change. The fold choice ("tn-exp", 1 or 0) is
// kept in the page script's state (window.__fdPref), which survives a page reload inside Lavish's sandboxed iframe
// (localStorage is blocked there) and syncs through the marks endpoint like the open/closed sections.
import { ICON, svg } from "./icons.ts";

export function navScript(): string {
  return `(function(){
  var d=document,body=d.body,$=function(i){return d.getElementById(i)};
  var aside=$("tn"),bds=$("tn-bds"),fl=$("tn-fl"),fly=$("tn-fly"),sheet=$("tn-sheet"),sl=$("tn-sl"),back=$("tn-back"),bar=$("tn-bar"),
    openB=$("tn-open"),closeB=$("tn-close"),sx=$("tn-sx");
  if(!aside||!bar||!sheet)return;
  var mq=function(q){return window.matchMedia?window.matchMedia(q).matches:false};
  var phone=function(){return mq("(max-width:639px)")},wide=function(){return mq("(min-width:1200px)")};
  var PK="tn-exp",pref=function(){return window.__fdPref?window.__fdPref(PK):undefined},applied=null;
  var exp=false,tpl="",cur=null,flyKey=null,flyPin=false,hideT=null,more={},io=null,vis={},lastFocus=null;
  function q(root,sel){return [].slice.call(root.querySelectorAll(sel))}
  function setExp(v,save){exp=v;body.classList.toggle("tn-exp",v);openB.setAttribute("aria-expanded",v?"true":"false");closeFly(true);
    if(save){applied=v?1:0;if(window.__fdPref)window.__fdPref(PK,applied)}}
  // apply the stored choice on load, and again when it changes (the marks endpoint can bring it in after load); only at
  // 1200 px and up, where the unfolded rail pushes the page instead of covering it. No choice yet: unfolded.
  function adopt(){var p=pref();if(p===undefined)p=1;if(p===applied)return;applied=p;if(wide())setExp(p===1,false)}
  // ---- build from the template
  function stages(){return q(fl,".tn-st")}
  function applyMore(root){q(root,".tn-st[data-cap]").forEach(function(s){var on=!!more[s.getAttribute("data-k")],b=s.querySelector(".tn-more");
    s.classList.toggle("all",on);if(b){b.setAttribute("aria-expanded",on?"true":"false");var t=b.querySelector("span");if(t)t.textContent=on?"Show fewer":b.getAttribute("data-more")}})}
  function el(tag,cls,text){var e=d.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
  function badge(s,tagName){var k=s.getAttribute("data-k"),n=s.getAttribute("data-n"),b=el(tagName,(tagName==="button"?"tn-bd":"tn-chip")+" t-"+k);
    var ic=s.querySelector(".tn-h svg");if(ic)b.appendChild(ic.cloneNode(true));b.appendChild(el("span","tn-n",n));
    if(tagName==="button"){b.type="button";b.setAttribute("data-k",k);b.setAttribute("aria-controls","tn-fly");b.setAttribute("aria-expanded",flyKey===k?"true":"false");
      b.setAttribute("aria-label",s.getAttribute("data-label")+", "+n+(n==="1"?" task":" tasks"));b.title=s.getAttribute("data-label")+" ("+n+")"}
    return b}
  function build(html){fl.innerHTML=html;sl.innerHTML=html;applyMore(fl);applyMore(sl);
    var ss=stages(),on=ss.length>0;aside.hidden=!on;bar.hidden=!on;body.classList.toggle("tn-on",on);
    bds.textContent="";bar.textContent="";
    ss.forEach(function(s){bds.appendChild(badge(s,"button"));bar.appendChild(badge(s,"span"))});
    var you=fl.querySelector('.tn-st[data-k="you"] .tn-a'),t=el("span","tn-bt"+(you?"":" none"),you?you.textContent:"Nothing needs you");
    bar.appendChild(t);var c=el("span","tn-caret");c.innerHTML=${JSON.stringify(svg(ICON.down))};bar.appendChild(c);
    bar.setAttribute("aria-label","Tasks by stage"+(you?": "+ss[0].getAttribute("data-n")+" need you":""));
    if(flyKey){if(fl.querySelector('.tn-st[data-k="'+flyKey+'"]'))renderFly();else closeFly(true)}
    if(!on&&!sheet.hidden)closeSheet(false)}
  function unread(){var u=$("g-doneu"),ids={};if(u&&!u.hidden)q(u,".task[id]").forEach(function(t){ids[t.id]=1});
    [fl,sl,fly].forEach(function(r){q(r,".tn-a").forEach(function(a){a.parentNode.classList.toggle("un",!!ids[a.getAttribute("data-t")])})})}
  window.__tn=function(){var live=$("live"),src=live&&live.querySelector("[data-tn]"),html=src?src.innerHTML:"";
    if(html!==tpl){tpl=html;var y=fl.scrollTop;build(html);fl.scrollTop=y}
    adopt();unread();observe();mark()};
  // ---- flyout beside the spine
  function renderFly(){var s=fl.querySelector('.tn-st[data-k="'+flyKey+'"]');if(!s)return;
    fly.innerHTML="";fly.appendChild(s.cloneNode(true));applyMore(fly);unread();mark();fly.hidden=false;
    var b=bds.querySelector('.tn-bd[data-k="'+flyKey+'"]');
    if(b){var r=b.getBoundingClientRect();fly.style.top=Math.max(8,Math.min(r.top,window.innerHeight-fly.offsetHeight-8))+"px"}
    q(bds,".tn-bd").forEach(function(x){x.setAttribute("aria-expanded",x.getAttribute("data-k")===flyKey?"true":"false")})}
  function openFly(k,pin){clearTimeout(hideT);flyKey=k;flyPin=!!pin;renderFly()}
  function closeFly(now){clearTimeout(hideT);var f=function(){flyKey=null;flyPin=false;fly.hidden=true;
      q(bds,".tn-bd").forEach(function(x){x.setAttribute("aria-expanded","false")})};
    if(now)f();else if(!flyPin)hideT=setTimeout(f,250)}
  var hover=function(){return mq("(hover:hover)")};
  bds.addEventListener("mouseover",function(e){var b=e.target.closest&&e.target.closest(".tn-bd");if(b&&!flyPin&&hover())openFly(b.getAttribute("data-k"),false)});
  bds.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest(".tn-bd");if(!b)return;var k=b.getAttribute("data-k");
    if(flyKey===k&&flyPin)closeFly(true);else{openFly(k,true);if(e.detail===0){var a=fly.querySelector(".tn-a");if(a)a.focus()}}});
  aside.addEventListener("mouseleave",function(){closeFly(false)});
  fly.addEventListener("mouseenter",function(){clearTimeout(hideT)});
  fly.addEventListener("mouseleave",function(){closeFly(false)});
  // ---- jumping to a card
  function go(id){var t=$(id);if(!t)return;
    for(var p=t.parentElement;p;p=p.parentElement)if(p.tagName==="DETAILS"&&!p.open)p.open=true;
    if(location.hash==="#"+id)t.scrollIntoView();else location.hash=id;
    setCur(id)}
  function onClick(e){var m=e.target.closest&&e.target.closest(".tn-more");
    if(m){var s=m.closest(".tn-st"),k=s&&s.getAttribute("data-k");more[k]=!more[k];[fl,sl,fly].forEach(applyMore);if(!fly.hidden)renderFly();return}
    var a=e.target.closest&&e.target.closest(".tn-a");if(!a)return;e.preventDefault();
    if(!sheet.hidden)closeSheet(false);closeFly(true);if(exp&&!wide())setExp(false,false);
    go(a.getAttribute("data-t"))}
  [fl,fly,sheet].forEach(function(r){r.addEventListener("click",onClick)});
  openB.addEventListener("click",function(){setExp(true,true);closeB.focus()});
  closeB.addEventListener("click",function(){setExp(false,true);openB.focus()});
  d.addEventListener("pointerdown",function(e){var t=e.target;
    if(flyKey&&!fly.contains(t)&&!aside.contains(t))closeFly(true);
    if(exp&&!wide()&&!phone()&&!aside.contains(t))setExp(false,false)});
  // ---- phone sheet
  function openSheet(){lastFocus=d.activeElement;var r=bar.getBoundingClientRect();sheet.style.top=r.bottom+"px";
    sheet.hidden=back.hidden=false;bar.setAttribute("aria-expanded","true");body.classList.add("tn-lock");
    var a=sheet.querySelector(".tn-a");(a||sx).focus()}
  function closeSheet(ret){if(sheet.hidden)return;sheet.hidden=back.hidden=true;bar.setAttribute("aria-expanded","false");body.classList.remove("tn-lock");
    if(ret!==false)bar.focus()}
  bar.addEventListener("click",function(){if(sheet.hidden)openSheet();else closeSheet()});
  back.addEventListener("click",function(){closeSheet()});sx.addEventListener("click",function(){closeSheet()});
  d.addEventListener("keydown",function(e){
    if(e.key==="Tab"&&!sheet.hidden){var f=q(sheet,"a,button").filter(function(x){return x.offsetParent!==null});if(!f.length)return;
      var first=f[0],last=f[f.length-1];if(e.shiftKey&&d.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&d.activeElement===last){e.preventDefault();first.focus()}return}
    if(e.key!=="Escape")return;
    if(!sheet.hidden){e.preventDefault();closeSheet()}
    else if(flyKey){var b=bds.querySelector('.tn-bd[data-k="'+flyKey+'"]');closeFly(true);if(b)b.focus()}
    else if(exp&&!wide()&&!phone()){setExp(false,false);openB.focus()}});
  // ---- the card in view: its title and its stage badge are marked
  function stageOf(id){var a=fl.querySelector('.tn-a[data-t="'+id+'"]'),s=a&&a.closest(".tn-st");return s?s.getAttribute("data-k"):null}
  function mark(){q(d,".tn-a[aria-current]").forEach(function(a){a.removeAttribute("aria-current")});
    q(bds,".tn-bd[aria-current]").forEach(function(b){b.removeAttribute("aria-current")});if(!cur)return;
    [fl,sl,fly].forEach(function(r){var a=r.querySelector('.tn-a[data-t="'+cur+'"]');if(!a)return;a.setAttribute("aria-current","true");
      if(r===fl&&exp){var ar=a.getBoundingClientRect(),fr=fl.getBoundingClientRect();
        if(ar.top<fr.top||ar.bottom>fr.bottom)fl.scrollTop+=ar.top-fr.top-fr.height/3}});
    var b=bds.querySelector('.tn-bd[data-k="'+stageOf(cur)+'"]');if(b)b.setAttribute("aria-current","true")}
  function setCur(id){if(id===cur)return;cur=id;mark()}
  function observe(){if(!window.IntersectionObserver)return;if(io)io.disconnect();vis={};
    io=new IntersectionObserver(function(es){es.forEach(function(e){vis[e.target.id]=e.isIntersecting});
      var best=null,bt=1e9;Object.keys(vis).forEach(function(id){var t=vis[id]&&$(id);if(!t)return;var top=t.getBoundingClientRect().top;if(top<bt){bt=top;best=id}});
      if(best)setCur(best)},{rootMargin:"-60px 0px -55% 0px"});
    var live=$("live");if(live)q(live,"article.task[id]").forEach(function(t){io.observe(t)})}
  function measure(){var n=d.querySelector("main > nav");if(n)d.documentElement.style.setProperty("--navh",n.offsetHeight+"px")}
  window.addEventListener("resize",function(){measure();if(!phone())closeSheet(false);if(exp&&!wide())setExp(false,false);else if(!exp&&wide()&&applied!==0)setExp(true,false);if(flyKey)renderFly()});
  measure();setExp(exp,false);
})();`;
}
