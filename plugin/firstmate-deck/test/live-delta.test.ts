// Deck latency fix: the page file is a shell, the deck's server hands out a skeleton and only the changed cards (gzipped),
// and the page fetches one thing at a time, keeps the saved selection while its task has not loaded, and shows amber before red.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { joinLive, renderProject, splitLive } from "../server/render.ts";
import { MarksServer, type LiveSnap } from "../server/marks-server.ts";
import { pageScript } from "../server/page-script.ts";
import { loadProject } from "../server/state.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const agents = JSON.parse(readFileSync(join(here, "fixtures", "agents.json"), "utf8"));
const model = loadProject(join(here, "fixtures", "root"), "deck-demo");
const opts = { now: new Date("2026-10-21T10:15:30Z"), paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 1 };

// ---------- render: the shell, the skeleton, the cards ----------

test("with the deck's server the page file is a shell: no task cards, same signature as without", () => {
  const plain = renderProject(model, agents, opts);
  const light = renderProject(model, agents, { ...opts, marksUrl: "http://h:1/deck-demo/state" });
  assert.match(plain.page, /<article class="task/, "no server: the snapshot stays in the file");
  assert.ok(!/<article class="task/.test(light.page), "a server: the file carries no cards");
  assert.ok(plain.page.length - light.page.length > plain.live.length / 2, "the file shrinks by the task list");
  assert.match(light.page, /id="fd-recon"/, "the amber reconnecting banner is in the shell");
});

test("the live block splits into a skeleton and cards, and joins back exactly", () => {
  const r = renderProject(model, agents, opts);
  const ids = [...r.live.matchAll(/<article class="task[^"]*" id="(t-[^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 3);
  assert.deepEqual(Object.keys(r.parts.cards).sort(), [...ids].sort());
  assert.ok(!/<article class="task/.test(r.parts.skel), "the skeleton holds no cards");
  for (const id of ids) assert.ok(r.parts.skel.includes(`<!--c:${id}-->`));
  assert.ok(r.parts.skel.includes("data-tn"), "the navigator template is in the skeleton, so the sidebar can show first");
  assert.equal(joinLive(r.parts.skel, r.parts.cards), r.live);
  assert.ok(!r.live.includes("<!--c:") && !r.live.includes("<!--/c-->"), "no markers leak into the payload");
  assert.deepEqual(splitLive("a<!--c:t-x-->X<!--/c-->b").cards, { "t-x": "X" });
});

test("what the captain last saw is not in the payload, so looking at the page cannot change it", () => {
  const a = renderProject(model, agents, opts);
  const b = renderProject({ ...model, seen: { at: "2026-10-25T09:00:00.000Z", keys: { "t-a": "00000000" } } }, agents, opts);
  assert.ok(!a.live.includes("data-seen") && !b.live.includes("data-seen"));
  assert.equal(a.live, b.live);
});

// ---------- the deck's server ----------

const world = () => { const r = mkdtempSync(join(tmpdir(), "delta-")); mkdirSync(join(r, "state", "projects", "demo"), { recursive: true });
  writeFileSync(join(r, "state", "projects", "demo", "project.json"), "{}"); return r; };
const snap = (cards: Record<string, string>, seq = 1, hash = "h1"): LiveSnap => ({ hash, seq, iso: "2026-10-21T10:00:00.000Z", skel: Object.keys(cards).map((k) => `<!--c:${k}-->`).join("") + "<nav>x</nav>", cards });
const get = (port: number, path: string, o: http.RequestOptions & { body?: string } = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: Buffer }>((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers }, (res) => { const c: Buffer[] = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, raw: Buffer.concat(c) })); });
  req.on("error", reject); req.end(o.body);
});

