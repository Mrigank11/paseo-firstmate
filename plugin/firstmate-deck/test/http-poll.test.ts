import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpPoll, httpDoc, PollSource, HTTP_MARK } from "../server/http-poll.ts";
import { PagePoller, type PollRun } from "../server/lavish.ts";
import { classifyPoll } from "../server/toon.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;
/** A fake Lavish: `/api/poll` runs the scripted handler; every request and every early connection close is recorded. */
async function fakeLavish(handler: Handler) {
  const seen: string[] = [];
  let n = 0;
  let closed = 0;
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.on("close", () => { if (!res.writableEnded) closed++; });
    handler(req, res, n++);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  return { port, seen, closedEarly: () => closed, stop: () => { server.closeAllConnections(); server.close(); } };
}
const page = (() => { const d = mkdtempSync(join(tmpdir(), "deck-http-")); const f = join(d, "p.html"); writeFileSync(f, "<p>x"); return f; })();
const ac = () => new AbortController();
const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

test("a comment arrives as the same document the CLI would print, and classifies as feedback", async () => {
  const lv = await fakeLavish((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write(" "); res.write(" "); res.end(JSON.stringify({ status: "feedback", prompts: [{ uid: "", prompt: "hi", selector: "#a", tag: "p", text: "t" }], dom_snapshot: "", delivery_seq: 3 })); });
  try {
    const r = await httpPoll(page, { port: lv.port, signal: ac().signal });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.startsWith(HTTP_MARK));
    const o = classifyPoll(JSON.parse(r.stdout.slice(HTTP_MARK.length)));
    assert.equal(o.kind, "feedback");
    assert.equal(o.prompts[0].prompt, "hi");
    assert.match(lv.seen[0], /^GET \/api\/poll\?file=/);
    assert.ok(decodeURIComponent(lv.seen[0]).includes(page), "asks for the canonical page path, no owner");
    assert.ok(!lv.seen[0].includes("owner"));
  } finally { lv.stop(); }
});

test("the other statuses map to the CLI's outcomes", () => {
  assert.equal(classifyPoll(httpDoc(200, { status: "browser_disconnected" })).kind, "disconnected");
  assert.equal(classifyPoll(httpDoc(200, { status: "ended", ended_by: "user" })).ended, true);
  const last = classifyPoll(httpDoc(200, { status: "feedback", session_ended: true, ended_by: "user", prompts: [{ prompt: "bye" }] }));
  assert.equal(last.ended, true);
  assert.equal(last.prompts.length, 1);
  assert.equal(classifyPoll(httpDoc(200, { status: "waiting" })).kind, "waiting");
  const la = classifyPoll(httpDoc(409, { status: "error", code: "LISTENER_ACTIVE", error: "x", holder: { label: "agent-listener", age_ms: 5 } }));
  assert.equal(la.kind, "listener-active");
  assert.equal(la.holder, "agent-listener");
  assert.equal(classifyPoll(httpDoc(404, { error: "session not found" })).kind, "error");
  assert.equal(classifyPoll(httpDoc(500, "boom")).kind, "error");
  assert.equal(classifyPoll(httpDoc(200, { status: "missing" })).kind, "error");
});

test("aborting a waiting poll closes the connection so Lavish frees the listener", async () => {
  const lv = await fakeLavish((_q, res) => { res.writeHead(200); res.write(" "); /* never answers */ });
  try {
    const a = ac();
    const p = httpPoll(page, { port: lv.port, signal: a.signal });
    await new Promise((r) => setTimeout(r, 100));
    a.abort();
    const r = await p;
    assert.equal(r.code, -1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lv.closedEarly(), 1);
  } finally { lv.stop(); }
});

test("nothing listening is a transport failure, not a throw", async () => {
  const lv = await fakeLavish(() => {});
  const port = lv.port;
  lv.stop();
  const r = await httpPoll(page, { port, signal: ac().signal });
  assert.equal(r.code, -1);
});

test("a page that cannot be resolved is a failure the caller can see", async () => {
  const r = await httpPoll("/nonexistent/dir/p.html", { port: 1, signal: ac().signal });
  assert.equal(r.code, -1);
});

// ---- PollSource: HTTP first, the CLI after repeated transport errors, HTTP again later ----

