// "Notify me": web push for tasks that enter Needs you. The flows run against the real deck and its real web server. The
// push service is the one outside thing: it is faked, and the fake opens each message with the browser's keys (RFC 8291),
// as Firefox does. The opt-in page's script and the service worker are the ones the server hands out, run in bare browser
// stand-ins (Notification, PushManager and the worker globals are the browser's).
// It must never reach a real Lavish: the page session is not "open" (nothing polls), and the binary, port and state dir
// are dead ends. A deck that finds a newer lavish-axi would otherwise replace the captain's running server.
process.env.TZ = "UTC";
process.env.LAVISH_AXI_BIN = "/nonexistent/lavish-axi.mjs";
process.env.LAVISH_AXI_PORT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createServer } from "node:net";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from "node:crypto";
import { Deck, type DeckOpts } from "../server/runtime.ts";
import { notifyPageSide } from "../server/notify.ts";
import { encryptPush } from "../server/push.ts";
import { computeStage } from "../server/stage.ts";
import { resolveConfig } from "../server/config.ts";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector } from "../server/paseo-port.ts";
import { FakeWorld, fakePaseo } from "./fake-paseo.ts";

/** Values made inside the stand-in browser belong to another realm: compare plain copies. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(5); }
}

type T = { id: string; state?: string; title?: string; asks?: { id: string; text: string }[] };
const ask = (id: string, text: string) => ({ id, text, since: "2026-11-28T10:00:00Z" });

const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); }); });

const unb64 = (s: string) => Buffer.from(s, "base64url");
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, n: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, n));

/** A browser's subscription, and what only that browser can do: open a message sent to it. */
function browserSub(host = "updates.push.services.mozilla.com") {
  const ecdh: ECDH = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const endpoint = `https://${host}/wpush/v2/${randomBytes(12).toString("base64url")}`;
  const open = (body: Buffer) => {
    const salt = body.subarray(0, 16), asPublic = body.subarray(21, 21 + body[20]), data = body.subarray(21 + body[20]);
    const ikm = hkdf(ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]), 32);
    const d = createDecipheriv("aes-128-gcm", hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    d.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
    assert.equal(plain.at(-1), 2, "last-record delimiter");
    return JSON.parse(plain.subarray(0, -1).toString("utf8"));
  };
  return { endpoint, open, json: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
}
type Sub = ReturnType<typeof browserSub>;

/** The push service. `reply` is the status it gives next ("offline" = the request never arrives). */
function pushService() {
  const sent: { url: string; headers: Record<string, string>; body: Buffer; redirect?: string }[] = [];
  const s = {
    sent, reply: (_url: string): number | "offline" => 201,
    why: (status: number) => `reason ${status}`,
    fetch: (async (url: string, init: any) => {
      const status = s.reply(url);
      sent.push({ url, headers: init.headers, body: Buffer.from(init.body), redirect: init.redirect });
      if (status === "offline") throw new TypeError("fetch failed");
      return new Response(status < 300 ? null : s.why(status), { status });
    }) as typeof fetch,
    /** What arrived for this browser, opened. */
    inbox: (b: Sub) => sent.filter((m) => m.url === b.endpoint).map((m) => b.open(m.body)),
  };
  return s;
}