test("the live endpoints: a tiny version check, a skeleton-only call, and only the cards whose hash moved", async () => {
  const r = world();
  const big = "<p>" + "card text ".repeat(400) + "</p>";
  let cur = snap({ "t-a": big, "t-b": "<p>b</p>" });
  const s = new MarksServer(() => r);
  s.getLive = (p) => (p === "demo" ? cur : null);
  await s.listen(["127.0.0.1"], 0);
  const port = s.boundPorts()[0];
  try {
    const v = JSON.parse((await get(port, "/demo/live/v")).raw.toString());
    assert.deepEqual(v, { hash: "h1", seq: 1, iso: "2026-10-21T10:00:00.000Z" });
    assert.equal((await get(port, "/nope/live/v")).status, 404);
    const post = (body: object, enc = "") => get(port, "/demo/live", { method: "POST", headers: { "Content-Type": "text/plain", ...(enc ? { "Accept-Encoding": enc } : {}) }, body: JSON.stringify(body) });
    const first = await post({ cards: 0 });
    const j0 = JSON.parse(first.raw.toString());
    assert.deepEqual(j0.cards, {}, "skeleton only: no cards");
    assert.deepEqual(Object.keys(j0.hashes).sort(), ["t-a", "t-b"]);
    assert.ok(j0.skel.includes("<nav>x</nav>"));
    const all = JSON.parse((await post({ have: {} })).raw.toString());
    assert.deepEqual(Object.keys(all.cards).sort(), ["t-a", "t-b"]);
    cur = snap({ "t-a": big, "t-b": "<p>b changed</p>" }, 2, "h2");
    const delta = JSON.parse((await post({ have: all.hashes })).raw.toString());
    assert.deepEqual(Object.keys(delta.cards), ["t-b"], "only the changed card is sent");
    assert.equal(delta.seq, 2);
    const gz = await post({ have: {} }, "gzip");
    assert.equal(gz.headers["content-encoding"], "gzip");
    const plain = await post({ have: {} });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(gunzipSync(gz.raw).toString()), JSON.parse(plain.raw.toString()));
    assert.ok(gz.raw.length < plain.raw.length / 3, `gzip ${gz.raw.length} vs ${plain.raw.length}`);
    assert.equal((await get(port, "/demo/live", { method: "POST", body: "{bad" })).status, 400);
  } finally { await s.close(); }
});

// ---------- the page script's fetch loop ----------

type Resp = { ok?: boolean; json: () => Promise<any> } | "hang" | "fail";
function boot(handler: (url: string, init: any) => Resp, extra: { ready?: boolean; pull?: () => Promise<any> } = {}) {
  const statePull = (_u: string) => (extra.pull ? extra.pull() : Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  let clock = 1_000_000;
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let tid = 0;
  const calls: { url: string; at: number; body: any }[] = [];
  let inflight = 0, maxInflight = 0;
  const painted: string[] = [];
  const strip = (h: string) => h.replace(/<!--LIVE-(START|END)-->/g, "");
  const banners: Record<string, any> = { "fd-stale": { hidden: true }, "fd-recon": { hidden: true } };
  const liveEl: any = { contains: () => false, querySelectorAll: () => [], querySelector: () => null, set innerHTML(h: string) { painted.push(strip(h)); } };
  const srcs: string[] = [];
  const doc: any = { activeElement: null, addEventListener() {}, getElementById: (id: string) => (id === "live" ? liveEl : banners[id] ?? null), querySelectorAll: () => [],
    createElement: () => ({ remove() {} }), head: { appendChild: (s: any) => srcs.push(s.src) } };
  const win: any = { name: "", scrollY: 0, scrollTo() {} };
  const fetchFn = (url: string, init: any = {}) => {
    if (url.endsWith("/state")) return statePull(url); // the marks pull is a separate, once-in-a-while request
    calls.push({ url, at: clock, body: init.body ? JSON.parse(init.body) : null });
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    const r = handler(url, init);
    const settle = <T>(p: Promise<T>) => p.finally(() => { inflight--; });
    if (r === "hang") return settle(new Promise((_res, rej) => init.signal?.addEventListener?.("abort", () => rej(new Error("aborted")))));
    if (r === "fail") return settle(Promise.reject(new Error("net")));
    return settle(Promise.resolve(r));
  };
  const ctx = vm.createContext({ document: doc, window: win, location: { hash: "" }, localStorage: undefined, JSON, Object, Math, Array, Promise, Error, parseInt, encodeURIComponent,
    Date: class extends Date { static now() { return clock; } },
    setInterval: (fn: () => void, ms: number) => { const again = () => { timers.push({ fn: () => { fn(); again(); }, at: clock + ms, id: ++tid }); }; again(); return 0; }, clearTimeout: (t: any) => { const i = timers.findIndex((x) => x === t); if (i >= 0) timers.splice(i, 1); },
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, at: clock + ms, id: ++tid }; timers.push(t); return t; },
    fetch: fetchFn, AbortController: class { signal = { listeners: [] as any[], addEventListener(_e: string, f: any) { this.listeners.push(f); } }; abort() { this.signal.listeners.forEach((f: any) => f()); } } });
  win.AbortController = (ctx as any).AbortController; // in a browser window is the global
  if (extra.ready !== undefined) win.__fdReady = () => extra.ready;
  vm.runInContext(pageScript("p", "page.live.js", 1, "http://deck.test/p/state"), ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms: number) => { const end = clock + ms; await flush();
    for (;;) { const d = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!d) break; timers.splice(timers.indexOf(d), 1); clock = Math.max(clock, d.at); d.fn(); await flush(); }
    clock = end; await flush(); };
  return { win, calls, painted, banners, srcs, advance, maxInflight: () => maxInflight, now: () => clock };
}
const jr = (o: any): Resp => ({ ok: true, json: () => Promise.resolve(o) });
const payload = (seq: number, hash: string, cards: Record<string, string>, hashes?: Record<string, string>) =>
  ({ hash, seq, iso: "i", skel: Object.keys(hashes ?? cards).map((k) => `<!--c:${k}-->`).join("") + "<nav>n</nav>", hashes: hashes ?? Object.fromEntries(Object.keys(cards).map((k) => [k, "x" + cards[k].length])), cards });

