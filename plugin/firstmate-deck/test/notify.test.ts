// "Notify me": the browser notifications for tasks that enter Needs you. The flow runs against the real deck and its real
// web server; the notification window's script is the one that server hands out, run in a bare browser stand-in (the
// Notification API, locks and window handles are the browser's, so those are faked).
process.env.TZ = "UTC";
process.env.FM_DECK_POLL_MODE ??= "cli";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { Deck, type DeckOpts } from "../server/runtime.ts";
import { readPageJson } from "../server/store.ts";
import { notifyPageSide } from "../server/notify.ts";
import { resolveConfig } from "../server/config.ts";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector } from "../server/paseo-port.ts";
import { FakeWorld, fakePaseo } from "./fake-paseo.ts";

/** Values made inside the stand-in browser belong to another realm: compare plain copies. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(5); }
}

type T = { id: string; state?: string; title?: string; asks?: { id: string; text: string }[] };
const ask = (id: string, text: string) => ({ id, text, since: "2026-11-28T10:00:00Z" });

async function rig(tasks: T[], o: { cfg?: Record<string, unknown>; deck?: Partial<DeckOpts>; crew?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deck-nt-"));
  const pdir = join(root, "state", "projects", "demo");
  mkdirSync(join(pdir, "sections"), { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo <app>", sections: [] }));
  writeFileSync(join(pdir, "page.json"), JSON.stringify({ lavishUrl: "http://127.0.0.1:4999/session/abc", session: "open" }));
  const fleet = (ts: T[]) => writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: ts.map((t) => ({ intent: t.id, project: "demo", state: "active", ...t })) }));
  fleet(tasks);
  const fw = new FakeWorld().add({ id: "fm-1", status: "idle", labels: { firstmate: "true" } });
  for (const task of o.crew ?? []) fw.add({ id: `ag-${task}`, status: "idle", createdAt: "2026-11-28T10:00:00Z", labels: { "fm.task": task, "fm.project": "demo" } });
  const exec = async (args: string[]) => (args[0] === "status" ? JSON.stringify({ listen: "127.0.0.1:1", serverId: "srv" }) : args[0] === "ls" ? "[]" : "");
  const ports = new PortSelector(new CliPort(exec));
  ports.capture({ paseo: fakePaseo(fw) }, "test");
  const port = 42000 + Math.floor(Math.random() * 1500);
  const deck = new Deck({ exec, ports, tailnetIp: async () => "", readConfig: async () => ({ root, firstmateLabel: "firstmate=true", readMarksPort: port, canvasUrl: "", ...o.cfg }) as any, ...o.deck });
  await deck.configure();
  await deck.render("demo");
  const base = `http://127.0.0.1:${port}`;
  const key = () => (readPageJson(join(pdir, "page.json")) as any).notifyKey as string;
  return { root, pdir, deck, base, key, page: () => readFileSync(join(pdir, "page.html"), "utf8"),
    async set(ts: T[]) { fleet(ts); await deck.render("demo"); } };
}

/** The notification window: the served page's script in a stand-in browser. */
type Opts = { secure?: boolean; permission?: string; answer?: string; opener?: any; locks?: ReturnType<typeof makeLocks>; clock?: { now: number } };
function makeLocks() {
  const held = new Map<string, () => void>();
  return { request(name: string, o: { steal?: boolean }, cb: () => Promise<unknown>) {
    return new Promise((resolve, reject) => {
      if (o.steal) held.get(name)?.();
      held.set(name, () => reject(Object.assign(new Error("stolen"), { name: "AbortError" })));
      cb().then(resolve, reject);
    });
  } };
}
async function openWindow(r: { base: string; key: () => string }, o: Opts = {}, hash = `#k=${r.key()}`) {
  const res = await fetch(`${r.base}/demo/notify`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  const html = await res.text();
  const src = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const els = new Map<string, any>();
  const el = (id: string) => { if (!els.has(id)) els.set(id, { id, hidden: new RegExp(`id="${id}"[^>]*\\shidden`).test(html), textContent: "", onclick: null }); return els.get(id); };
  const fired: any[] = [], asked: number[] = [], opened: string[] = [], listeners: Record<string, ((e: any) => void)[]> = {};
  const timers: (() => void)[] = [];
  let fetches = 0, closed = false, selfFocus = 0;
  class Notification {
    static permission = o.permission ?? "granted";
    static async requestPermission() { asked.push(1); return (Notification.permission = o.answer ?? "granted"); }
    onclick: ((e: any) => void) | null = null;
    title: string; options: any;
    constructor(title: string, options: any) { this.title = title; this.options = options; fired.push(this); }
    close() {}
  }
  const window: any = {
    isSecureContext: o.secure ?? true, Notification, opener: o.opener ?? null,
    open: (u: string) => { opened.push(u); return {}; }, focus: () => { selfFocus++; }, close: () => { closed = true; },
    addEventListener: (t: string, fn: (e: any) => void) => { (listeners[t] ??= []).push(fn); },
  };
  const clock = o.clock ?? { now: 1_000_000 };
  const ctx = vm.createContext({
    window, Notification: window.Notification,
    document: { getElementById: el, title: "" },
    location: { hash, host: "box.example:4398", hostname: "box.example" },
    navigator: { locks: o.locks ?? makeLocks() },
    fetch: async (u: string) => { try { return await fetch(new URL(u, `${r.base}/demo/notify`)); } finally { fetches++; } },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    Date: { now: () => clock.now },
  });
  vm.runInContext(src, ctx);
  /** Let the poll in flight finish: it ends by scheduling the next one. */
  const settled = () => until(() => timers.length > 0);
  return {
    html, fired, asked, opened, listeners, clock, el, window,
    get closed() { return closed; }, get selfFocus() { return selfFocus; }, get fetches() { return fetches; }, get timers() { return timers.length; },
    settled,
    /** Run the scheduled poll without waiting for a next one (a stopped window schedules none). */
    run() { timers.shift()?.(); },
    async next(advance = 5000) { await settled(); clock.now += advance; timers.shift()!(); await settled(); },
  };
}

const WAITING: T = { id: "old", title: "Already waiting", asks: [ask("a1", "Old question?")] };

test("the needs-you list: only tasks in Needs you, with title and the reason; behind the page's key", async () => {
  const r = await rig([WAITING, { id: "busy", state: "queued" }, { id: "fin", state: "done" }]);
  try {
    const ok = await fetch(`${r.base}/demo/needs?k=${r.key()}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { page: "http://127.0.0.1:4999/session/abc", tasks: [{ id: "old", title: "Already waiting", reason: "Old question?" }] });
    assert.equal(ok.headers.get("access-control-allow-origin"), null, "no other site may read task titles");
    assert.equal((await fetch(`${r.base}/demo/needs?k=wrong`)).status, 403);
    assert.equal((await fetch(`${r.base}/demo/needs`)).status, 403);
    assert.equal((await fetch(`${r.base}/nope/needs?k=${r.key()}`)).status, 404);
    assert.equal((await fetch(`${r.base}/nope/notify`)).status, 404);
  } finally { r.deck.stop(); }
});

test("until a crew's canvas has been read the list is not ready: a half-read list would look like tasks leaving", async () => {
  let up = false;
  const canvasFetch = (async (url: string) => {
    if (!up) throw new Error("down");
    const body = url.includes("/summary") ? { agents: [] } : {};
    return { ok: true, status: 200, text: async () => "", json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
  }) as any;
  const r = await rig([WAITING, { id: "crewed" }], { crew: ["crewed"], cfg: { canvasUrl: "http://canvas.invalid" }, deck: { canvasFetch, canvasPollMs: 20 } });
  try {
    const url = () => `${r.base}/demo/needs?k=${r.key()}`;
    assert.equal((await fetch(url())).status, 503);
    up = true;
    const t0 = Date.now();
    let status = 503;
    while (status !== 200 && Date.now() - t0 < 4000) { await sleep(40); status = (await fetch(url())).status; }
    assert.equal(status, 200);
  } finally { r.deck.stop(); }
});

test("the project page offers Notify me only with the deck's web server on, at its address or the https one set for it", async () => {
  const off = await rig([WAITING], { cfg: { readMarksPort: 0 } });
  try { assert.doesNotMatch(off.page(), /id="fd-notify"|\/demo\/notify/); } finally { off.deck.stop(); }
  const on = await rig([WAITING]);
  try {
    assert.match(on.page(), /<button[^>]*id="fd-notify"[^>]*data-lavish-action[^>]*>Notify me<\/button>/);
    assert.ok(on.page().includes(`${on.base}/demo/notify#k=${on.key()}`));
  } finally { on.deck.stop(); }
  const tls = await rig([WAITING], { cfg: { notifyUrl: "https://box.example:8443" } });
  try { assert.ok(tls.page().includes(`https://box.example:8443/demo/notify#k=${tls.key()}`)); } finally { tls.deck.stop(); }
  assert.equal(resolveConfig({ notifyUrl: " https://box.example:8443/ " }, {}).notifyUrl, "https://box.example:8443");
  assert.equal(resolveConfig({ notifyUrl: "" }, {}).notifyUrl, undefined);
});

test("a task entering Needs you fires one notification with its title and reason; waiting tasks, polls and reloads fire none", async () => {
  const quiet: T = { id: "pick", state: "queued", title: "Pick a queue library" };
  const r = await rig([WAITING, quiet]);
  try {
    const w = await openWindow(r);
    await w.next();
    assert.equal(w.fired.length, 0, "already waiting when the window opened");
    assert.match(w.el("msg").textContent, /Watching/);
    assert.match(w.el("msg").textContent, /1 task needs you/);

    await r.set([WAITING, { ...quiet, state: "active", asks: [ask("a1", "BullMQ or pg-boss?")] }]);
    await w.next();
    assert.deepEqual(w.fired.map((n) => [n.title, n.options.body, n.options.tag]), [["Pick a queue library", "BullMQ or pg-boss?", "fm:demo:pick"]]);
    await w.next();
    await w.next(120_000);
    assert.equal(w.fired.length, 1, "still waiting: nothing new");

    const again = await openWindow(r);
    await again.next();
    await again.next();
    assert.equal(again.fired.length, 0, "a reload repeats nothing");
  } finally { r.deck.stop(); }
});

test("leaving Needs you and entering it again fires again; a short blip with the same reason does not", async () => {
  const asking: T = { id: "pick", title: "Pick", asks: [ask("a1", "Which?")] };
  const gone: T = { id: "pick", title: "Pick", state: "queued" };
  const r = await rig([gone]);
  try {
    const w = await openWindow(r);
    await w.next();
    await r.set([asking]); await w.next();
    assert.equal(w.fired.length, 1);
    await r.set([gone]); await w.next();
    await r.set([asking]); await w.next();
    assert.equal(w.fired.length, 1, "back within a minute, same reason: the same wait");
    await r.set([gone]); await w.next(); await w.next(90_000);
    await r.set([asking]); await w.next();
    assert.equal(w.fired.length, 2, "gone for longer: a new wait");
    await r.set([gone]); await w.next();
    await r.set([{ ...asking, asks: [ask("a2", "And the region?")] }]); await w.next();
    assert.equal(w.fired.length, 3, "a different question is news however soon");
    assert.equal(w.fired[2].options.body, "And the region?");
  } finally { r.deck.stop(); }
});

test("an unreachable or not-ready deck changes nothing: what was waiting does not fire when it is back", async () => {
  const r = await rig([WAITING]);
  try {
    const w = await openWindow(r);
    await w.next();
    r.deck.stop(); // the web server is gone
    await w.next(); await w.next(120_000);
    assert.match(w.el("msg").textContent, /Can.t reach/);
    assert.equal(w.fired.length, 0);
    assert.ok(w.timers > 0, "keeps trying");
  } finally { r.deck.stop(); }
});

test("opt-in: nothing is asked or watched until the button is pressed, and the browser is asked once", async () => {
  const r = await rig([WAITING]);
  try {
    const w = await openWindow(r, { permission: "default" });
    await sleep(30);
    assert.equal(w.asked.length, 0);
    assert.equal(w.fetches, 0);
    assert.equal(w.el("allow").hidden, false);
    await w.el("allow").onclick();
    await w.settled();
    assert.equal(w.asked.length, 1);
    assert.equal(w.el("allow").hidden, true);
    assert.match(w.el("msg").textContent, /Watching/);
    assert.equal(w.fired.length, 0);
  } finally { r.deck.stop(); }
});

test("blocked, insecure or out-of-date: the window says what to do and never watches", async () => {
  const r = await rig([WAITING]);
  try {
    const denied = await openWindow(r, { permission: "default", answer: "denied" });
    await denied.el("allow").onclick();
    assert.match(denied.el("msg").textContent, /blocked/i);
    assert.equal(denied.fetches, 0);
    const insecure = await openWindow(r, { secure: false, permission: "denied" });
    assert.match(insecure.el("msg").textContent, /https/);
    assert.match(insecure.el("msg").textContent, /dom\.securecontext\.allowlist.*box\.example/s);
    assert.equal(insecure.el("allow").hidden, true);
    assert.equal(insecure.asked.length + insecure.fetches, 0);
    const stale = await openWindow(r, {}, "#k=old");
    await until(() => stale.fetches > 0);
    await sleep(20);
    assert.match(stale.el("msg").textContent, /Notify me/);
    assert.equal(stale.timers, 0);
  } finally { r.deck.stop(); }
});

test("a newer window takes over: the older one stops, so nothing is notified twice", async () => {
  const r = await rig([{ id: "pick", state: "queued" }]);
  try {
    const locks = makeLocks();
    const first = await openWindow(r, { locks });
    await first.next();
    const second = await openWindow(r, { locks });
    await second.next();
    assert.equal(first.closed, true);
    await r.set([{ id: "pick", asks: [ask("a1", "Which?")] }]);
    const before = first.fetches;
    first.run();
    await second.next();
    assert.equal(first.fetches, before, "it no longer asks");
    assert.equal(second.fired.length, 1);
    assert.equal(first.fired.length, 0);
  } finally { r.deck.stop(); }
});

/** The project page's tab as the notification window holds it: the top window and the frames in it. */
function tab() {
  const log: any[] = [];
  const frame = { postMessage: (m: any) => log.push(["post", plain(m)]) };
  const top: any = { closed: false, focus: () => log.push(["focus"]), length: 1, 0: frame };
  return { log, top, frame };
}

test("clicking a notification brings the page's tab forward and asks it to show that card, even after the tab reloaded", async () => {
  const r = await rig([{ id: "pick", state: "queued" }]);
  try {
    const t = tab();
    const opener: any = { closed: false, top: t.top };
    const w = await openWindow(r, { opener });
    await w.next();
    await r.set([{ id: "pick", asks: [ask("a1", "Which?")] }]);
    await w.next();
    opener.closed = true; // a reload of the tab replaces the frame that opened this window; the tab stays
    w.fired[0].onclick({ preventDefault() {} });
    assert.deepEqual(t.log, [["focus"], ["post", { type: "fm-notify-focus", task: "pick" }]]);
    assert.deepEqual(w.opened, []);
  } finally { r.deck.stop(); }
});

test("clicking a notification after the tab was closed opens the page and shows the card once it says hello", async () => {
  const r = await rig([{ id: "pick", state: "queued" }]);
  try {
    const t = tab();
    const w = await openWindow(r, { opener: { closed: false, top: t.top } });
    await w.next();
    await r.set([{ id: "pick", asks: [ask("a1", "Which?")] }]);
    await w.next();
    t.top.closed = true;
    w.fired[0].onclick({ preventDefault() {} });
    assert.deepEqual(w.opened, ["http://127.0.0.1:4999/session/abc"]);
    const fresh = tab();
    const source = { top: fresh.top, postMessage: (m: any) => fresh.log.push(["post", plain(m)]) };
    for (const fn of w.listeners.message) fn({ data: { type: "fm-notify-hello" }, source });
    assert.deepEqual(fresh.log, [["post", { type: "fm-notify-focus", task: "pick" }]]);
    for (const fn of w.listeners.message) fn({ data: { type: "fm-notify-hello" }, source });
    assert.equal(fresh.log.length, 1, "asked once");
  } finally { r.deck.stop(); }
});

/** The project page's side: its script in a stand-in frame. */
function frame(url = "https://box.example:8443/demo/notify#k=abc", opener: any = null) {
  const cards = new Set<string>(), went: string[] = [], opened: any[] = [], listeners: ((e: any) => void)[] = [];
  const button: any = { onclick: null, addEventListener(_: string, fn: any) { this.onclick = fn; } };
  let swaps = 0;
  const window: any = {
    top: { opener }, open: (...a: any[]) => { opened.push(a); return {}; },
    addEventListener: (t: string, fn: any) => { if (t === "message") listeners.push(fn); },
    __tn: () => { swaps++; }, __fdGo: (id: string) => { if (!cards.has(id)) return false; went.push(id); return true; },
  };
  vm.runInContext(notifyPageSide("demo", url), vm.createContext({ window, document: { getElementById: (id: string) => (id === "fd-notify" ? button : null) }, URL }));
  const say = (origin: string, data: unknown) => listeners.forEach((fn) => fn({ origin, data }));
  return { cards, went, opened, button, window, say, get swaps() { return swaps; } };
}

test("page side: the button opens the one notification window of this project", () => {
  const f = frame();
  assert.equal(f.opened.length, 0);
  f.button.onclick();
  assert.deepEqual(f.opened.map((a) => a.slice(0, 2)), [["https://box.example:8443/demo/notify#k=abc", "fm-notify-demo"]]);
  assert.match(f.opened[0][2], /popup/);
});

test("page side: only the notification window's origin can move the page; a card not drawn yet is shown after the next update", () => {
  const f = frame();
  f.cards.add("t-pick");
  f.say("http://evil.example", { type: "fm-notify-focus", task: "pick" });
  assert.deepEqual(f.went, []);
  f.say("https://box.example:8443", { type: "fm-notify-focus", task: "pick" });
  assert.deepEqual(f.went, ["t-pick"]);
  f.say("https://box.example:8443", { type: "fm-notify-focus", task: "later" });
  f.window.__tn();
  assert.deepEqual(f.went, ["t-pick"]);
  f.cards.add("t-later");
  f.window.__tn();
  f.window.__tn();
  assert.deepEqual(f.went, ["t-pick", "t-later"], "shown once");
  assert.equal(f.swaps, 3, "the navigator's own update still runs");
});

test("page side: a page the notification window opened tells it that it is there", () => {
  const sent: any[] = [];
  frame(undefined, { postMessage: (...a: any[]) => sent.push(plain(a)) });
  assert.deepEqual(sent, [[{ type: "fm-notify-hello" }, "https://box.example:8443"]]);
});