async function rig(tasks: T[], o: { cfg?: Record<string, unknown>; deck?: Partial<DeckOpts>; crew?: string[]; brokenFleet?: boolean; agents?: { broken: boolean }; noPush?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deck-nt-"));
  const pdir = join(root, "state", "projects", "demo");
  mkdirSync(join(pdir, "sections"), { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo <app>", sections: [] }));
  writeFileSync(join(pdir, "page.json"), JSON.stringify({ lavishUrl: "http://127.0.0.1:1/session/abc", session: "unknown" }));
  const fleet = (ts: T[]) => writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: ts.map((t) => ({ intent: t.id, project: "demo", state: "active", ...t })) }));
  if (o.brokenFleet) writeFileSync(join(root, "state", "fleet.json"), ""); else fleet(tasks);
  const fw = new FakeWorld().add({ id: "fm-1", status: "idle", labels: { firstmate: "true" } });
  for (const task of o.crew ?? []) fw.add({ id: `ag-${task}`, status: "idle", createdAt: "2026-11-28T10:00:00Z", labels: { "fm.task": task, "fm.project": "demo" } });
  const exec = async (args: string[]) => (args[0] === "status" ? JSON.stringify({ listen: "127.0.0.1:1", serverId: "srv" }) : args[0] === "ls" ? "[]" : "");
  const ports = new PortSelector(new CliPort(exec));
  const paseo: any = fakePaseo(fw);
  const list = paseo.agents.list;
  paseo.agents.list = async (q: any) => { if (o.agents?.broken) throw new Error("daemon busy"); return list(q); };
  ports.capture({ paseo }, "test");
  const port = await freePort(); // a guessed port can collide with a test file running alongside
  const cfg = { root, firstmateLabel: "firstmate=true", readMarksPort: port, canvasUrl: "", lavishBin: "/nonexistent/lavish-axi.mjs", lavishPort: "1", lavishStateDir: join(root, "lavish"), ...o.cfg };
  const pushDir = join(root, "plugin-settings", "firstmate-deck", "push");
  const push = pushService(), clock = { now: 1_000_000 };
  const start = async () => {
    const d = new Deck({ exec, ports, tailnetIp: async () => "", readConfig: async () => cfg as any,
      ...(o.noPush ? {} : { pushDir }), pushFetch: push.fetch, pushNow: () => clock.now, pushRetryMs: [20, 40], ...o.deck });
    await d.configure();
    await d.render("demo");
    return d;
  };
  let deck = await start();
  const base = `http://127.0.0.1:${port}`;
  const page = () => readFileSync(join(pdir, "page.html"), "utf8");
  /** The key in the page's "Notify me" link. */
  const key = () => /_push\/#k=([0-9a-f]+)/.exec(page())![1];
  const post = (path: string, body: unknown) => fetch(`${base}/_push/${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  /** The page's live payload: where crews' canvas questions show up. */
  const live = () => { try { return readFileSync(join(pdir, "page.live.js"), "utf8"); } catch { return ""; } };
  return { root, pdir, pushDir, fw, base, key, page, live, post, push, clock,
    get deck() { return deck; },
    stop() { deck.stop(); },
    /** A browser opts in. */
    async subscribe(sub = browserSub()) { assert.equal((await post("subscribe", { k: key(), sub: sub.json })).status, 204); return sub; },
    /** fleet.json changes with no deck looking. */
    write: fleet,
    async restart() { deck.stop(); await sleep(50); deck = await start(); },
    /** Time passes, the tasks change, the deck looks, and what it sent has left. */
    async set(ts: T[], later = 5000) { clock.now += later; fleet(ts); await deck.render("demo"); await deck.pushIdle(); },
    /** Paseo says something about a crew agent changed. */
    async agentMoved(id: string) { clock.now += 5000; deck.onAgentEvent(id); await deck.render("demo"); await deck.pushIdle(); },
    /** The deck's log, without the time on each line. */
    log(): string[] {
      let text = "";
      try { text = readFileSync(join(pushDir, "push.log"), "utf8"); } catch {}
      return text.split("\n").filter(Boolean).map((l) => { assert.match(l, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /); return l.slice(20); });
    },
  };
}

/** agent-canvas as the deck sees it: unanswered, failing, or answering with these open questions per agent. */
function fakeCanvas() {
  const c = { mode: "ok" as "hang" | "down" | "ok", asks: {} as Record<string, string>, rev: 0 };
  const fetch = (async (url: string) => {
    if (c.mode === "hang") return new Promise(() => {});
    if (c.mode === "down") throw new Error("down");
    const agents = Object.entries(c.asks).map(([agentId, question]) => ({ agentId, rev: c.rev, archived: false, title: "", verdict: { label: "Needs you", flags: [], needsYou: true }, bluf: "",
      steps: { done: 0, total: 0, current: null }, openAsks: [{ id: "q1", question, options: [], blocking: true }], updatedAt: null, runState: "idle", url: "", agentUrl: null, auto: false }));
    return { ok: true, status: 200, text: async () => "", json: async () => ({ agents }), arrayBuffer: async () => new ArrayBuffer(0) };
  }) as any;
  return { c, opts: { cfg: { canvasUrl: "http://canvas.invalid" }, deck: { canvasFetch: fetch, canvasPollMs: 20 } } };
}

const WAITING: T = { id: "old", title: "Already waiting", asks: [ask("a1", "Old question?")] };
const quiet: T = { id: "pick", state: "queued", title: "Pick a queue library" };
const asking: T = { ...quiet, state: "active", asks: [ask("a1", "BullMQ or pg-boss?")] };
const titles = (r: { push: ReturnType<typeof pushService> }, b: Sub) => r.push.inbox(b).map((m) => m.title);
/** Wait for the deck to have looked (and sent) after a change it notices by itself, e.g. a canvas answer. */
async function looked(r: { deck: Deck; clock: { now: number } }, ok: () => boolean) { await until(ok); await r.deck.pushIdle(); }

test("encryption matches the published example (RFC 8291, appendix A)", () => {
  const body = encryptPush(Buffer.from("When I grow up, I want to be a watermelon"),
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    { salt: unb64("DGv6ra1nlYgDCS1FRnbzlw"), privateKey: unb64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") });
  assert.equal(body.toString("base64url"), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("a task entering Needs you is pushed once, with its title, reason and page; waiting tasks, later looks and restarts push nothing", async () => {
  const r = await rig([WAITING, quiet]);
  try {
    const b = await r.subscribe();
    await r.set([WAITING, quiet]);
    assert.equal(r.push.sent.length, 0, "already waiting");
    await r.set([WAITING, asking]);
    assert.deepEqual(r.push.inbox(b).map((m) => [m.title, m.body, m.tag, m.url]), [["Pick a queue library", "BullMQ or pg-boss?", "fm:demo:pick", "http://127.0.0.1:1/session/abc"]]);
    await r.set([WAITING, asking]);
    await r.set([WAITING, asking], 120_000);
    await r.restart();
    await r.set([WAITING, asking], 120_000);
    assert.equal(r.push.sent.length, 1, "once");
  } finally { r.stop(); }
});

test("the push service is addressed as the standard asks: signed with the deck's own key, no personal contact, no redirects", async () => {
  const r = await rig([quiet]);
  try {
    await r.subscribe();
    await r.set([asking]);
    const m = r.push.sent[0];
    assert.equal(m.headers["Content-Encoding"], "aes128gcm");
    assert.equal(m.headers.TTL, "86400");
    assert.equal(m.headers.Urgency, "high");
    assert.equal(m.redirect, "error");
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(m.headers.Authorization)!;
    const [h, p, sig] = jwt.split(".");
    const pub = unb64(k);
    const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") } });
    assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, unb64(sig)));
    const claims = JSON.parse(unb64(p).toString());
    assert.equal(claims.aud, "https://updates.push.services.mozilla.com");
    assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 86_400);
    assert.equal(claims.sub, "mailto:deck@localhost.invalid");
    const page = await (await fetch(`${r.base}/_push/`)).text();
    assert.ok(page.includes(k), "the opt-in page subscribes with the same key");
  } finally { r.stop(); }
});

test("keys are made once, kept in the settings folder for the owner only, and survive a restart", async () => {
  const r = await rig([quiet]);
  try {
    const b = await r.subscribe();
    const file = join(r.pushDir, "keys.json"), keys = readFileSync(file, "utf8"), key = r.key();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(r.pushDir, "subscriptions.json")).mode & 0o777, 0o600);
    await r.restart();
    assert.equal(readFileSync(file, "utf8"), keys);
    assert.equal(r.key(), key);
    await r.set([asking]);
    assert.deepEqual(titles(r, b), ["Pick a queue library"], "the subscription survived too");
  } finally { r.stop(); }
});

test("every subscribed browser gets it; one opting in later gets only what starts waiting after", async () => {
  const other: T = { id: "region", state: "queued", title: "Region" };
  const r = await rig([quiet, other]);
  try {
    const first = await r.subscribe();
    await r.subscribe(first);
    await r.set([asking, other]);
    const second = await r.subscribe(browserSub("fcm.googleapis.com"));
    await r.set([asking, { ...other, state: "active", asks: [ask("a1", "Mumbai?")] }]);
    assert.deepEqual(titles(r, first), ["Pick a queue library", "Region"], "subscribing twice does not double");
    assert.deepEqual(titles(r, second), ["Region"]);
  } finally { r.stop(); }
});

test("leaving Needs you and entering it again pushes again; a short blip with the same reason does not", async () => {
  const gone: T = { ...quiet };
  const r = await rig([gone]);
  try {
    const b = await r.subscribe();
    await r.set([asking]);
    await r.set([gone]);
    await r.set([asking]);
    assert.equal(titles(r, b).length, 1, "back within a minute, same reason: the same wait");
    await r.set([gone]); await r.set([gone], 90_000);
    await r.set([asking]);
    assert.equal(titles(r, b).length, 2, "gone for longer: a new wait");
    await r.set([gone]);
    await r.set([{ ...asking, asks: [ask("a2", "And the region?")] }]);
    assert.equal(titles(r, b).length, 3, "a different question is news however soon");
    assert.equal(r.push.inbox(b)[2].body, "And the region?");
  } finally { r.stop(); }
});

test("what started waiting while the deck was off is pushed when it is back", async () => {
  const r = await rig([WAITING]);
  try {
    const b = await r.subscribe();
    r.stop();
    r.write([WAITING, { id: "during", title: "Started waiting meanwhile", asks: [ask("a1", "Which?")] }]);
    await r.restart();
    await r.set([WAITING, { id: "during", title: "Started waiting meanwhile", asks: [ask("a1", "Which?")] }]); // the deck's next look
    assert.deepEqual(titles(r, b), ["Started waiting meanwhile"]);
  } finally { r.stop(); }
});

test("a stopped page sends nothing", async () => {
  const r = await rig([quiet]);
  try {
    await r.subscribe();
    const pj = join(r.pdir, "page.json");
    writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, "utf8")), session: "stopped" }));
    await r.set([asking]);
    assert.equal(r.push.sent.length, 0);
  } finally { r.stop(); }
});

test("nothing is concluded before the crews' canvases are read; with agent-canvas down new asks still push and old canvas questions stay quiet", async () => {
  const { c, opts } = fakeCanvas();
  c.mode = "hang";
  c.asks = { "ag-drawn": "Was waiting all along?" };
  const tasks: T[] = [{ id: "drawn" }, { id: "pick", state: "queued" }];
  const hung = await rig(tasks, { ...opts, crew: ["drawn"] });
  try {
    await hung.subscribe();
    await hung.set([tasks[0], { id: "pick", asks: [ask("a1", "Which?")] }]);
    assert.equal(hung.push.sent.length, 0, "the deck cannot yet tell what was already waiting");
  } finally { hung.stop(); }
  c.mode = "down";
  const r = await rig(tasks, { ...opts, crew: ["drawn"] });
  try {
    const b = await r.subscribe();
    await sleep(100); await r.set(tasks);
    await r.set([tasks[0], { id: "pick", asks: [ask("a1", "Which?")] }]);
    assert.deepEqual(r.push.inbox(b).map((m) => m.tag), ["fm:demo:pick"]);
    c.mode = "ok";
    await looked(r, () => /Was waiting all along/.test(r.live()));
    await r.set([tasks[0], { id: "pick", asks: [ask("a1", "Which?")] }]);
    assert.equal(r.push.sent.length, 1);
  } finally { r.stop(); }
});

test("until Paseo has said which agents are crew, and while fleet.json is unreadable, the list is not treated as empty", async () => {
  const agents = { broken: true };
  const r = await rig([quiet], { agents });
  try {
    await r.subscribe();
    await r.set([WAITING, quiet]); // taken as a real list, the empty one before it would make this news
    agents.broken = false;
    await r.agentMoved("fm-1");
    await sleep(100); await r.set([WAITING, quiet]);
    assert.equal(r.push.sent.length, 0);
    await r.set([WAITING, asking]);
    assert.equal(r.push.sent.length, 1, "and from then on the deck is watching");
  } finally { r.stop(); }
  const s = await rig([], { brokenFleet: true });
  try {
    await s.subscribe();
    await s.set([WAITING]);
    assert.equal(s.push.sent.length, 0, "the first readable list is the starting point");
  } finally { s.stop(); }
});

test("the reason says why: a permission request (each one new), a canvas question, a stalled first mate", async () => {
  const { c, opts } = fakeCanvas();
  const r = await rig([{ id: "perm", title: "Perm" }, { id: "drawn", title: "Drawn" }], { ...opts, crew: ["perm", "drawn"] });
  const permission = async (n: number) => { r.fw.agents.get("ag-perm")!.pendingPermissions = Array.from({ length: n }, () => ({ id: "p" })); r.fw.agents.get("ag-perm")!.status = "running"; await r.agentMoved("ag-perm"); };
  try {
    const b = await r.subscribe();
    await permission(0);
    await looked(r, () => r.live().includes("ag-drawn"));
    await sleep(100); await permission(0);
    await permission(1); await permission(0); await permission(1);
    assert.deepEqual(r.push.inbox(b).map((m) => m.body), Array(2).fill("A crew is waiting for your permission answer."));
    c.asks = { "ag-drawn": "Ship **now** or wait?" }; c.rev++;
    await looked(r, () => titles(r, b).includes("Drawn"));
    assert.equal(r.push.inbox(b).at(-1).body, "Ship now or wait?");
  } finally { r.stop(); }
  const s = await rig([{ id: "review", title: "Review" }], { crew: ["review"] });
  try {
    const b = await s.subscribe();
    s.fw.agents.get("ag-review")!.status = "error";
    await s.agentMoved("ag-review");
    const { fp } = computeStage({ state: "active", asks: [] }, [{ id: "ag-review", status: "error", archived: false, pendingPermissions: 0 }], new Date());
    s.clock.now += 5000;
    s.deck.setEnforcement([], { review: { fp, why: "ignored twice" } });
    await looked(s, () => titles(s, b).length === 1);
    assert.equal(s.push.inbox(b)[0].body, "The first mate stalled on this task.");
  } finally { s.stop(); }
});

test("a browser the push service no longer knows is forgotten; a refusal is logged and not retried", async () => {
  const r = await rig([quiet]);
  try {
    const gone = await r.subscribe(), refused = await r.subscribe();
    r.push.reply = (u) => (u === gone.endpoint ? 410 : 403);
    await r.set([asking]);
    await sleep(120);
    assert.equal(r.push.sent.length, 2);
    await r.set([quiet]); await r.set([quiet], 90_000);
    await r.set([asking]);
    assert.deepEqual(r.push.sent.slice(2).map((m) => m.url), [refused.endpoint]);
    assert.match(r.log().join("\n"), /push service replied 410, this browser's subscription is gone and forgotten: reason 410/);
    assert.match(r.log().join("\n"), /push service replied 403: reason 403/);
  } finally { r.stop(); }
});

test("a long answer from the push service never pushes the deck's verdict off the log line", async () => {
  const r = await rig([quiet]);
  try {
    await r.subscribe(); await r.subscribe();
    const answers = [410, 503];
    r.push.reply = () => answers.shift() ?? 201;
    r.push.why = () => "long ".repeat(80);
    await r.set([{ ...asking, title: "A very long task title ".repeat(8) }]);
    await sleep(60);
    assert.match(r.log().join("\n"), /replied 410, this browser's subscription is gone and forgotten: long/);
    assert.match(r.log().join("\n"), /replied 503, trying again in 0 s: long/);
  } finally { r.stop(); }
});

test("a push that cannot be delivered is tried again, a few times only, and not after the task stopped waiting", async () => {
  const r = await rig([quiet]);
  try {
    await r.subscribe();
    const answers: (number | "offline")[] = ["offline", 503, 201];
    r.push.reply = () => answers.shift() ?? 201;
    await r.set([asking]);
    await until(() => r.push.sent.length === 3);
    await sleep(100);
    assert.equal(r.push.sent.length, 3, "delivered: no more");
    await r.set([quiet]); await r.set([quiet], 90_000);
    r.push.reply = () => "offline";
    await r.set([asking]);
    await until(() => r.push.sent.length === 6);
    await sleep(150);
    assert.equal(r.push.sent.length, 6, "first try and two more");
    await r.set([quiet]); await r.set([quiet], 90_000);
    await r.set([asking]);
    await r.set([quiet]);
    const n = r.push.sent.length;
    await sleep(150);
    assert.equal(r.push.sent.length, n, "answered meanwhile");
  } finally { r.stop(); }
});

test("only a holder of the page's key can subscribe, and only a real push service address with real keys", async () => {
  const r = await rig([quiet]);
  try {
    const good = browserSub();
    assert.equal((await r.post("subscribe", { k: "wrong", sub: good.json })).status, 403);
    assert.equal((await r.post("subscribe", { sub: good.json })).status, 403);
    const k = r.key();
    for (const endpoint of ["http://updates.push.services.mozilla.com/x", "https://127.0.0.1/x", "https://evil.example/x", "https://push.services.mozilla.com.evil.example/x", "nonsense"])
      assert.equal((await r.post("subscribe", { k, sub: { ...good.json, endpoint } })).status, 400, endpoint);
    assert.equal((await r.post("subscribe", { k, sub: { ...good.json, keys: { ...good.json.keys, p256dh: "AAAA" } } })).status, 400);
    assert.equal((await r.post("subscribe", { k, sub: { ...good.json, keys: { ...good.json.keys, auth: "AAAA" } } })).status, 400);
    assert.equal((await r.post("subscribe", "not json")).status, 400);
    assert.equal((await r.post("subscribe", "x".repeat(100_000))).status, 413);
    await r.set([asking]);
    assert.equal(r.push.sent.length, 0);
  } finally { r.stop(); }
});

test("the opt-in page and its worker are served for the deck's origin only", async () => {
  const r = await rig([quiet]);
  try {
    const page = await fetch(`${r.base}/_push/`), sw = await fetch(`${r.base}/_push/sw.js`);
    assert.match(page.headers.get("content-type")!, /^text\/html/);
    assert.match(sw.headers.get("content-type")!, /^text\/javascript/);
    for (const res of [page, sw, await fetch(`${r.base}/_push/subscribe`, { method: "OPTIONS" }), await r.post("subscribe", {})]) {
      assert.equal(res.headers.get("access-control-allow-origin"), null);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.equal((await fetch(`${r.base}/_push/keys.json`)).status, 404);
    assert.ok(!(await (await fetch(`${r.base}/_push/`)).text()).includes(r.key()), "the page holds no secret: the key travels in the #fragment");
  } finally { r.stop(); }
});

test("the project page offers Notify me only with push set up and the web server on, at its address or the https one set for it", async () => {
  for (const o of [{ cfg: { readMarksPort: 0 } }, { noPush: true }]) {
    const off = await rig([WAITING], o);
    try { assert.doesNotMatch(off.page(), /id="fd-notify"|\/_push\//); } finally { off.stop(); }
  }
  const on = await rig([WAITING]);
  try {
    assert.match(on.page(), /<button[^>]*id="fd-notify"[^>]*data-lavish-action[^>]*>Notify me<\/button>/);
    assert.ok(on.page().includes(`${on.base}/_push/#k=${on.key()}`));
  } finally { on.stop(); }
  const tls = await rig([WAITING], { cfg: { notifyUrl: "https://box.example:8443" } });
  try { assert.ok(tls.page().includes(`https://box.example:8443/_push/#k=${tls.key()}`)); } finally { tls.stop(); }
  assert.equal(resolveConfig({ notifyUrl: " https://box.example:8443/ " }, {}).notifyUrl, "https://box.example:8443");
  for (const bad of ["", "box.example:8443", "box.example", "ftp://box.example"]) assert.equal(resolveConfig({ notifyUrl: bad }, {}).notifyUrl, undefined, bad);
});

