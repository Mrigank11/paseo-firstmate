// The browser tab and the "new" dots: attention keys (what is news and what is not), the stored "seen" state, the
// page script's use of Lavish's setDocumentMeta, and the Lavish binary setting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { cleanUi, mergeUi } from "../server/marks.ts";
import { MarksServer, readUi } from "../server/marks-server.ts";
import { renderProject, stagesOf, type AgentView } from "../server/render.ts";
import { attentionOf } from "../server/attention.ts";
import { loadProject } from "../server/state.ts";
import { pageScript } from "../server/page-script.ts";
import { resolveConfig } from "../server/config.ts";
import { resolveLavishBin } from "../server/lavish.ts";

function world(tasks: object[], comments: object[] = []) {
  const root = mkdtempSync(join(tmpdir(), "attn-"));
  const p = join(root, "state", "projects", "demo");
  mkdirSync(join(p, "sections"), { recursive: true });
  writeFileSync(join(p, "project.json"), JSON.stringify({ title: "Demo", sections: [] }));
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks }));
  if (comments.length) writeFileSync(join(p, "inbox.jsonl"), comments.map((c) => JSON.stringify(c)).join("\n") + "\n");
  return { root, p };
}
const NOW = new Date("2026-10-25T10:00:00Z");
const view = (recent: string[], status: AgentView["status"] = "running"): AgentView => ({ status, stepCount: recent.length, recent });
const T = (state: string, extra: object = {}) => ({ id: "a", intent: "a", state, project: "demo", ...extra });
function keysFor(tasks: object[], v: AgentView = view(["one"]), comments: object[] = []) {
  const { root } = world(tasks, comments);
  const model = loadProject(root, "demo");
  const labeled = { a: [{ id: "ag", status: v.status, archived: false, createdAt: "2026-10-25T09:00:00Z" }] };
  const o = { now: NOW, paseoAgentUrl: (id: string) => id, tickSeconds: 1, labeled };
  const stages = stagesOf(model, { ag: v }, o);
  return attentionOf(model, [...model.tasks, ...model.archive], stages);
}

test("attention keys: a stage change is news, step churn and agent flicker are not", () => {
  const running = keysFor([T("active")]);
  assert.equal(keysFor([T("active")], view(["one", "two", "three"])).keys["t-a"], running.keys["t-a"], "step churn");
  assert.equal(keysFor([T("active")], { ...view(["one"]), updatedAt: "2026-10-25T09:59:00Z", stale: true }).keys["t-a"], running.keys["t-a"], "timestamps and staleness of the view");
  assert.notEqual(keysFor([T("done")], view(["one"], "idle")).keys["t-a"], running.keys["t-a"], "running -> done");
  assert.notEqual(keysFor([T("active"), { id: "b", intent: "b", state: "active", project: "demo" }]).keys["t-b"], undefined, "a new task has a key");
});

test("attention keys: a new ask, a reply and an edited card are news; needsYou counts the Needs-you group", () => {
  const base = keysFor([T("active")]);
  const asked = keysFor([T("active", { asks: [{ id: "a1", text: "which?", options: ["x", "y"], since: "2026-10-25T09:30:00Z" }] })], view(["one"], "idle"));
  assert.notEqual(asked.keys["t-a"], base.keys["t-a"], "an open ask");
  assert.equal(asked.needsYou, 1);
  assert.equal(base.needsYou, 0);
  const c = { id: "c1", at: "2026-10-25T09:40:00Z", target: "t-a", text: "hi", delivered: true, answered: false };
  assert.equal(keysFor([T("active")], view(["one"]), [c]).keys["t-a"], base.keys["t-a"], "a captain comment alone is not news");
  assert.notEqual(keysFor([T("active")], view(["one"]), [{ ...c, answered: true }]).keys["t-a"], base.keys["t-a"], "the first mate answered it");
  const w = world([T("active")]);
  mkdirSync(join(w.root, "state", "tasks", "a"), { recursive: true });
  writeFileSync(join(w.root, "state", "tasks", "a", "card.md"), "new card text");
  const m = loadProject(w.root, "demo");
  const edited = attentionOf(m, m.tasks, stagesOf(m, {}, { now: NOW }));
  const m0 = loadProject(world([T("active")]).root, "demo");
  assert.notEqual(edited.keys["t-a"], attentionOf(m0, m0.tasks, stagesOf(m0, {}, { now: NOW })).keys["t-a"], "an edited card");
});

