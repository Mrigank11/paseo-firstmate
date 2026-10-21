// Page stylesheet, ported from lh-dev-status.html.
export const CSS = String.raw`:root{--bg:#f7f6f2;--fg:#1c1b19;--mut:#625f57;--line:#e4e0d4;--soft:#f1efe8;--you:#b4410c;--youbg:#fff4ea;--run:#1d4ed8;--ok:#15803d;--park:#78716c}
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
.nt h3,.nt h4,section[data-section] h3,section[data-section] h4,.actx h3,.actx h4{display:block;margin:12px 0 4px;font-size:14px}
.m{color:var(--mut);font-size:13px}.t{font-weight:600}
code{font:12.5px ui-monospace,monospace;background:var(--soft);padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}
ul{margin:4px 0;padding-left:20px}li{margin:3px 0}.dec li{margin:6px 0}
.when{font:12px ui-monospace,monospace;color:#7d796f;margin-right:6px}
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
.c-done{color:var(--ok)}.chip.c-done{background:#dcfce7}.c-next{color:var(--fg)}.c-parked{color:var(--park)}
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
button.opt{font:inherit;font-size:13.5px;font-weight:600;color:var(--fg);background:#fff;border:1px solid #d9b99c;border-radius:8px;padding:6px 12px;cursor:pointer;text-align:left;min-height:34px}
button.opt:hover:not(:disabled){background:#fde6cf;border-color:var(--you)}
button.opt:disabled{opacity:.5;cursor:default}button.opt.on:disabled{opacity:1;background:var(--you);border-color:var(--you);color:#fff}
.hint{font-size:12px;color:var(--mut)}.pickline{margin-top:6px;font-size:13px;font-weight:600;color:var(--you)}
.ask.replied.picked{font-style:normal}
/* collapsible hand-written sections */
details.sec>summary h2{display:inline-block;margin:0}
details.sec{margin-top:36px;scroll-margin-top:48px}
details.sec>summary{padding:2px 0}
.chip.c-fail,.c-fail{color:#b91c1c}.chip.c-fail{background:#fee2e2}.s-failed .ttl{font-weight:500}
.actx{margin:4px 0 2px;font-size:13.5px;max-width:80ch}.actx>summary{color:var(--mut);font-size:12.5px;display:inline-block}
.actx>div{padding:4px 0 0 4px;border-left:2px solid #f3d5bc;margin-top:4px;padding-left:12px}.actx p,.nt p{margin:4px 0}
.banner{margin:12px 0 0;padding:8px 12px;border-radius:8px;font-size:13.5px;font-weight:500}
.b-bad{background:#fee2e2;color:#991b1b;border:1px solid #fecaca}.b-off{background:var(--soft);color:var(--mut);border:1px solid var(--line)}
pre{overflow-x:auto;background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font:12.5px/1.5 ui-monospace,monospace}pre code{background:none;padding:0;overflow-wrap:normal}
section[data-section]{scroll-margin-top:48px}
.tt{flex-wrap:wrap}.ttl{min-width:0;overflow-wrap:anywhere}.nt,.ask,.actx,.cur{overflow-wrap:anywhere}
@media (max-width:560px){.open{margin-left:0}main{padding:18px 14px 60px}nav{margin:12px -14px 0;padding:8px 14px}h1{font-size:20px}.tt{flex-direction:column;gap:4px}.s-you{padding:12px}.tw table{min-width:480px}}`;