test("page side: the button opens the opt-in page in a tab", () => {
  const opened: unknown[][] = [];
  const button: any = { addEventListener(_: string, fn: () => void) { this.onclick = fn; } };
  vm.runInContext(notifyPageSide("http://box.example:4398/_push/#k=abc"), vm.createContext({ window: { open: (...a: unknown[]) => opened.push(a) }, document: { getElementById: (id: string) => (id === "fd-notify" ? button : null) } }));
  assert.equal(opened.length, 0);
  button.onclick();
  assert.deepEqual(plain(opened), [["http://box.example:4398/_push/#k=abc", "_blank"]]);
});

/** The opt-in tab: the served page's script in a stand-in browser, talking to the real deck. */
type Opts = { secure?: boolean; permission?: string; answer?: string; push?: boolean; existing?: { key: Buffer }; failSubscribe?: string; sub?: Sub };
async function openTab(r: { base: string; key: () => string }, o: Opts = {}, hash = `#k=${r.key()}`) {
  const html = await (await fetch(`${r.base}/_push/`)).text();
  const src = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const els = new Map<string, any>();
  const el = (id: string) => { if (!els.has(id)) els.set(id, { hidden: new RegExp(`id="${id}"[^>]*\\shidden`).test(html), textContent: "", onclick: null }); return els.get(id); };
  const sub = o.sub ?? browserSub(), did: string[] = [];
  let pending = 0;
  class Notification {
    static permission = o.permission ?? "default";
    static async requestPermission() { did.push("asked"); return (Notification.permission = o.answer ?? "granted"); }
  }
  const made = (key: Uint8Array) => ({ options: { applicationServerKey: new Uint8Array(key).buffer }, toJSON: () => sub.json, unsubscribe: async () => { did.push("unsubscribed"); current = null; return true; } });
  let current: any = o.existing ? made(o.existing.key) : null;
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async (opts: any) => { if (o.failSubscribe) throw Object.assign(new Error(o.failSubscribe), { name: "AbortError" }); assert.equal(opts.userVisibleOnly, true); did.push(`subscribed ${Buffer.from(opts.applicationServerKey).toString("base64url")}`); return (current = made(opts.applicationServerKey)); },
  };
  const serviceWorker = { register: async (u: string) => { did.push(`registered ${u}`); return { pushManager }; }, ready: Promise.resolve() };
  const window: any = { isSecureContext: o.secure ?? true, ...(o.push === false ? {} : { PushManager: class {} }), Notification };
  vm.runInContext(src, vm.createContext({
    window, Notification, navigator: o.push === false ? {} : { serviceWorker }, document: { getElementById: el }, location: { hash, hostname: "box.example" }, atob, setTimeout: () => 0, clearTimeout: () => {}, Uint8Array,
    fetch: async (u: string, init?: RequestInit) => { pending++; try { return await fetch(new URL(u, `${r.base}/_push/`), init); } finally { pending--; } },
  }));
  const settled = async (ok: () => boolean = () => true) => { await sleep(20); await until(() => pending === 0 && ok()); };
  return { el, did, sub, settled, msg: () => el("msg").textContent as string };
}
const deckKey = async (r: { base: string }) => /"(B[A-Za-z0-9_-]{86})"/.exec(await (await fetch(`${r.base}/_push/`)).text())![1];

