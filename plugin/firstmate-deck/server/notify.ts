// "Notify me": notifications for tasks that enter Needs you, with no window kept open.
//
// The project page runs in Lavish's sandboxed frame (opaque origin), where browsers refuse notifications and service
// workers. So the page's button opens a tab served by the deck's own web server, which has a real origin: it asks the
// browser once, registers the service worker and subscribes, and can then be closed. push.ts sends from then on.
// Browsers allow this on https and localhost only; Firefox also on a host named in dom.securecontext.allowlist. The plugin
// setting `notifyUrl` is an https address of the deck's web server, e.g. behind `tailscale serve`.
//
// This file: which tasks are waiting and which of those are news, and the browser's side (page, tab, worker).
import type { CanvasData } from "./canvas-port.ts";
import type { Stage } from "./stage.ts";
import type { Task } from "./state.ts";

/** `wait` names what the task is waiting for (an ask, a canvas question...); "" when two waits cannot be told apart. */
export type NeedsItem = { id: string; title: string; reason: string; wait: string };
export type Needs = { partial: boolean; tasks: NeedsItem[] };

const REASON_MAX = 180;

/** Plain words on one line: a notification renders no Markdown. */
function plain(text: string): string {
  const t = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]+|^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  return t.length > REASON_MAX ? `${t.slice(0, REASON_MAX - 1).trimEnd()}…` : t;
}

/** The first question still open on a crew canvas, for a Needs-you line that has no registry ask behind it. */
export const canvasQuestion = (canvas: CanvasData | undefined, agentId: string | null): string =>
  canvas?.summaries[agentId ?? ""]?.openAsks.find((a) => !a.pending)?.question ?? "";

function why(t: Task, s: Stage, canvas?: CanvasData): { reason: string; wait: string } {
  // a permission request has no name here, so each entry counts as its own
  if (s.stage === "Needs you · permission") return { reason: "A crew is waiting for your permission answer.", wait: "" };
  if (s.stage === "Needs you · first mate stalled") return { reason: "The first mate stalled on this task.", wait: `stalled ${s.fp}` };
  const ask = t.asks.find((a) => !a.repliedAt);
  if (ask?.text) return { reason: plain(ask.text), wait: `ask ${ask.id} ${ask.since ?? ""} ${ask.text}` };
  const question = canvasQuestion(canvas, s.agentId);
  if (question) return { reason: plain(question), wait: `canvas ${s.agentId} ${question}` };
  return { reason: plain(t.notes || "Needs your call"), wait: "" };
}

/** The tasks in the page's "Needs you" group. */
export function needsList(tasks: readonly Task[], stages: ReadonlyMap<string, Stage>, canvas?: CanvasData): NeedsItem[] {
  return tasks.flatMap((t) => {
    const s = stages.get(t.id);
    return s?.group === "you" ? [{ id: t.id, title: t.title || t.intent || t.id, ...why(t, s, canvas) }] : [];
  });
}

/** What a project was waiting for last time. `left` = when a task was first seen gone (0 = waiting). */
export type Seen = { whole: boolean; held: Record<string, { wait: string; left: number }> };
const GRACE_MS = 60_000;

// A task is news when it enters the list; the first list is the starting point and is news to nobody. One that drops out
// for under a minute and returns waiting for the same thing is the same wait (a status blip). A partial list adds tasks
// but removes none; watching that started on one takes the first whole list as part of its start.
export function track(before: Seen | undefined, needs: Needs, now: number): { seen: Seen; fresh: NeedsItem[] } {
  const starting = !before || (!before.whole && !needs.partial);
  const held: Seen["held"] = { ...before?.held };
  const fresh: NeedsItem[] = [];
  for (const t of needs.tasks) {
    const h = Object.hasOwn(held, t.id) ? held[t.id] : undefined;
    if (!starting && (!h || (h.left && (!t.wait || h.wait !== t.wait || now - h.left >= GRACE_MS)))) fresh.push(t);
    held[t.id] = { wait: t.wait, left: 0 };
  }
  if (!needs.partial) {
    const here = new Set(needs.tasks.map((t) => t.id));
    for (const [id, h] of Object.entries(held)) {
      if (here.has(id)) continue;
      if (!h.left) held[id] = { ...h, left: now };
      else if (now - h.left >= GRACE_MS) delete held[id];
    }
  }
  return { seen: { whole: !!before?.whole || !needs.partial, held }, fresh };
}

const j = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

