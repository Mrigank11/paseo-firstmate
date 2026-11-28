// "Notify me": browser notifications for tasks that enter Needs you.
//
// The project page runs in Lavish's sandboxed frame (opaque origin), where browsers refuse notifications. So the page's
// button opens a small window served by the deck's own web server (marks-server.ts), which has a real origin and asks
// the browser once. That window reads the Needs-you list every few seconds and notifies what is new while it is open.
// Browsers allow this on https (or localhost) only: the plugin setting `notifyUrl` is the https address of the deck's
// web server, e.g. behind `tailscale serve`.
//
//   GET /<project>/notify          the window (no data in it; its key travels in the address's #fragment)
//   GET /<project>/needs?k=<key>   {page, tasks:[{id,title,reason}]}; 503 while the deck has not read everything yet
import type { CanvasData } from "./canvas-port.ts";
import type { Stage } from "./stage.ts";
import type { Task } from "./state.ts";

export type NeedsItem = { id: string; title: string; reason: string };

const REASON_MAX = 180;

/** Plain words on one line: a notification renders no Markdown. */
function plain(text: string): string {
  const t = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]+|^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  return t.length > REASON_MAX ? `${t.slice(0, REASON_MAX - 1).trimEnd()}…` : t;
}

/** The first question still open on a crew canvas, for a Needs-you line that has no registry ask behind it. */
export const canvasQuestion = (canvas: CanvasData | undefined, agentId: string | null): string =>
  canvas?.summaries[agentId ?? ""]?.openAsks.find((a) => !a.pending)?.question ?? "";

function reasonOf(t: Task, s: Stage, canvas?: CanvasData): string {
  if (s.stage === "Needs you · permission") return "A crew is waiting for your permission answer.";
  if (s.stage === "Needs you · first mate stalled") return "The first mate stalled on this task.";
  return plain(t.asks.find((a) => !a.repliedAt)?.text || canvasQuestion(canvas, s.agentId) || t.notes || "Needs your call");
}

/** The tasks in the page's "Needs you" group. */
export function needsList(tasks: readonly Task[], stages: ReadonlyMap<string, Stage>, canvas?: CanvasData): NeedsItem[] {
  return tasks.flatMap((t) => {
    const s = stages.get(t.id);
    return s?.group === "you" ? [{ id: t.id, title: t.title || t.intent || t.id, reason: reasonOf(t, s, canvas) }] : [];
  });
}