test("opt-in: nothing is asked until the button is pressed; then the tab subscribes, tells the deck, and can be closed", async () => {
  const r = await rig([quiet]);
  try {
    const t = await openTab(r);
    await t.settled();
    assert.deepEqual(t.did, []);
    assert.equal(t.el("allow").hidden, false);
    await t.el("allow").onclick();
    await t.settled(() => /close this tab/i.test(t.msg()));
    assert.deepEqual(t.did, ["asked", "registered sw.js", `subscribed ${await deckKey(r)}`]);
    assert.equal(t.el("allow").hidden, true);
    await r.set([asking]);
    assert.deepEqual(titles(r, t.sub), ["Pick a queue library"], "pushed with the tab gone");
    assert.match(r.log().join("\n"), /page: open, secure=yes permission=default[\s\S]*page: Allow pressed, the browser answered granted[\s\S]*deck: browser [0-9a-f]{6} subscribed/);
  } finally { r.stop(); }
});

test("opt-in again: allowed already, it subscribes by itself; a subscription made with an old key is replaced", async () => {
  const r = await rig([quiet]);
  try {
    const key = Buffer.from(await deckKey(r), "base64url");
    const kept = await openTab(r, { permission: "granted", existing: { key } });
    await kept.settled(() => /close this tab/i.test(kept.msg()));
    assert.deepEqual(kept.did, ["registered sw.js"]);
    const old = await openTab(r, { permission: "granted", existing: { key: Buffer.alloc(65, 4) } });
    await old.settled(() => /close this tab/i.test(old.msg()));
    assert.deepEqual(old.did.map((d) => d.split(" ")[0]), ["registered", "unsubscribed", "subscribed"]);
  } finally { r.stop(); }
});