// The opt-in tab. Its key travels in the #fragment, so the served page holds no secret.
const tabScript = (publicKey: string) => `(function(){
  var K=${j(publicKey)};
  var $=function(i){return document.getElementById(i)},allow=$("allow");
  var key=(/[#&]k=([^&]*)/.exec(location.hash)||[])[1]||"";
  function say(t){$("msg").textContent=t}
  var told=Promise.resolve();
  function tell(e,d){told=told.then(function(){return fetch("report",{method:"POST",keepalive:true,body:JSON.stringify({k:key,e:e,d:d||""})}).catch(function(){})})}
  function bytes(s){var b=atob(s.replace(/-/g,"+").replace(/_/g,"/")),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
  function same(a,b){a=new Uint8Array(a||[]);return a.length===b.length&&b.every(function(v,i){return a[i]===v})}
  function subscribe(){say("Setting up…");
    var wanted=bytes(K),slow=setTimeout(function(){say("Still waiting for the browser's push service. Check this computer's internet connection.");tell("error","no answer from the push service after 30 s")},30000);
    navigator.serviceWorker.register("sw.js").then(function(reg){
      return navigator.serviceWorker.ready.then(function(){return reg.pushManager.getSubscription()}).then(function(s){
        // made for keys the deck no longer has
        if(s&&!same(s.options.applicationServerKey,wanted))return s.unsubscribe().then(function(){return null});return s
      }).then(function(s){return s||reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:wanted})})
    }).then(function(s){clearTimeout(slow);
      return fetch("subscribe",{method:"POST",body:JSON.stringify({k:key,sub:s.toJSON()})}).then(function(r){
        if(r.status===403){tell("error","this tab's key is out of date");say("This tab is out of date. Close it and press Notify me on the project page again.");return}
        if(!r.ok)throw new Error("the deck answered "+r.status);
        say("Notifications are on for every project. You can close this tab; they arrive while the browser is running.")})
    }).catch(function(e){clearTimeout(slow);tell("error",e.message);say("Could not turn notifications on: "+e.message)})}
  function blocked(){say("Notifications are blocked for this address. Allow them from the icon left of the address, then reload this tab.")}
  allow.onclick=function(){return Notification.requestPermission().then(function(r){tell("allow",r);
    if(r==="default"){say("Not allowed yet. Press the button again and choose Allow.");return}
    allow.hidden=true;if(r==="granted")subscribe();else blocked()})};
  var N=window.Notification;
  tell("open","secure="+(window.isSecureContext?"yes":"no")+" permission="+(N?N.permission:"none")+" push="+(window.PushManager&&navigator.serviceWorker?"yes":"no"));
  if(!window.isSecureContext)say("This address cannot send notifications: browsers only allow them over https. In Firefox on this computer you can instead open about:config, set dom.securecontext.allowlist to "+location.hostname+" and reload this tab.");
  else if(!N||!window.PushManager||!navigator.serviceWorker)say("This browser cannot receive notifications from the deck (private windows cannot).");
  else if(N.permission==="granted")subscribe();
  else if(N.permission==="denied")blocked();
  else{say("Get a notification when a task needs you, with no window kept open.");allow.hidden=false}
})();`;

/** The opt-in page. */
export function notifyPageHtml(publicKey: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notify me</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;padding:24px 16px;max-width:30em;background:Canvas;color:CanvasText}
h1{font-size:17px;margin:0 0 8px}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}
</style></head><body>
<h1>Notify me</h1>
<p id="msg" role="status">Starting…</p>
<button id="allow" type="button" hidden>Allow notifications</button>
<script>
${tabScript(publicKey)}
</script></body></html>
`;
}

/** The service worker: the browser wakes it for each message, with no tab open. */
export function serviceWorkerScript(): string {
  return `"use strict";
function report(m,e,d){return m?fetch("report",{method:"POST",body:JSON.stringify({m:m,e:e,d:d||""})}).catch(function(){}):Promise.resolve()}
self.addEventListener("install",function(){self.skipWaiting()});
self.addEventListener("push",function(event){
  var d={};try{d=event.data.json()||{}}catch(x){}
  // every message must show something, or the browser withdraws the subscription
  var shown=self.registration.showNotification(d.title||"Deck",{body:d.body||"A task needs you.",tag:d.tag,data:{url:d.url,m:d.m}});
  var got=report(d.m,"received");
  event.waitUntil(shown.then(function(){return got.then(function(){return report(d.m,"shown")})},function(x){return got.then(function(){return report(d.m,"error",x.message)})}));
});
self.addEventListener("notificationclick",function(event){
  var d=event.notification.data||{};event.notification.close();
  // opening a window is allowed only straight from the click
  var opened=d.url?clients.openWindow(d.url):Promise.resolve();
  event.waitUntil(Promise.all([opened,report(d.m,"click")]));
});
`;
}

/** The project page's side: the "Notify me" button opens the opt-in tab at `url`. */
export function notifyPageSide(url: string): string {
  return `(function(){
  var b=document.getElementById("fd-notify");
  if(b)b.addEventListener("click",function(){window.open(${j(url)},"_blank")});
})();`;
}