test("a reload asks for the skeleton first (sidebar), then the cards; later changes ask only for what moved", async () => {
  let ver = { hash: "h1", seq: 1, iso: "i" };
  const b = boot((url, init) => {
    if (url.endsWith("/live/v")) return jr(ver);
    const q = JSON.parse(init.body);
    if (q.cards === 0) return jr({ ...payload(1, "h1", {}, { "t-a": "a1", "t-b": "b1" }), cards: {} });
    if (ver.hash === "h1") return jr(payload(1, "h1", { "t-a": "<i>A</i>", "t-b": "<i>B</i>" }, { "t-a": "a1", "t-b": "b1" }));
    return jr({ ...payload(2, "h2", { "t-b": "<i>B2</i>" }, { "t-a": "a1", "t-b": "b2" }) });
  });
  await b.advance(100);
  const posts = b.calls.filter((c) => c.body);
  assert.equal(posts[0].body.cards, 0, "skeleton first");
  assert.equal(b.painted[0], "<nav>n</nav>", "the skeleton paints before any card exists");
  assert.equal(b.painted[1], "<i>A</i><i>B</i><nav>n</nav>");
  ver = { hash: "h2", seq: 2, iso: "i" };
  await b.advance(1500);
  const last = b.calls.filter((c) => c.body).at(-1)!;
  assert.deepEqual(last.body.have, { "t-a": "a1", "t-b": "b1" }, "it says what it already has");
  assert.equal(b.painted.at(-1), "<i>A</i><i>B2</i><nav>n</nav>", "unchanged card reused from memory, changed card swapped");
});

test("never more than one request at a time, a hung one is given up on, and an older answer is ignored", async () => {
  let mode: "hang" | "ok" = "hang";
  let ver = { hash: "h1", seq: 5, iso: "i" };
  const b = boot((url) => (mode === "hang" ? "hang" : url.endsWith("/live/v") ? jr(ver) : jr(payload(ver.seq, ver.hash, { "t-a": "<i>" + ver.hash + "</i>" }))));
  await b.advance(12_000);
  assert.equal(b.maxInflight(), 1, "a slow link never stacks requests");
  assert.ok(b.calls.length <= 2, `one attempt at a time, timed out after 8 s, then backed off: ${b.calls.length}`);
  mode = "ok";
  await b.advance(20_000);
  assert.ok(b.painted.some((h) => h.includes("<i>h1</i>")), "it recovers once the link answers");
  ver = { hash: "h0", seq: 3, iso: "i" }; // the server answers with something older than what is on screen
  const n = b.painted.length;
  await b.advance(3_000);
  assert.equal(b.painted.length, n, "an older payload is not painted over a newer one");
});

test("amber 'reconnecting' as soon as a request fails, red only after 60 s without a change, both clear on recovery", async () => {
  let ok = true, n = 0;
  const b = boot((url) => (ok ? (url.endsWith("/live/v") ? jr({ hash: "h1", seq: ++n, iso: "i" }) : jr(payload(n, "h1", { "t-a": "A" }))) : "fail"));
  await b.advance(500);
  assert.equal(b.banners["fd-recon"].hidden, true);
  ok = false;
  await b.advance(3_000);
  assert.equal(b.banners["fd-recon"].hidden, false, "amber after the first failure");
  assert.equal(b.banners["fd-stale"].hidden, true, "not red yet");
  await b.advance(70_000);
  assert.equal(b.banners["fd-stale"].hidden, false, "red after a real stall");
  assert.equal(b.banners["fd-recon"].hidden, true, "red replaces amber");
  ok = true;
  await b.advance(30_000);
  assert.equal(b.banners["fd-recon"].hidden, true);
  assert.equal(b.banners["fd-stale"].hidden, true, "and a new sequence number clears red too");
});