test("blocked, insecure, unsupported, out of date or no push service: the tab says what to do and the log says where it stopped", async () => {
  const r = await rig([quiet]);
  try {
    const denied = await openTab(r, { answer: "denied" });
    await denied.el("allow").onclick();
    await denied.settled();
    assert.match(denied.msg(), /blocked/i);
    const insecure = await openTab(r, { secure: false });
    await insecure.settled();
    assert.match(insecure.msg(), /dom\.securecontext\.allowlist.*box\.example/s);
    assert.equal(insecure.el("allow").hidden, true);
    const old = await openTab(r, { push: false });
    await old.settled();
    assert.match(old.msg(), /cannot receive/i);
    const stale = await openTab(r, { permission: "granted" }, "#k=old");
    await stale.settled(() => /Notify me/.test(stale.msg()));
    const noservice = await openTab(r, { permission: "granted", failSubscribe: "Error retrieving push subscription." });
    await noservice.settled(() => /Error retrieving/.test(noservice.msg()));
    assert.equal(denied.did.length + insecure.did.length + old.did.length, 1);
    await until(() => /page: failed: Error retrieving push subscription\./.test(r.log().join("\n")));
    assert.match(r.log().join("\n"), /page: open, secure=no/);
    assert.match(r.log().join("\n"), /answered denied/);
    assert.match(r.log().join("\n"), /refused an out-of-date key/);
  } finally { r.stop(); }
});

