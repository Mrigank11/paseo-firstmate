// Page stylesheet, ported from lh-dev-status.html.
export const CSS = String.raw`:root{--bg:#f7f6f2;--fg:#1c1b19;--mut:#625f57;--line:#e4e0d4;--soft:#f1efe8;--you:#b4410c;--youbg:#fff4ea;--run:#1d4ed8;--ok:#15803d;--park:#665f58}
*,*::before,*::after{box-sizing:border-box}
html,body{background:var(--bg);color:var(--fg);margin:0;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;-webkit-text-size-adjust:100%}
::selection{background:#fde6cf}
a{color:#1d4ed8;text-underline-offset:2px}a:hover{color:#1e3a8a}
:focus-visible{outline:2px solid var(--you);outline-offset:2px;border-radius:3px}
main{max-width:980px;margin:0 auto;padding:24px 20px 80px}
h1{font-size:23px;letter-spacing:-.02em;margin:0 0 2px}.sub{color:var(--mut);font-size:13px}
.chan{color:var(--mut);font-size:13px;margin:10px 0 0;max-width:75ch}
nav{position:sticky;top:0;z-index:5;background:var(--bg);margin:14px -20px 0;padding:8px 20px;border-bottom:1px solid var(--line);display:flex;gap:16px;overflow-x:auto;white-space:nowrap;font-size:13px}
nav a{color:var(--mut);text-decoration:none}nav a:hover{color:var(--fg)}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:36px 0 10px;scroll-margin-top:48px}
h3{font-size:15px;margin:0;display:inline}
.nt h3,.nt h4,[data-section] h3,[data-section] h4,.actx h3,.actx h4{display:block;margin:12px 0 4px;font-size:14px}
.m{color:var(--mut);font-size:13px}.t{font-weight:600}
code{font:12.5px ui-monospace,monospace;background:var(--soft);padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}
ul{margin:4px 0;padding-left:20px}li{margin:3px 0}.dec li{margin:6px 0}
.when{font:12px ui-monospace,monospace;color:#665f58;margin-right:6px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:8px 0}
.tw{overflow-x:auto;margin-top:8px}.tw table{width:100%;border-collapse:collapse;font-size:13px;min-width:520px}
th{text-align:left;color:var(--mut);font-weight:600;border-bottom:1px solid var(--line);padding:4px 8px 4px 0}
td{border-bottom:1px solid #efece4;padding:5px 8px 5px 0;vertical-align:top;font-variant-numeric:tabular-nums}
/* task view */
.summary{display:flex;flex-wrap:wrap;gap:4px 18px;align-items:baseline;font-size:14px;margin:10px 0 6px}
.sum{font-weight:600;text-decoration:none}
.grp{margin:18px 0 0;scroll-margin-top:48px}
.grp>h3,.grp>summary{display:block;padding:6px 0;border-bottom:1px solid var(--line)}
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
summary::before{content:"";display:inline-block;width:7px;height:7px;border-right:2px solid var(--mut);border-bottom:2px solid var(--mut);transform:rotate(-45deg);margin:0 10px 2px 2px;transition:transform .15s}
details[open]>summary::before{transform:rotate(45deg)}
.n{font-weight:500;color:var(--mut);font-size:13px;margin-left:4px}
.task{padding:12px 0;border-bottom:1px solid var(--line);scroll-margin-top:48px}
.task:target{background:#fffbe6}
.s-you{background:var(--youbg);padding:12px 14px;border:1px solid #f3d5bc;border-radius:12px;margin:10px 0}
.tt{display:flex;gap:10px;align-items:baseline}
.ttl{font-weight:600;font-size:15.5px}.ttl a{color:inherit;text-decoration-color:#b8b2a3}
.chip{flex:none;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--soft);color:var(--mut)}
.c-fm{color:var(--mut)}.c-you{color:var(--you)}.chip.c-you{background:#fde6cf}.c-running{color:var(--run)}.chip.c-running{background:#dbeafe}
.c-done{color:var(--ok)}.chip.c-done{background:#dcfce7}.c-next{color:var(--fg)}.c-parked{color:var(--park)}.c-blocked{color:var(--park)}.bo{font-size:13.5px;color:var(--mut);margin-top:4px}.bo b{color:var(--fg)}
.ask{margin:8px 0 2px;font-size:14.5px;max-width:75ch}.ask.asked,.ask.replied{color:var(--mut);font-size:13.5px}.ask.replied{margin-top:2px;font-style:italic}
.ag{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12.5px;color:var(--mut);margin-top:6px}
.pill{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:12px;padding:2px 9px 2px 8px;border-radius:999px;background:var(--soft);color:var(--park)}
.pill .dot{width:7px;height:7px;border-radius:50%;background:currentColor;margin:0}
.p-running{background:#dbeafe;color:var(--run)}.p-running .dot{animation:pulse 1.4s ease-in-out infinite}
.p-you{background:#fde6cf;color:var(--you)}.p-done{background:#dcfce7;color:var(--ok)}.p-error{background:#fee2e2;color:#b91c1c}
@keyframes pulse{50%{opacity:.3}}@media (prefers-reduced-motion:reduce){.p-running .dot{animation:none}}
.facts{font-variant-numeric:tabular-nums}.open{margin-left:auto;font-weight:500}
.cur{font-size:13px;color:#3d3a34;margin-top:6px;max-width:80ch}
details.stp>summary.cur{display:block}
details.stp>summary.cur::before{width:5px;height:5px;margin:0 8px 2px 1px}
.stp ol{margin:6px 0 2px;padding:8px 12px 8px 34px;background:#fff;border:1px solid var(--line);border-radius:8px;font:12px/1.5 ui-monospace,monospace;color:#4a4740}
.stp li{margin:1px 0;overflow-wrap:anywhere}
.nt{font-size:13.5px;margin-top:4px;max-width:80ch}
.dp{font-size:12.5px;color:var(--mut);margin-top:4px}.dp a{color:var(--mut)}
.s-done .ttl{font-weight:500}
/* comment trail + ask options */
.trail{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin:6px 0 2px;font-size:13px;color:var(--mut);max-width:80ch}
.trail-slot:empty{display:none}.trail-slot .trail{margin:8px 0 0}
.tr-who{font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums}.tr-txt{font-style:italic;overflow-wrap:anywhere;min-width:0}.tr-n{font-size:12px}
.st{flex:none;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--soft);color:var(--mut)}
.st-late{background:#fef3c7;color:#92400e}.st-has{background:#dbeafe;color:var(--run)}.st-answered{background:#dcfce7;color:var(--ok)}
.opts{margin:8px 0 2px}.opt-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
button.opt{font:inherit;font-size:13.5px;font-weight:600;color:var(--fg);background:#fff;border:1px solid #d9b99c;border-radius:8px;padding:10px 14px;cursor:pointer;text-align:left;min-height:44px;min-width:44px}
button.opt:hover:not(:disabled):not([aria-pressed=true]){background:#fde6cf;border-color:var(--you)}
button.opt:disabled{opacity:.55;cursor:default}
button.opt[aria-pressed=true]{opacity:1;cursor:default;background:var(--you);border-color:var(--you);color:#fff}
.hint{font-size:12px;color:var(--mut)}.pickline{margin-top:6px;font-size:13px;font-weight:600;color:var(--you)}
.ask.replied.picked{font-style:normal}.tr-stale{font-style:normal;font-size:12px}
.askbox .trail{margin:6px 0 2px}
.askbox.answered{opacity:.85}.ask-tag{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8a7a6a;margin-top:6px}
/* read marks */
.cnotes{margin:6px 0 2px;font-size:13px}.cnotes>summary{display:inline-block;color:var(--mut);font-size:12.5px}.cnotes>summary::before{width:5px;height:5px}
.mr,.mra{font:inherit;font-size:12px;font-weight:600;color:var(--mut);background:#fff;border:1px solid var(--line);border-radius:999px;padding:2px 10px;cursor:pointer;margin-left:auto;flex:none}
.mra{margin-left:10px}.mr:hover,.mra:hover{color:var(--fg);border-color:#b8b2a3}
[hidden]{display:none!important}
#g-done .mr{display:none}
/* collapsible hand-written sections */
details.sec>summary h2{display:inline-block;margin:0}
details.sec{margin-top:36px;scroll-margin-top:48px}
details.sec>summary{padding:2px 0}
.chip.c-fail,.c-fail{color:#b91c1c}.chip.c-fail{background:#fee2e2}.s-failed .ttl{font-weight:500}
.actx{margin:4px 0 2px;font-size:13.5px;max-width:80ch}.actx>summary{color:var(--mut);font-size:12.5px;display:inline-block}
.actx>div{padding:4px 0 0 4px;border-left:2px solid #f3d5bc;margin-top:4px;padding-left:12px}.actx p,.nt p{margin:4px 0}
.banner{margin:12px 0 0;padding:8px 12px;border-radius:8px;font-size:13.5px;font-weight:500}
.banner[hidden]{display:none}
.b-bad{background:#fee2e2;color:#991b1b;border:1px solid #fecaca}.b-off{background:var(--soft);color:var(--mut);border:1px solid var(--line)}
pre{overflow-x:auto;background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font:12.5px/1.5 ui-monospace,monospace}pre code{background:none;padding:0;overflow-wrap:normal}
[data-section]{scroll-margin-top:48px}
.tt{flex-wrap:wrap}.ttl{min-width:0;overflow-wrap:anywhere}.nt,.ask,.actx,.cur{overflow-wrap:anywhere}
/* task navigator (nav-script.ts): a fixed rail that folds to a spine; a bar and a drop-down sheet on phones */
.tn,.tn-bar,.tn-fly,.tn-sheet,.tn-back{display:none}
.tn-st{margin:0 0 14px}.tn-st ul{list-style:none;margin:0;padding:0}.tn-st li{margin:0}
.tn-h{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:0 0 3px;padding:0 6px}
.tn-c{font-variant-numeric:tabular-nums;letter-spacing:0}
.tn-a{display:block;padding:3px 6px;border-radius:6px;color:#3d3a34;text-decoration:none;font-size:13px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tn-a:hover{background:var(--soft);color:var(--fg)}
.tn-a[aria-current=true]{background:var(--soft);color:var(--fg);font-weight:600}
.t-you>.tn-h,.t-you .tn-a{color:var(--you)}.t-you .tn-a[aria-current=true]{background:var(--youbg)}
.t-you .tn-a::before,.un .tn-a::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--you);vertical-align:middle;margin:0 7px 2px 0}
.un .tn-a{font-weight:600;color:var(--fg)}.un .tn-a::before{background:var(--ok)}
.fail .tn-a{color:#b91c1c}
.tn-st[data-cap]:not(.all) li:nth-child(n+6){display:none}
.tn-more{font:inherit;font-size:12.5px;color:var(--run);background:none;border:0;padding:3px 6px;cursor:pointer;text-decoration:underline;text-underline-offset:2px;border-radius:6px}
.tn-bd,.tn-chip{--bgc:var(--soft);--fgc:var(--fg)}
.tn-bd.t-you,.tn-chip.t-you{--bgc:var(--you);--fgc:#fff}
.tn-bd.t-fm,.tn-bd.t-running,.tn-chip.t-fm,.tn-chip.t-running{--bgc:#dbeafe;--fgc:var(--run)}
.tn-bd.t-done,.tn-chip.t-done{--bgc:#dcfce7;--fgc:var(--ok)}
.tn-bd.t-parked,.tn-bd.t-blocked,.tn-chip.t-parked,.tn-chip.t-blocked{--fgc:var(--park)}
.tn-bd{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;width:40px;min-height:44px;padding:2px 0;border:1px solid transparent;border-radius:8px;background:var(--bgc);color:var(--fgc);font:600 15px/1 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;cursor:pointer}
.tn-bd small,.tn-chip small{font:600 9px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;opacity:.85}
.tn-bd[aria-current=true]{box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px var(--fg)}
.tn-bd[aria-expanded=true]{border-color:var(--fg)}
.tn-tg{display:flex;align-items:center;justify-content:center;min-width:40px;min-height:40px;padding:0 6px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--fg);font:600 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}
.tn-tg:hover{background:var(--soft)}
@media (min-width:640px){
  body.tn-on{padding-left:48px}
  .tn{display:flex;flex-direction:column;position:fixed;left:0;top:0;bottom:0;width:48px;z-index:20;background:var(--bg);border-right:1px solid var(--line)}
  .tn[hidden]{display:none}
  .tn-spine{display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0;overflow-y:auto;scrollbar-width:none;flex:1}
  .tn-bds{display:contents}
  .tn-full{display:none;flex-direction:column;min-height:0;flex:1}
  .tn-top{display:flex;align-items:center;justify-content:space-between;padding:8px 8px 8px 14px;flex:none}.tn-top b{font-size:13px}
  .tn-top .tn-tg{padding:0 12px;min-height:36px}
  .tn-fl{overflow-y:auto;overscroll-behavior:contain;padding:4px 6px 20px 8px;flex:1}
  body.tn-exp .tn{width:260px;box-shadow:4px 0 12px rgba(28,27,25,.08)}
  body.tn-exp .tn-spine{display:none}body.tn-exp .tn-full{display:flex}
  .tn-fly{display:block;position:fixed;left:48px;z-index:21;width:300px;max-height:calc(100vh - 16px);overflow-y:auto;overscroll-behavior:contain;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:10px 8px;box-shadow:0 4px 12px rgba(28,27,25,.1)}
  .tn-fly[hidden]{display:none}.tn-fly .tn-st{margin:0}
}
@media (min-width:1200px){body.tn-on.tn-exp{padding-left:240px}body.tn-exp .tn{width:240px;box-shadow:none}}
@media (max-width:639px){
  .tn-bar{display:flex;align-items:center;gap:6px;position:sticky;top:var(--navh,36px);z-index:5;margin:0 -14px;padding:0 14px;min-height:44px;width:calc(100% + 28px);background:var(--bg);border:0;border-bottom:1px solid var(--line);font:inherit;font-size:13px;color:var(--fg);text-align:left;cursor:pointer}
  .tn-bar[hidden]{display:none}
  .tn-chip{flex:none;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:14px;background:var(--bgc);color:var(--fgc);font:600 12px/1 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums}
  .tn-bt{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--you);font-weight:600}.tn-bt.none{color:var(--mut);font-weight:500}
  .tn-caret{flex:none;color:var(--mut);font-size:12px}
  .tn-back:not([hidden]){display:block;position:fixed;inset:0;z-index:30;background:rgba(28,27,25,.35)}
  .tn-sheet:not([hidden]){display:flex;flex-direction:column;position:fixed;left:0;right:0;top:80px;z-index:31;max-height:calc(100vh - 104px);background:var(--bg);border-bottom:1px solid var(--line);border-radius:0 0 12px 12px}
  .tn-sb{overflow-y:auto;overscroll-behavior:contain;padding:12px 12px 6px}
  .tn-sheet .tn-a{padding:11px 8px;min-height:44px;font-size:15px;white-space:normal}
  .tn-sheet .tn-h{font-size:12px;padding:4px 8px}.tn-sheet .tn-more{min-height:44px;padding:0 8px;font-size:14px}
  .tn-sx{flex:none;min-height:44px;border:0;border-top:1px solid var(--line);background:none;color:var(--run);font:600 14px ui-sans-serif,system-ui,sans-serif;cursor:pointer}
  body.tn-on .task,body.tn-on .grp,body.tn-on [data-section],body.tn-on h2{scroll-margin-top:96px}
  body.tn-lock{overflow:hidden}
}
@media (max-width:560px){.open{margin-left:0}main{padding:18px 14px 60px}nav{margin:12px -14px 0;padding:8px 14px}h1{font-size:20px}.tt{flex-direction:column;gap:4px}.s-you{padding:12px}.tw table{min-width:480px}}`;