test("the live payload carries count, keys and the stored seen keys; the shell does not change with them", () => {
  const w = world([T("active")]);
  const m = loadProject(w.root, "demo");
  const o = { now: NOW, paseoAgentUrl: (id: string) => id, tickSeconds: 1 };
  const a = renderProject(m, {}, o);
  assert.match(a.live, /<div hidden data-attn data-n="0" data-title="Demo" data-keys="[^"]*"><\/div>/);
  const b = renderProject({ ...m, seen: { at: "2026-10-25T09:00:00.000Z", keys: { "t-a": "00000000" } } }, {}, o);
  assert.match(b.live, /data-seen="/);
  assert.equal(a.signature, b.signature, "page.html stays still");
});

test("seen state: cleaned, newest wins whole, an old tab cannot un-see", () => {
  assert.equal(cleanUi({ s: { at: "yesterday", keys: {} } }).s, undefined, "bad timestamp");
  assert.deepEqual(cleanUi({ s: { at: "2026-10-25T10:00:00.000Z", keys: { "t-a": "ab12", "t-b": "NOPE", "bad key!": "ab" } } }).s, { at: "2026-10-25T10:00:00.000Z", keys: { "t-a": "ab12" } });
  const newer = { o: {}, r: {}, s: { at: "2026-10-25T10:00:10.000Z", keys: { "t-a": "bb" } } };
  const older = { o: {}, r: {}, s: { at: "2026-10-25T10:00:00.000Z", keys: { "t-a": "aa" } } };
  assert.deepEqual(mergeUi(newer, older).s, newer.s);
  assert.deepEqual(mergeUi(older, newer).s, newer.s);
  assert.equal(mergeUi({ o: {}, r: {} }, { o: { x: 1 }, r: {} }).s, undefined, "a post without s leaves it absent");
  assert.deepEqual(mergeUi(newer, { o: { x: 1 }, r: {} }).s, newer.s, "and keeps what is stored");
});

test("the marks endpoint stores and returns the seen keys", async () => {
  const w = world([T("active")]);
  const srv = new MarksServer(() => w.root);
  const port = 40000 + Math.floor(Math.random() * 2000);
  await srv.listen(["127.0.0.1"], port);
  const url = `http://127.0.0.1:${port}/demo/state`;
  const body = { s: { at: "2026-10-25T10:00:00.000Z", keys: { "t-a": "abc" } } };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  assert.deepEqual((await (await fetch(url)).json()).s, body.s);
  assert.deepEqual(readUi(w.root, "demo").s, body.s);
  await srv.close();
});

// ---- the page script, in a vm with a fake clock, DOM and Lavish
function boot(lavish: any | null, data: { n: number; keys: object; seen?: object | null }) {
  let clock = 1_000_000;
  const timers: { fn: () => void; at: number }[] = [];
  const intervals: (() => void)[] = [];
  const posts: any[] = [];
  const attrs: Record<string, string> = { "data-n": String(data.n), "data-title": "Demo", "data-keys": JSON.stringify(data.keys) };
  if (data.seen) attrs["data-seen"] = JSON.stringify(data.seen);
  const attnEl = { getAttribute: (k: string) => attrs[k] ?? null };
  const liveEl: any = { contains: () => false, querySelectorAll: () => [], querySelector: (s: string) => (s === "[data-attn]" ? attnEl : null), set innerHTML(_h: string) {} };
  const styles = new Map<string, any>();
  const doc: any = {
    visibilityState: "visible", addEventListener() {}, activeElement: null,
    getElementById: (id: string) => (id === "live" ? liveEl : styles.get(id) ?? null),
    querySelectorAll: () => [],
    createElement: () => ({ remove() {} }),
    head: { appendChild: (e: any) => styles.set(e.id, e) },
  };
  const win: any = { name: "", scrollY: 0, scrollTo() {}, scrollBy() {}, addEventListener() {}, lavish };
  const ctx = vm.createContext({
    document: doc, window: win, location: { hash: "" }, localStorage: undefined, JSON, Object, Math, Array, encodeURIComponent, parseInt,
    Date: class extends Date { static now() { return clock; } }, Promise,
    setInterval: (fn: () => void) => intervals.push(fn), clearTimeout: (t: any) => { const i = timers.findIndex((x: any) => x === t); if (i >= 0) timers.splice(i, 1); },
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, at: clock + ms }; timers.push(t); return t; },
    fetch: (_u: string, init?: any) => { if (init?.method === "POST") posts.push(JSON.parse(init.body)); return Promise.resolve({ json: () => Promise.resolve({}) }); },
  });
  vm.runInContext(pageScript("p", "page.live.js", 1, "http://marks.test/demo/state"), ctx);
  const tick = (ms: number) => { clock += ms; for (const t of timers.filter((x) => x.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.fn(); } };
  return { win, doc, posts, styles, tick, intervals, live: (seq = 1) => win.__fdLive("<p>" + seq + "</p>", "2026-10-25T10:00:00Z", seq) };
}
const SEEN = { at: "2026-10-25T09:00:00.000Z", keys: { "t-a": "aaaaaaaa", page: "pppppppp" } };
const iconSvg = (u: string) => decodeURIComponent(u.slice("data:image/svg+xml,".length));