/** The service worker: the served script with the worker's globals. */
async function worker(r: { base: string }, o: { refuses?: string } = {}) {
  const src = await (await fetch(`${r.base}/_push/sw.js`)).text();
  const on: Record<string, (e: any) => void> = {}, shown: any[] = [], opened: string[] = [];
  const self = { addEventListener: (t: string, fn: any) => { on[t] = fn; }, skipWaiting: () => {},
    registration: { showNotification: async (title: string, options: any) => { if (o.refuses) throw new Error(o.refuses); shown.push({ title, options }); } } };
  vm.runInContext(src, vm.createContext({ self, clients: { openWindow: async (u: string) => { opened.push(u); } }, fetch: (u: string, init?: RequestInit) => fetch(new URL(u, `${r.base}/_push/sw.js`), init) }));
  const emit = async (type: string, e: Record<string, unknown>) => { const waits: Promise<unknown>[] = []; on[type]({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) }); assert.ok(waits.length, "the browser may stop the worker unless it is told to wait"); await Promise.all(waits); };
  return { shown, opened, emit };
}

test("the worker shows the notification, a click opens the project page, and the deck's log records both", async () => {
  const r = await rig([quiet]);
  try {
    const b = await r.subscribe();
    await r.set([asking]);
    const message = r.push.inbox(b)[0];
    const w = await worker(r);
    await w.emit("push", { data: { json: () => message } });
    assert.deepEqual(plain(w.shown.map((n) => [n.title, n.options.body, n.options.tag])), [["Pick a queue library", "BullMQ or pg-boss?", "fm:demo:pick"]]);
    let closed = false;
    await w.emit("notificationclick", { notification: { data: w.shown[0].options.data, close: () => { closed = true; } } });
    assert.deepEqual([closed, w.opened], [true, ["http://127.0.0.1:1/session/abc"]]);
    assert.match(r.log().join("\n"), /deck: sent demo\/pick "Pick a queue library" to browser ([0-9a-f]{6}); push service replied 201[\s\S]*worker \1: received demo\/pick[\s\S]*worker \1: the browser says it showed demo\/pick[\s\S]*worker \1: clicked demo\/pick/);
    assert.ok(!r.log().join("\n").includes(r.key()) && !r.log().join("\n").includes(b.endpoint), "no keys or addresses in the log");
  } finally { r.stop(); }
});

