// Page gate, browser side. Starts serve.ts (this checkout's deck over an LH-sized copy, real Lavish 0.1.95 on a scratch port),
// opens the page in ONE headless Chrome through Lavish's own session URL, and measures what a captain's open tab pays:
//   idle     no crew changes for GATE_IDLE_S: full-list downloads and bytes
//   busy     crew changes every 1-3 s for GATE_BUSY_S, with real sidebar clicks: bytes a minute, update time, main-thread blocking, sidebar flicker
//   restart  the plugin process restarted 3 times under the open tab: frame reloads
//   comment  a comment on an old done card: its body must be on the page
//   open     a one-line done card opens to its body, and the body is still there after a stretch of live updates
//   canvas   the fake agent-canvas fails for GATE_OUTAGE_S while crews work: no active card may lose its canvas in any painted frame
//   correct  folds opened, one running card selected, focus view on; crews write, cards move between groups, counts and comments
//            change for GATE_CORRECT_S. The selected card and its canvas must be on screen in every painted frame, and at the end
//            the page must be the same as a fresh load of the same data (the frame reloaded with the same stored state).
// Exit code 1 when a check in GATE_CHECKS (default all) misses its budget. Results also go to <dir>/gate-<run>.json.
// Chrome keeps a unix socket under TMPDIR, whose path must stay under 108 characters: PG_CHROME_TMP is a short on-disk dir (default <dir>/../pgt, a symlink to <dir>/tmp).
// usage: PG_DIR=<scratch> node gate.ts   env: GATE_IDLE_S=300 GATE_BUSY_S=120 GATE_CORRECT_S=90 GATE_OUTAGE_S=12 GATE_CHECKS=idle,bytes,update,restart,comment,open,canvas,correct GATE_CPU=1
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
const CHECKS = new Set((process.env.GATE_CHECKS ?? "idle,bytes,update,restart,comment,open,canvas,correct").split(","));
const CORRECT_S = +(process.env.GATE_CORRECT_S ?? 90), OUTAGE_S = +(process.env.GATE_OUTAGE_S ?? 12);
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
const setChurn = (mode: "on" | "off" | "mixed" | "poke") => writeFileSync(churnFile, mode);
const setCanvas = (down: boolean) => writeFileSync(join(DIR, `canvas-${RUN}`), down ? "down" : "up");
const setPoke = (task: string) => writeFileSync(join(DIR, `poke-${RUN}`), task);

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
    setInterval(wrap, 25); w.__fdUpd = (ms: number) => w.__pg.upd.push(Math.round(ms));
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
      parts: mine.reduce((o: any, r) => { const m = /\.d\/([a-z])\.[^/]*$/.exec(r.path); const k = m ? m[1] : r.kind; o[k] = (o[k] ?? 0) + r.bytes; return o; }, {}), lists: by("list").length, listBytes: by("list").reduce((s, r) => s + r.bytes, 0), polls: by("poll").length, other: by("other").length,
      updates: g.upd.length, updP50: pct(g.upd, 0.5), updP95: pct(g.upd, 0.95), updMax: Math.max(0, ...g.upd), blockedPct: +(g.lt.reduce((s: number, x: number) => s + x, 0) / ((Date.now() - from) * 10)).toFixed(1), longest: Math.max(0, ...g.lt), tnBad: g.tnBad, tnFrames: g.tnFrames };
    result[name] = w; log(name, w); return w;
  };

  // ---- idle: no crew changes; the deck's own 20 s tick and clocks still run
  if (CHECKS.has("idle")) {
    setChurn("off"); await sleep(25000); // let the last change settle
    const w = await win("idle", IDLE_S * 1000);
    verdict("idle", w.lists <= BUDGET.idleLists, `${w.lists} list downloads (${(w.listBytes / 1048576).toFixed(1)} MB) in ${w.seconds} s idle, budget ${BUDGET.idleLists}`);
  }
  // ---- busy: crews change every 1-3 s; real clicks on sidebar titles every 10 s
  if (CHECKS.has("bytes") || CHECKS.has("update")) {
    setChurn("on"); await sleep(5000);
    const clicks: number[] = []; let k = 0;
    const click = async () => {
      fr = await frame(); await pass();
      if (!(await fr.evaluate(() => document.body.classList.contains("tn-exp")))) { const b = await (await fr.$("#tn-open"))?.boundingBox(); if (b) { await page.mouse.click(b.x + 10, b.y + 10); await sleep(400); } }
      const idx = await fr.evaluate((k: number) => { const f = document.getElementById("tn-fl")?.getBoundingClientRect(); if (!f) return -1; const v = [...document.querySelectorAll("#tn-fl .tn-a")].map((a, i) => [i, a] as const).filter(([, a]: any) => { const b = a.getBoundingClientRect(); return a.offsetParent && b.top > f.top && b.bottom < f.bottom; }); return v.length ? v[k % v.length][0] : -1; }, k++);
      if (idx < 0) return; const el = (await fr.$$("#tn-fl .tn-a"))[idx]; const bb = await el.boundingBox(); if (!bb) return;
      const id = await el.getAttribute("data-t"), t = Date.now(); await page.mouse.click(bb.x + 20, bb.y + bb.height / 2);
      for (let i = 0; i < 100; i++) { if (await fr.evaluate((i: string | null) => !!i && location.hash === "#" + i && !!document.getElementById(i)?.getClientRects().length, id).catch(() => false)) { clicks.push(Date.now() - t); return; } await sleep(50); }
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
  // ---- open: a one-line card opens to its body, and keeps it through live updates
  if (CHECKS.has("open")) {
    setChurn("on"); fr = await frame(); await pass();
    const lite = await fr.evaluate(() => { const c = document.querySelector("article.task[data-bh]") as HTMLElement | null; if (!c) return null;
      for (let p = c.parentElement; p; p = p.parentElement) { if (p.tagName === "DETAILS") (p as HTMLDetailsElement).open = true; if ((p as HTMLElement).hidden) (p as HTMLElement).hidden = false; }
      c.scrollIntoView({ block: "center" }); return { id: c.id, before: c.innerHTML.length }; });
    if (!lite) verdict("open", false, "no one-line done card on the page");
    else {
      const d1 = docs.length; const t = Date.now(); await fr.evaluate((id: string) => (document.querySelector(`#${id} > details.lz > summary`) as HTMLElement).click(), lite.id); // a click on the summary (it may sit in a fold the page keeps shut)
      let n = 0; for (let i = 0; i < 100 && !n; i++) { n = await fr.evaluate((id: string) => document.querySelector(`#${id} .lzb`)?.innerHTML.length ?? 0, lite.id); if (!n) await sleep(100); }
      const loadMs = Date.now() - t; await sleep(20000); fr = await frame();
      const after = await fr.evaluate((id: string) => ({ len: document.querySelector(`#${id} .lzb`)?.innerHTML.length ?? 0, open: !!(document.querySelector(`#${id} > details.lz`) as HTMLDetailsElement | null)?.open }), lite.id);
      verdict("open", n > 1000 && after.len === n && after.open, `${lite.id}: body ${n} chars after ${loadMs} ms, ${after.len} chars and ${after.open ? "still open" : "closed"} after 20 s of updates (was ${lite.before} chars as one line; ${docs.length - d1} page reloads)`);
    }
  }
  // ---- helpers for the correctness checks: a per-painted-frame watcher in the page, and a canonical picture of what it shows
  const watchCards = (ids: string[], onScreen = true) => fr.evaluate(([ids, onScreen]: [string[], boolean]) => {
    const w = window as any; if (w.__watch) w.__watch.on = false;
    const m = w.__watch = { on: true, frames: 0, bad: 0, first: "" };
    const step = () => { if (!m.on) return; m.frames++;
      for (const id of ids) { const c = document.getElementById(id), cv = c?.querySelector(".cv");
        const why = !c ? "card not on the page" : onScreen && !c.getClientRects().length ? "card hidden" : !cv ? "canvas gone" : onScreen && !cv.getClientRects().length ? "canvas hidden" : "";
        if (why) { m.bad++; if (!m.first) m.first = `${id}: ${why} (frame ${m.frames})`; break; } }
      requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }, [ids, onScreen] as [string[], boolean]);
  const watched = () => fr.evaluate(() => { const m = (window as any).__watch; m.on = false; return { frames: m.frames, bad: m.bad, first: m.first }; });
  const activeWithCanvas = () => fr.evaluate(() => [...document.querySelectorAll("#live article.task:not([data-bh])")].filter((a) => a.querySelector(".cv")).map((a) => a.id));
  // ---- canvas: agent-canvas fails for a while under a working crew
  if (CHECKS.has("canvas")) {
    setCanvas(false); setPoke(""); setChurn("on"); fr = await frame(); await pass(); await sleep(5000);
    const ids = await activeWithCanvas();
    await watchCards(ids, false); setCanvas(true); await sleep(OUTAGE_S * 1000); setCanvas(false); await sleep(15000);
    const m = await watched();
    verdict("canvas", ids.length > 5 && m.frames > 100 && m.bad === 0, `${ids.length} active canvases over a ${OUTAGE_S} s canvas outage: one missing in ${m.bad} of ${m.frames} painted frames${m.first ? `; first: ${m.first}` : ""}`);
  }
  // ---- correct: the captain's view (folds open, a card selected, focus view) after live updates equals a fresh load
  if (CHECKS.has("correct")) {
    setCanvas(false); setPoke(""); setChurn("off"); fr = await frame(); await pass(); await sleep(3000);
    const sel = (await fr.evaluate(() => [...document.querySelectorAll("#g-running article.task, #g-you article.task, #g-fm article.task")].find((a) => a.querySelector(".cv.has-full"))?.id ?? "")) as string;
    if (!sel) verdict("correct", false, "no active card with a full canvas to select");
    else {
      setPoke(sel.slice(2));
      const folds = await fr.evaluate(async (sel: string) => {
        const nap = () => new Promise((r) => setTimeout(r, 60)); let n = 0;
        const open = async (d: Element | null) => { const s = d?.querySelector(":scope > summary") as HTMLElement | null; if (s && !(d as HTMLDetailsElement).open) { s.click(); n++; await nap(); } };
        await open(document.getElementById("g-parked")); await open(document.getElementById("g-done"));
        await open(document.querySelector("#g-parked details.lz")); await open(document.querySelector("#g-done details.lz"));
        for (const d of [...document.querySelectorAll("#live details.actx:not([open]), #live details.cnotes:not([open])")].filter((d) => !d.closest("article[data-bh]")).slice(0, 4)) await open(d);
        (document.querySelector(`#tn-fl .tn-a[data-t="${sel}"]`) as HTMLElement).click(); await nap();
        if (!document.body.classList.contains("tn-focus")) (document.querySelector(".tn-fx") as HTMLElement).click();
        await nap(); for (const d of [...document.getElementById(sel)!.querySelectorAll("details:not([open])")]) await open(d);
        return n;
      }, sel);
      await sleep(3000);
      await watchCards([sel]); setChurn("mixed"); await sleep(CORRECT_S * 1000);
      setChurn("poke"); await sleep(9000); // the last changes touch only the selected card
      const m = await watched(); setChurn("off"); setPoke(""); await sleep(8000);
      const snap = () => fr.evaluate(() => {
        const canon = (n: Node): string => {
          if (n.nodeType === 3) return (n.textContent ?? "").replace(/\s+/g, " ").trim();
          if (n.nodeType !== 1) return "";
          const e = n as Element, tag = e.tagName.toLowerCase();
          const attrs = [...e.attributes].filter((a) => a.name !== "aria-current").map((a) => a.name === "class" ? `class="${a.value.split(/\s+/).filter((c) => c && c !== "st-late").sort().join(" ")}"` : `${a.name}="${a.value}"`).sort().join(" ");
          const ticking = e.matches(".ck, [data-chg]");
          return `<${tag} ${attrs}>${ticking ? "" : [...e.childNodes].map(canon).filter(Boolean).join("\n")}</${tag}>`;
        };
        const shown = (e: Element | null) => !!e && e.getClientRects().length > 0;
        const out: Record<string, string> = { "page mode": [...document.body.classList].sort().join(" "), "focus bar": document.getElementById("tn-fbar")!.textContent ?? "", navigator: canon(document.getElementById("tn-fl")!) };
        for (const a of document.querySelectorAll("#live article.task")) {
          out[`${a.id} shown`] = `group ${a.closest(".grp")?.id} card ${shown(a)} canvas ${shown(a.querySelector(".cv"))} full ${shown(a.querySelector(".cv-f"))} compact ${shown(a.querySelector(".cv-c"))} open ${[...a.querySelectorAll("details")].filter((d) => d.open).map((d) => d.id).join(",")}`;
          out[`${a.id} content`] = canon(a);
        }
        for (const g of document.querySelectorAll("#live .grp")) out[`${g.id} group`] = `${shown(g)} open ${(g as HTMLDetailsElement).open ?? ""} ${g.querySelector("h3")?.textContent} order ${[...g.querySelectorAll("article.task")].map((a) => a.id).join(",")}`;
        out["summary"] = canon(document.querySelector("#live .summary")!);
        document.querySelectorAll('[data-trail-slot], [data-slot="banner"]').forEach((e, i) => { out[`slot ${i}`] = canon(e); });
        out["whole list"] = canon(document.getElementById("live")!);
        return out;
      }) as Promise<Record<string, string>>;
      const loaded = async () => { for (let i = 0; i < 100; i++) { if (await fr.evaluate(() => ![...document.querySelectorAll("details.lz[open] > .lzb")].some((z) => !z.firstChild)).catch(() => false)) return; await sleep(100); } };
      await loaded(); const live = await snap();
      const d0 = docs.length; await fr.evaluate(() => location.reload()); for (let i = 0; i < 100 && docs.length === d0; i++) await sleep(100);
      await sleep(1000); fr = await frame(); await pass(); await loaded(); await sleep(6000); await loaded(); const fresh = await snap();
      const diffs = [...new Set([...Object.keys(fresh), ...Object.keys(live)])].filter((k) => fresh[k] !== live[k]);
      const show = (k: string) => { const a = live[k] ?? "(missing)", b = fresh[k] ?? "(missing)"; let i = 0; while (i < a.length && a[i] === b[i]) i++; return `${k}: live …${a.slice(Math.max(0, i - 40), i + 80)}… fresh …${b.slice(Math.max(0, i - 40), i + 80)}…`.replace(/\n/g, " "); };
      writeFileSync(join(DIR, `correct-${RUN}.json`), JSON.stringify({ sel, live, fresh, diffs }, null, 1));
      result.correct = { sel, folds, frames: m.frames, badFrames: m.bad, first: m.first, compared: Object.keys(fresh).length, diffs: diffs.length, examples: diffs.slice(0, 6).map(show) };
      log("correct", result.correct);
      verdict("correct", folds > 0 && m.frames > 100 && m.bad === 0 && diffs.length === 0, `${sel} in focus view, ${folds} folds opened: hidden or without its canvas in ${m.bad} of ${m.frames} painted frames${m.first ? ` (first: ${m.first})` : ""}; ${diffs.length} of ${Object.keys(fresh).length} parts differ from a fresh load`);
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