test("a server that is not reachable at all falls back to the payload file after a few failures", async () => {
  const b = boot(() => "fail");
  await b.advance(30_000);
  assert.ok(b.srcs.some((s) => s.startsWith("page.live.js")), "the script-tag path takes over");
});

test("the first task is never picked or saved before the stored state and the full list have arrived", async () => {
  let answer: (v: any) => void = () => {};
  const c = boot((url) => (url.endsWith("/live/v") ? jr({ hash: "h1", seq: 1, iso: "i" }) : jr(payload(1, "h1", { "t-a": "A" }))),
    { pull: () => new Promise((r) => { answer = r; }) });
  assert.equal(c.win.__fdReady(), false, "nothing loaded yet");
  await c.advance(500);
  assert.ok(c.painted.some((h) => h.includes("A")), "the full list is in");
  assert.equal(c.win.__fdReady(), false, "but the stored selection (pull) has not answered: still wait");
  answer({ ok: true, json: () => Promise.resolve({ o: { "tn-sel:t-a": 1 }, r: {} }) });
  await c.advance(100);
  assert.equal(c.win.__fdReady(), true);
});

// ---------- the navigator: the saved selection is kept while its card has not loaded ----------

import { navScript } from "../server/nav-script.ts";

function navBoot() {
  const prefs: Record<string, number> = { "tn-focus": 1, "tn-sel:t-new": 1 };
  const writes: string[] = [];
  let ready = false;
  const cards = new Set<string>(); // card ids on the page
  const mk = (extra: any = {}): any => ({ hidden: false, style: {}, innerHTML: "", textContent: "", classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, addEventListener() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
    contains: () => false, closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }), focus() {}, scrollTop: 0, ...extra });
  const link = mk({ getAttribute: (k: string) => (k === "data-t" ? "t-first" : null), textContent: "First" });
  const els: Record<string, any> = {};
  for (const id of ["tn", "tn-bds", "tn-fl", "tn-fly", "tn-sheet", "tn-sl", "tn-back", "tn-bar", "tn-open", "tn-close", "tn-sx", "tn-fbar"]) els[id] = mk();
  els["tn-fbar"].querySelector = () => mk();
  els["tn-fl"].querySelector = (sel: string) => (sel.includes(".tn-a") ? link : null);
  els["tn-fl"].querySelectorAll = (sel: string) => (sel === ".tn-st" ? [mk()] : []);
  const live = mk({ querySelector: (s: string) => (s === "[data-tn]" ? { innerHTML: "<x>" } : null) });
  els["live"] = live;
  const body = mk();
  const doc: any = { body, getElementById: (id: string) => (cards.has(id) ? mk({ id, classList: { toggle() {}, add() {}, remove() {}, contains: () => false } }) : els[id] ?? null),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => mk(), documentElement: { style: { setProperty() {} } } };
  const win: any = { matchMedia: () => ({ matches: false }), innerHeight: 800, addEventListener() {},
    __fdPref: (k: string, v?: number) => { if (v === undefined) return prefs[k]; prefs[k] = v; writes.push(`${k}=${v}`); },
    __fdPrefKeys: (p: string) => Object.keys(prefs).filter((k) => k.startsWith(p) && prefs[k] === 1), __fdReady: () => ready };
  vm.runInContext(navScript(), vm.createContext({ document: doc, window: win, JSON, Object, Math, Array, setTimeout, clearTimeout }));
  return { win, writes, prefs, cards, setReady: (v: boolean) => { ready = v; } };
}

test("the saved selection is kept while its card has not loaded, and only replaced once the full list is in and it is truly gone", () => {
  const n = navBoot();
  n.win.__tn();
  assert.deepEqual(n.writes, [], "page still loading: nothing is written");
  assert.equal(n.prefs["tn-sel:t-new"], 1, "the saved selection stands");
  n.cards.add("t-new");
  n.setReady(true);
  n.win.__tn();
  assert.deepEqual(n.writes, [], "the card arrived: it is the selection, nothing to write");
  n.cards.delete("t-new"); n.cards.add("t-first");
  n.win.__tn();
  assert.equal(n.prefs["tn-sel:t-first"], 1, "full list in and the task is really gone: fall back to the first task");
  assert.equal(n.prefs["tn-sel:t-new"], 0);
});