test("tab: quiet, needs you, new, both; the new dot clears after 3 s of looking and is posted", () => {
  const metas: any[] = [];
  const lavish = { setDocumentMeta: (m: any) => metas.push(m) };
  const quiet = boot(lavish, { n: 0, keys: { "t-a": "aaaaaaaa", page: "pppppppp" }, seen: SEEN });
  quiet.live();
  assert.equal(metas.at(-1).title, "Demo");
  assert.ok(!/circle/.test(iconSvg(metas.at(-1).icon)), "plain glyph");
  metas.length = 0;
  const both = boot(lavish, { n: 2, keys: { "t-a": "bbbbbbbb", page: "pppppppp" }, seen: SEEN });
  both.live();
  assert.equal(metas.at(-1).title, "(2) * Demo");
  const svg = iconSvg(metas.at(-1).icon);
  assert.match(svg, /#d97706/, "count badge");
  assert.match(svg, />2</);
  assert.match(svg, /#2563eb/, "new dot");
  assert.match(both.styles.get("fd-new").textContent, /\[id="t-a"\] \.ttl::after/, "the card gets a new dot");
  assert.match(both.styles.get("fd-new").textContent, /\.tn-a\[data-t="t-a"\]::after/, "and so does the navigator");
  both.tick(2900);
  assert.equal(both.posts.length, 0, "not yet");
  both.tick(200);
  assert.equal(both.posts.length, 1);
  assert.deepEqual(both.posts[0].s.keys, { "t-a": "bbbbbbbb", page: "pppppppp" }, "posts the keys it showed");
  assert.equal(metas.at(-1).title, "(2) Demo", "the * clears, the count stays");
  assert.equal(both.styles.get("fd-new").textContent, "");
});

test("tab: a hidden tab does not mark anything seen; a page with no stored seen shows nothing new", () => {
  const lavish = { setDocumentMeta: () => {} };
  const bg = boot(lavish, { n: 0, keys: { "t-a": "bbbbbbbb" }, seen: SEEN });
  bg.doc.visibilityState = "hidden";
  bg.live();
  bg.tick(10000);
  assert.equal(bg.posts.length, 0);
  const metas: any[] = [];
  const first = boot({ setDocumentMeta: (m: any) => metas.push(m) }, { n: 0, keys: { "t-a": "bbbbbbbb" }, seen: null });
  first.live();
  first.tick(10000);
  assert.equal(metas.at(-1).title, "Demo");
  assert.equal(first.posts.length, 0);
});

test("tab: stock Lavish (no setDocumentMeta) is left alone; a late hook is picked up; stale shows the warning", () => {
  const none = boot({}, { n: 1, keys: { "t-a": "bbbbbbbb" }, seen: SEEN });
  assert.doesNotThrow(() => none.live());
  const none2 = boot(null, { n: 1, keys: { "t-a": "bbbbbbbb" }, seen: SEEN });
  assert.doesNotThrow(() => none2.live());
  const metas: any[] = [];
  const late = boot({}, { n: 1, keys: { "t-a": "aaaaaaaa" }, seen: SEEN });
  late.live(1);
  late.win.lavish.setDocumentMeta = (m: any) => metas.push(m);
  late.live(2);
  assert.equal(metas.at(-1).title, "(1) Demo");
  const st: any[] = [];
  const old = boot({ setDocumentMeta: (m: any) => st.push(m) }, { n: 1, keys: { "t-a": "bbbbbbbb" }, seen: SEEN });
  old.live();
  old.tick(61000);
  old.intervals.forEach((f) => f());
  assert.equal(st.at(-1).title, "\u26a0 Demo", "not updating for 60 s");
  assert.ok(!/circle/.test(iconSvg(st.at(-1).icon)), "greyed glyph, no badge");
});

// ---- the Lavish binary setting
test("lavishBin: a setting only; default untouched; a missing path is an error, not a silent fallback", async () => {
  assert.equal(resolveConfig({}, { LAVISH_AXI_BIN: "/x" }).lavishBin, undefined);
  assert.equal(resolveConfig({ lavishBin: "  /opt/lavish/cli.mjs " }, {}).lavishBin, "/opt/lavish/cli.mjs");
  assert.equal(resolveConfig({ lavishBin: "" }, {}).lavishBin, undefined);
  const dir = mkdtempSync(join(tmpdir(), "lbin-"));
  const bin = join(dir, "cli.mjs");
  writeFileSync(bin, "");
  assert.equal(await resolveLavishBin(bin), bin);
  await assert.rejects(resolveLavishBin(join(dir, "nope.mjs")), /does not exist/);
});

test("the page script block holds no literal closing body/head/html tag: Lavish injects its SDK at the first one", () => {
  const w = world([T("active")]);
  const r = renderProject(loadProject(w.root, "demo"), {}, { now: NOW, paseoAgentUrl: (id: string) => id, tickSeconds: 1 });
  const script = r.page.slice(r.page.lastIndexOf("<script>"));
  const head = script.slice(0, script.lastIndexOf("</script>"));
  assert.ok(!/<\/(body|head|html)/i.test(head), "escaped as <\\/body> inside the script");
  assert.equal((r.page.match(/<\/body>/g) ?? []).length, 1, "the real one is the only one");
});