const okDoc = (s = "browser_disconnected"): PollRun => ({ code: 0, stdout: HTTP_MARK + JSON.stringify({ session: { status: s } }) });
const bad: PollRun = { code: -1, stdout: "" };

test("three transport errors in a row switch to the CLI; a good answer resets the count", async () => {
  const calls: string[] = [];
  let t = 0;
  const script = [bad, bad, okDoc(), bad, bad, bad];
  const src = new PollSource({
    http: async () => { calls.push("http"); return script.shift()!; },
    cli: async () => { calls.push("cli"); return { code: 0, stdout: "session:\n  status: browser_disconnected\n" }; },
    now: () => t, log: () => {},
  });
  for (let i = 0; i < 5; i++) await src.run();
  assert.deepEqual(calls, ["http", "http", "http", "http", "http"], "the good answer in the middle reset the count");
  assert.equal(src.mode, "http");
  await src.run(); // 3rd consecutive bad
  assert.equal(src.mode, "cli");
  assert.equal(calls.at(-1), "cli", "the failing poll is retried through the CLI at once");
});

test("while on the CLI it goes back to HTTP after the cooldown", async () => {
  let t = 0;
  const calls: string[] = [];
  const src = new PollSource({
    http: async () => { calls.push("http"); return calls.filter((c) => c === "http").length <= 3 ? bad : okDoc(); },
    cli: async () => { calls.push("cli"); return { code: 0, stdout: "session:\n  status: browser_disconnected\n" }; },
    now: () => t, log: () => {}, cooldownMs: 1000,
  });
  await src.run(); await src.run(); await src.run();
  assert.equal(src.mode, "cli");
  await src.run();
  assert.equal(calls.at(-1), "cli");
  t = 2000;
  await src.run();
  assert.equal(calls.at(-1), "http");
  assert.equal(src.mode, "http");
});

test("a LISTENER_ACTIVE answer is not a transport error and never triggers the fallback", async () => {
  const la: PollRun = { code: 0, stdout: HTTP_MARK + JSON.stringify(httpDoc(409, { code: "LISTENER_ACTIVE", error: "e", holder: { label: "x", age_ms: 1 } })) };
  const src = new PollSource({ http: async () => la, cli: async () => { throw new Error("no cli"); }, now: () => 0, log: () => {} });
  for (let i = 0; i < 6; i++) await src.run();
  assert.equal(src.mode, "http");
});

test("decode reads both formats", async () => {
  const src = new PollSource({ http: async () => okDoc(), cli: async () => okDoc(), now: () => 0, log: () => {} });
  assert.equal((await src.decode(HTTP_MARK + JSON.stringify({ a: 1 }))).a, 1);
  assert.equal((await src.decode("session:\n  status: ended\n")).session.status, "ended");
});

test("forced mode never uses the other path", async () => {
  const src = new PollSource({ http: async () => { throw new Error("no http"); }, cli: async () => ({ code: 0, stdout: "session:\n  status: browser_disconnected\n" }), now: () => 0, log: () => {}, force: "cli" });
  await src.run();
  assert.equal(src.mode, "cli");
});

// ---- end to end through the PagePoller loop against the fake server ----

test("the loop re-asks at once after a comment, and the comment is handed over exactly once", async () => {
  const bodies: unknown[] = [
    { status: "feedback", prompts: [{ prompt: "one" }] },
    { status: "feedback", prompts: [{ prompt: "two" }] },
  ];
  const lv = await fakeLavish((_q, res, n) => { if (bodies[n]) { res.writeHead(200); res.end(JSON.stringify(bodies[n])); } else { res.writeHead(200); res.write(" "); } });
  const got: string[] = [];
  const a = ac();
  const src = new PollSource({ http: () => httpPoll(page, { port: lv.port, signal: a.signal }), cli: async () => bad, now: Date.now, log: () => {} });
  const poller = new PagePoller({ run: () => src.run(), decode: (s) => src.decode(s), onBatch: (p) => { got.push(...p.map((x) => x.prompt)); }, onEnded: () => {}, sleep: async () => {} });
  poller.start();
  const t0 = Date.now();
  while (got.length < 2 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, ["one", "two"]);
  poller.stop(); a.abort();
  await poller.done;
  assert.equal(lv.seen.length, 3, "third request is the waiting one");
  lv.stop();
});