const j = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// A task is notified when it enters the list; the list at opening is the starting point, so a reload repeats nothing.
// One that drops out for under a minute and returns with the same reason is the same wait (a restart, a status blip).
// One window per project watches: the newest takes the lock, an older one closes.
// A click brings the project page's tab forward (the tab, not the frame: it survives a reload) and asks it for the card.
const windowScript = (project: string) => `(function(){
  var P=${j(project)},EVERY=5000,GRACE=60000;
  var $=function(i){return document.getElementById(i)},allow=$("allow");
  var key=(/[#&]k=([^&]*)/.exec(location.hash)||[])[1]||"";
  var held=null,page="",tab=null,pending="",stopped=false;
  try{if(window.opener)tab=window.opener.top}catch(e){}
  function say(t){$("msg").textContent=t}
  function focusMsg(task){return {type:"fm-notify-focus",task:task}}
  function show(task){var open=false;try{open=!!tab&&!tab.closed}catch(e){}
    if(open){try{tab.focus()}catch(e){}for(var i=0;i<tab.length;i++)try{tab[i].postMessage(focusMsg(task),"*")}catch(e){}}
    else if(page){pending=task;window.open(page,"_blank")}
    else window.focus()}
  window.addEventListener("message",function(e){if(!pending||!e.data||e.data.type!=="fm-notify-hello"||!e.source)return;
    try{tab=e.source.top}catch(x){}e.source.postMessage(focusMsg(pending),"*");pending=""});
  function fire(t){try{var n=new Notification(t.title,{body:t.reason,tag:"fm:"+P+":"+t.id,renotify:true});
    n.onclick=function(e){e.preventDefault();n.close();show(t.id)}}catch(e){say("This browser could not show a notification: "+e.message)}}
  function step(tasks){var now=Date.now(),first=!held,seen=Object.create(null);if(first)held=Object.create(null);
    tasks.forEach(function(t){var h=held[t.id];seen[t.id]=1;
      if(!first&&(!h||(h.left&&(h.reason!==t.reason||now-h.left>=GRACE))))fire(t);
      held[t.id]={reason:t.reason,left:0}});
    Object.keys(held).forEach(function(id){if(seen[id])return;var h=held[id];if(!h.left)h.left=now;else if(now-h.left>=GRACE)delete held[id]})}
  function poll(){if(stopped)return;
    fetch("needs?k="+encodeURIComponent(key),{cache:"no-store"}).then(function(r){
      if(r.status===403){stopped=true;say("This window is out of date. Close it and press Notify me on the project page again.");return}
      if(r.status===503){say("Waiting for the deck to finish reading the tasks…");return}
      if(!r.ok)throw new Error(String(r.status));
      return r.json().then(function(b){if(stopped)return;page=b.page||"";step(b.tasks);var n=b.tasks.length;
        say("Watching. Keep this window open (minimised is fine). "+(n===1?"1 task needs you":n+" tasks need you")+" now.")})
    }).catch(function(){say("Can't reach the deck. Trying again…")}).then(function(){if(!stopped)setTimeout(poll,EVERY)})}
  function watch(){say("Starting…");
    navigator.locks.request("fm-notify-"+P,{steal:true},function(){poll();return new Promise(function(){})})
      .catch(function(){stopped=true;say("A newer window is watching now.");window.close()})}
  function blocked(){say("Notifications are blocked for this address. Allow them from the icon left of the address, then reload this window.")}
  allow.onclick=function(){return Notification.requestPermission().then(function(r){
    if(r==="default"){say("Not allowed yet. Press the button again and choose Allow.");return}
    allow.hidden=true;if(r==="granted")watch();else blocked()})};
  if(!window.isSecureContext)say("This address cannot send notifications: browsers only allow them over https. Ask the first mate for the https address, or, in Firefox on this computer, open about:config, set dom.securecontext.allowlist to "+location.hostname+" and reload this window.");
  else if(!("Notification" in window))say("This browser has no notifications.");
  else if(Notification.permission==="granted")watch();
  else if(Notification.permission==="denied")blocked();
  else{say("Get a notification when a task needs you.");allow.hidden=false}
})();`;

/** The notification window's page. */
export function notifyWindowHtml(project: string, title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notify me · ${esc(title)}</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:20px;background:Canvas;color:CanvasText}
h1{font-size:17px;margin:0 0 8px}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}
</style></head><body>
<h1>${esc(title)}</h1>
<p id="msg" role="status">Starting…</p>
<button id="allow" type="button" hidden>Allow notifications</button>
<script>
${windowScript(project)}
</script></body></html>
`;
}

/**
 * The project page's side: the "Notify me" button opens the window at `url`, and that window (nobody else) may ask the
 * page to show a card. A card that is not drawn yet is shown after the next update (window.__tn runs after each).
 */
export function notifyPageSide(project: string, url: string): string {
  return `(function(){
  var U=${j(url)},O=new URL(U).origin,want="";
  var b=document.getElementById("fd-notify");
  if(b)b.addEventListener("click",function(){window.open(U,${j(`fm-notify-${project}`)},"popup,width=420,height=300")});
  function flush(){if(want&&window.__fdGo&&window.__fdGo("t-"+want))want=""}
  var tn=window.__tn;window.__tn=function(){if(tn)tn.apply(this,arguments);flush()};
  window.addEventListener("message",function(e){var m=e.data;if(e.origin!==O||!m||m.type!=="fm-notify-focus"||typeof m.task!=="string")return;want=m.task;flush()});
  try{if(window.top.opener)window.top.opener.postMessage({type:"fm-notify-hello"},O)}catch(x){}
})();`;
}