test("the worker still shows something for an empty message, and reports a browser that cannot show it", async () => {
  const r = await rig([quiet]);
  try {
    const b = await r.subscribe();
    const w = await worker(r);
    await w.emit("push", { data: null });
    assert.equal(w.shown.length, 1);
    await r.set([asking]);
    const bad = await worker(r, { refuses: "No permission" });
    await bad.emit("push", { data: { json: () => r.push.inbox(b)[0] } });
    assert.match(r.log().join("\n"), /could not show demo\/pick: No permission/);
  } finally { r.stop(); }
});

test("the log takes only known reports from someone with the key or a message, one line each, and stays small", async () => {
  const r = await rig([quiet]);
  try {
    assert.equal((await r.post("report", { k: "wrong", e: "open", d: "x" })).status, 403);
    assert.equal((await r.post("report", { m: "made-up", e: "shown" })).status, 403);
    assert.equal((await r.post("report", { k: r.key(), e: "made-up" })).status, 400);
    assert.equal((await r.post("report", { k: r.key(), e: "error", d: "a\ndeck: forged\r\u0007" + "y".repeat(500) })).status, 204);
    const lines = r.log();
    assert.equal(lines.filter((l) => l.startsWith("deck: forged")).length, 0);
    assert.ok(lines.at(-1)!.length < 300);
    writeFileSync(join(r.pushDir, "push.log"), "2026-11-28 00:00:00 old line\n".repeat(20_000));
    await r.post("report", { k: r.key(), e: "error", d: "newest" });
    assert.ok(statSync(join(r.pushDir, "push.log")).size < 150_000);
    assert.match(r.log().at(-1)!, /newest/);
  } finally { r.stop(); }
});
