// Page gate, browser side. Starts serve.ts (this checkout's deck over an LH-sized copy, real Lavish 0.1.95 on a scratch port),
// opens the page in ONE headless Chrome through Lavish's own session URL, and measures what a captain's open tab pays:
//   idle     no crew changes for GATE_IDLE_S: full-list downloads and bytes
//   busy     crew changes every 1-3 s for GATE_BUSY_S, with real sidebar clicks: bytes a minute, update time, main-thread blocking, sidebar flicker
//   restart  the plugin process restarted 3 times under the open tab: frame reloads
//   comment  a comment on an old done card: its body must be on the page
// Exit code 1 when a check in GATE_CHECKS (default all) misses its budget. Results also go to <dir>/gate-<run>.json.
// Chrome keeps a unix socket under TMPDIR, whose path must stay under 108 characters: PG_CHROME_TMP is a short on-disk dir (default <dir>/../pgt, a symlink to <dir>/tmp).
// usage: PG_DIR=<scratch> node gate.ts   env: GATE_IDLE_S=300 GATE_BUSY_S=120 GATE_CHECKS=idle,bytes,update,restart,comment GATE_CPU=1
//        PG_RUN=gate PG_LPORT=4531 PG_MPORT=4532 PG_CPORT=4533
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.PG_DIR ?? "/home/mrigank/projects/llm-exp/paseo-firstmate/.isolated/deck-page-firstprinciples-build";
const RUN = process.env.PG_RUN ?? "gate", LPORT = process.env.PG_LPORT ?? "4531";
const IDLE_S = +(process.env.GATE_IDLE_S ?? 300), BUSY_S = +(process.env.GATE_BUSY_S ?? 120), CPU = +(process.env.GATE_CPU ?? 1);
const CHECKS = new Set((process.env.GATE_CHECKS ?? "idle,bytes,update,restart,comment").split(","));
const BUDGET = { idleLists: 0, mbPerMin: 0.5, updateP95Ms: 50, restartReloads: 0 };
const { chromium } = createRequire(import.meta.url)(process.env.PG_PLAYWRIGHT ?? "/home/mrigank/projects/confcall/node_modules/playwright-core");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(); const lines: string[] = [];
const log = (...a: unknown[]) => { const s = ((Date.now() - t0) / 1000).toFixed(0).padStart(5) + "s " + a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "); lines.push(s); console.log(s); };
const env = { ...process.env, PG_DIR: DIR, PG_RUN: RUN, PG_LPORT: LPORT, PG_MPORT: process.env.PG_MPORT ?? "4532", PG_CPORT: process.env.PG_CPORT ?? "4533", TMPDIR: process.env.TMPDIR ?? join(DIR, "tmp") };
const urlFile = join(DIR, `url-${RUN}.txt`), churnFile = join(DIR, `churn-${RUN}`), root = join(DIR, `root-${RUN}`);
let srv: ChildProcess | null = null;
const startServe = async (keep: boolean) => {
  rmSync(urlFile, { force: true });
  srv = spawn("node", [join(here, "serve.ts")], { env: { ...env, ...(keep ? { KEEP: "1" } : {}) } });
  srv.stdout!.on("data", (d) => { for (const l of String(d).split("\n")) if (/URL|\[deck\] (rendered|poll)/.test(l) && process.env.GATE_VERBOSE) log("[serve]", l.slice(0, 160)); });
  srv.stderr!.on("data", (d) => log("[serve err]", String(d).slice(0, 300)));
  for (let i = 0; i < 240 && !existsSync(urlFile); i++) await sleep(500);
  if (!existsSync(urlFile)) throw new Error("serve.ts did not come up");
  return readFileSync(urlFile, "utf8").trim().replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${LPORT}`);
};
const stopServe = async () => { srv?.kill("SIGTERM"); await sleep(1000); srv = null; };
const setChurn = (on: boolean) => writeFileSync(churnFile, on ? "on" : "off");

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const result: Record<string, any> = { run: RUN, cpu: CPU, budget: BUDGET, checks: {} };
const verdict = (name: string, ok: boolean, detail: string) => { result.checks[name] = { ok, detail }; log(CHECKS.has(name) ? (ok ? "PASS" : "FAIL") : "info", name, detail); };

let browser: any;
try {
  let URL = await startServe(false); log("serve up", URL);
  browser = await chromium.launch({ executablePath: process.env.PG_CHROME ?? "/home/mrigank/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", env: { ...process.env, XDG_CONFIG_HOME: join(DIR, "xdg"), TMPDIR: process.env.PG_CHROME_TMP ?? join(DIR, "..", "pgt") }, args: ["--headless=new", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  // in every document: page loads, update times, long tasks and the sidebar's visibility per painted frame
  await ctx.addInitScript(() => {
    const w = window as any; w.__pg = { upd: [], lt: [], tnBad: 0, tnFrames: 0, shown: false };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__pg.lt.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true }); } catch {}
    document.addEventListener("DOMContentLoaded", () => { if (document.getElementById("live")) console.log("PGDOC " + location.pathname.slice(-40)); });
    const wrap = () => { for (const k of ["__fdLive", "__fdApply"]) { const f = w[k]; if (!f || f.__w) continue; const g = function (this: any, ...a: any[]) { const t = performance.now(); const r = f.apply(this, a); w.__pg.upd.push(Math.round(performance.now() - t)); return r; }; (g as any).__w = 1; w[k] = g; } };
    setInterval(wrap, 25);
    const step = () => { const tn = document.getElementById("tn"); if (tn && document.getElementById("live")) { const r = tn.getBoundingClientRect(), vis = !(tn as any).hidden && r.width > 10;
      if (vis) w.__pg.shown = true; if (w.__pg.shown) { w.__pg.tnFrames++; if (!vis) w.__pg.tnBad++; } } requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
  // bytes the tab pays: every response from the scratch Lavish and the marks endpoint, by kind
  const reqs: { t: number; kind: string; bytes: number; path: string }[] = [];
  ctx.on("requestfinished", async (rq: any) => {
    const u = rq.url(); if (!u.startsWith(`http://127.0.0.1:${LPORT}/`) && !u.includes(`:${env.PG_MPORT}/`)) return;
    const p = u.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*/, "");
    const kind = /\.live\.v\.js$/.test(p) ? "poll" : /\.live\.js$/.test(p) ? "list" : /\.html$/.test(p) || /\/session\/[0-9a-f]+/.test(p) && !/\/(api|artifact)\//.test(p) ? "page" : "other";
    try { const s = await rq.sizes(); reqs.push({ t: Date.now(), kind, bytes: s.responseBodySize + s.responseHeadersSize, path: p }); } catch {}
  });
  const page = await ctx.newPage();
  const docs: number[] = []; let navs = 0;
  page.on("console", (m: any) => { if (m.text().startsWith("PGDOC")) docs.push(Date.now()); });
  page.on("framenavigated", (f: any) => { if (!/#/.test(f.url()) && f.url().startsWith("http")) navs++; });
  page.on("pageerror", (e: Error) => log("PAGEERROR", e.message.slice(0, 160)));
  const loadStart = Date.now();
  await page.goto(URL, { waitUntil: "commit" });
  const frame = async (need = "#live .task") => { for (let i = 0; i < 600; i++) { for (const f of page.frames()) { try { if (await f.evaluate((q: string) => document.querySelectorAll(q).length > 0 && document.readyState === "complete", need)) return f; } catch {} } await sleep(100); } throw new Error("page frame did not appear"); };
  const pass = async () => { const g = await page.$("#layoutGateAction"); if (g && await g.isVisible().catch(() => false)) await g.click().catch(() => {}); };
  let fr = await frame(); await pass();
  const dom = await fr.evaluate(() => ({ els: document.getElementsByTagName("*").length, tasks: document.querySelectorAll("#live .task").length }));
  result.load = { ms: Date.now() - loadStart, ...dom, bytes: reqs.reduce((s, r) => s + r.bytes, 0) };
  log("loaded", result.load);
  if (CPU > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU }); }
  const win = async (name: string, ms: number, fn?: () => Promise<void>) => {
    const from = Date.now(), r0 = reqs.length; await fr.evaluate(() => { const g = (window as any).__pg; g.upd = []; g.lt = []; g.tnBad = 0; g.tnFrames = 0; });
    if (fn) await fn(); else await sleep(ms);
    const mine = reqs.slice(r0).filter((r) => r.t >= from), min = (Date.now() - from) / 60000;
    const g = await fr.evaluate(() => (window as any).__pg);
    const by = (k: string) => mine.filter((r) => r.kind === k);
    const w = { name, seconds: Math.round(min * 60), bytes: mine.reduce((s, r) => s + r.bytes, 0), mbPerMin: +(mine.reduce((s, r) => s + r.bytes, 0) / 1048576 / min).toFixed(3),
      lists: by("list").length, listBytes: by("list").reduce((s, r) => s + r.bytes, 0), polls: by("poll").length, other: by("other").length,
      updates: g.upd.length, updP50: pct(g.upd, 0.5), updP95: pct(g.upd, 0.95), updMax: Math.max(0, ...g.upd), blockedPct: +(g.lt.reduce((s: number, x: number) => s + x, 0) / ((Date.now() - from) * 10)).toFixed(1), longest: Math.max(0, ...g.lt), tnBad: g.tnBad, tnFrames: g.tnFrames };
    result[name] = w; log(name, w); return w;
  };

  // ---- idle: no crew changes; the deck's own 20 s tick and clocks still run
  if (CHECKS.has("idle")) {
    setChurn(false); await sleep(25000); // let the last change settle
    const w = await win("idle", IDLE_S * 1000);
    verdict("idle", w.lists <= BUDGET.idleLists, `${w.lists} list downloads (${(w.listBytes / 1048576).toFixed(1)} MB) in ${w.seconds} s idle, budget ${BUDGET.idleLists}`);
  }
  // ---- busy: crews change every 1-3 s; real clicks on sidebar titles every 10 s
  if (CHECKS.has("bytes") || CHECKS.has("update")) {
    setChurn(true); await sleep(5000);
    const clicks: number[] = []; let k = 0;
    const click = async () => {
      fr = await frame(); await pass();
      if (!(await fr.evaluate(() => document.body.classList.contains("tn-exp")))) { const b = await (await fr.$("#tn-open"))?.boundingBox(); if (b) { await page.mouse.click(b.x + 10, b.y + 10); await sleep(400); } }
      const idx = await fr.evaluate((k: number) => { const f = document.getElementById("tn-fl")?.getBoundingClientRect(); if (!f) return -1; const v = [...document.querySelectorAll("#tn-fl .tn-a")].map((a, i) => [i, a] as const).filter(([, a]: any) => { const b = a.getBoundingClientRect(); return a.offsetParent && b.top > f.top && b.bottom < f.bottom; }); return v.length ? v[k % v.length][0] : -1; }, k++);
      if (idx < 0) return; const el = (await fr.$$("#tn-fl .tn-a"))[idx]; const bb = await el.boundingBox(); if (!bb) return;
      const id = await el.getAttribute("data-t"), t = Date.now(); await page.mouse.click(bb.x + 20, bb.y + bb.height / 2);
      for (let i = 0; i < 100; i++) { if (await fr.evaluate((i: string | null) => !!i && !!document.querySelector(`#${CSS.escape(i)}.tn-sel, .task.tn-sel#${CSS.escape(i)}`), id).catch(() => false)) { clicks.push(Date.now() - t); return; } await sleep(50); }
      clicks.push(5000);
    };
    const w = await win("busy", BUSY_S * 1000, async () => { const end = Date.now() + BUSY_S * 1000; while (Date.now() < end) { await click().catch(() => {}); await sleep(Math.min(10000, Math.max(0, end - Date.now()))); } });
    result.busy.clickMs = { n: clicks.length, p50: pct(clicks, 0.5), max: Math.max(0, ...clicks) }; log("clicks to selection", result.busy.clickMs);
    verdict("bytes", w.mbPerMin < BUDGET.mbPerMin, `${w.mbPerMin} MB/min per tab under churn (${w.updates} updates), budget ${BUDGET.mbPerMin}`);
    verdict("update", w.updP95 < BUDGET.updateP95Ms && w.updates > 0, `update p50 ${w.updP50} ms, p95 ${w.updP95} ms, max ${w.updMax} ms; main thread blocked ${w.blockedPct}%; sidebar missing in ${w.tnBad}/${w.tnFrames} frames; budget p95 < ${BUDGET.updateP95Ms} ms`);
  }
  // ---- restart: the plugin process swapped under the open tab, three times
  if (CHECKS.has("restart")) {
    const d0 = docs.length, n0 = navs;
    for (let i = 1; i <= 3; i++) { await stopServe(); URL = await startServe(true); log("plugin restart", i, "done"); await sleep(20000); }
    const reloads = docs.length - d0, navd = navs - n0;
    verdict("restart", reloads <= BUDGET.restartReloads, `${reloads} page-frame reloads (${navd} navigations) over 3 plugin restarts, budget ${BUDGET.restartReloads}`);
    fr = await frame();
  }
  // ---- comment: a comment on an old done card must show on the card, and the card must carry its body (the page opens it)
  if (CHECKS.has("comment")) {
    const fleet = JSON.parse(readFileSync(join(root, "state/fleet.json"), "utf8")); const tasks = fleet.tasks ?? fleet;
    const old = tasks.filter((t: any) => t.project === "longitudehealth" && t.state === "done" && existsSync(join(root, "state/tasks", t.id, "canvas.final.html"))).sort((a: any, b: any) => String(a.since ?? "").localeCompare(String(b.since ?? "")))[0];
    if (!old) verdict("comment", false, "no old done LH task with a final canvas in the copy");
    else {
      appendFileSync(join(root, "state/projects/longitudehealth/inbox.jsonl"), JSON.stringify({ id: "c-gate-" + Date.now().toString(36), at: new Date().toISOString(), project: "longitudehealth", prompt: { uid: "9999", prompt: "gate comment", selector: `article#t-${old.id}`, tag: "article", text: "x" }, delivered: true, answered: false, target: `t-${old.id}`, text: "gate comment" }) + "\n");
      await sleep(8000); fr = await frame();
      const r = await fr.evaluate((id: string) => { const a = document.getElementById("t-" + id); return a ? { len: a.innerHTML.length, hasTrail: (a.textContent || "").includes("gate comment") } : null; }, old.id);
      verdict("comment", !!r && r.len > 1500 && r.hasTrail, r ? `card t-${old.id}: ${r.len} chars of body, comment ${r.hasTrail ? "shown on it" : "missing from it"}` : `card t-${old.id} is not on the page`);
    }
  }
} catch (e: any) { log("GATE ERROR", String(e?.stack ?? e).slice(0, 600)); result.error = String(e); process.exitCode = 2; }
finally {
  try { await browser?.close(); } catch {}
  await stopServe(); for (const p of ["server.mjs server --port " + LPORT]) spawn("pkill", ["-f", p]);
  writeFileSync(join(DIR, `gate-${RUN}.json`), JSON.stringify(result, null, 2)); writeFileSync(join(DIR, `gate-${RUN}.log`), lines.join("\n") + "\n");
  const failed = Object.entries(result.checks as Record<string, { ok: boolean }>).filter(([k, v]) => CHECKS.has(k) && !v.ok).map(([k]) => k);
  log(result.error ? "GATE ERROR (nothing measured)" : failed.length ? `GATE FAILED: ${failed.join(", ")}` : "GATE PASSED");
  if (failed.length && !process.exitCode) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
