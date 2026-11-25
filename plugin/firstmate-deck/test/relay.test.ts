import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Relay, formatMessage, newEntries, BATCH_MS, RETRY_EVERY_MS, RETRY_MS } from "../server/relay.ts";
import type { InboxEntry } from "../server/store.ts";

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function rig(opts: { failTimes?: number } = {}) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const sent: { project: string; msg: string; at: number }[] = [];
  const delivered: string[][] = [];
  const queue: [number, boolean][] = [];
  const rows: string[] = [];
  let fails = opts.failTimes ?? 0;
  let clock = 0;
  const relay = new Relay({
    send: async (project, msg) => {
      if (fails > 0) { fails--; throw new Error("first mate down"); }
      sent.push({ project, msg, at: clock });
      return "fm-1";
    },
    markDelivered: (_p, ids) => { delivered.push(ids); },
    onQueue: (_p, n, failing) => { queue.push([n, failing]); },
    afterSend: async (_p, entries) => { rows.push("pc-" + entries[0].id); },
  });
  const tick = async (ms: number) => { clock += ms; mock.timers.tick(ms); await flush(); };
  return { relay, sent, delivered, queue, rows, tick };
}

const mk = (project: string, ...texts: string[]): InboxEntry[] =>
  newEntries(project, texts.map((t) => ({ prompt: t, selector: "body" })), {});

test("message format is exact: id, target, task title and open asks on every line", () => {
  const info: Record<string, { title: string; asks: { id: string; text: string }[] }> = {
    "t-pick-db": { title: "Choose the database", asks: [{ id: "a1", text: "Postgres or SQLite?" }, { id: "a2", text: "Add the DATABASE_URL flag?" }] },
  };
  const describe = (t: string) => info[t.replace(/#a\d+$/, "")];
  assert.equal(
    formatMessage("deck", [
      { id: "c-abc123", target: "t-pick-db", text: "Is this right?" },
      { id: "c-def456", target: "t-pick-db#a2", text: "which env?\nstaging?" },
      { id: "c-ghi789", target: "endpoints", text: "two\nlines" },
      { id: "c-jkl000", target: "t-gone", text: "no such task" },
    ], describe),
    [
      "## Page comments · deck",
      '- [t-pick-db · "Choose the database" · ask a1: "Postgres or SQLite?" · ask a2: "Add the DATABASE_URL flag?"] (c-abc123) "Is this right?"',
      '- [t-pick-db#a2 · "Choose the database" · ask a2: "Add the DATABASE_URL flag?"] (c-def456) "which env? staging?"',
      '- [endpoints] (c-ghi789) "two lines"',
      '- [t-gone] (c-jkl000) "no such task"',
      'Reply with: bin/page reply deck "<your reply>"',
    ].join("\n"),
  );
  // without a describer or ids the line degrades to the bare target
  assert.equal(formatMessage("deck", [{ target: "page", text: "hi" }]), '## Page comments · deck\n- [page] "hi"\nReply with: bin/page reply deck "<your reply>"');
});

test("newEntries: stable shape, target from the selector", () => {
  const [e] = newEntries("p", [{ prompt: "hi", selector: "#t-x > p", tag: "p", text: "el" }], { tasks: ["x"] });
  assert.match(e.id, /^c-/);
  assert.equal(e.target, "t-x");
  assert.equal(e.text, "hi");
  assert.deepEqual([e.delivered, e.answered, e.project], [false, false, "p"]);
  assert.equal((e.prompt as any).text, "el");
});

test("batches arriving within the batch window become one message", async () => {
  const r = rig();
  r.relay.enqueue("p", mk("p", "one"));
  await r.tick(BATCH_MS - 100);
  r.relay.enqueue("p", mk("p", "two", "three"));
  await r.tick(50);
  assert.equal(r.sent.length, 0, "window not over yet");
  await r.tick(100);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].msg, /\[page\] \(c-[^)]+\) "one"\n- \[page\] \(c-[^)]+\) "two"\n- \[page\] \(c-[^)]+\) "three"/);
  assert.equal(r.delivered.length, 1);
  assert.equal(r.delivered[0].length, 3);
  assert.equal(r.rows.length, 1);
  mock.timers.reset();
});

test("a send failure keeps entries queued and retries at 2 s, 10 s, 30 s, then every 60 s", async () => {
  const r = rig({ failTimes: 5 });
  r.relay.enqueue("p", mk("p", "x"));
  await r.tick(BATCH_MS); // attempt 1 fails
  assert.equal(r.relay.queued("p"), 1);
  assert.deepEqual(r.queue.at(-1), [1, true]);
  await r.tick(RETRY_MS[0] - 1); assert.equal(r.sent.length, 0);
  await r.tick(1); // attempt 2 fails
  await r.tick(RETRY_MS[1]); // attempt 3 fails
  await r.tick(RETRY_MS[2]); // attempt 4 fails
  await r.tick(RETRY_EVERY_MS - 1); // attempt 5 not yet
  assert.equal(r.sent.length, 0);
  await r.tick(1); // attempt 5 fails
  await r.tick(RETRY_EVERY_MS); // attempt 6 succeeds
  assert.equal(r.sent.length, 1);
  assert.equal(r.relay.queued("p"), 0);
  assert.deepEqual(r.queue.at(-1), [0, false], "banner cleared on success");
  assert.equal(r.delivered.length, 1);
  mock.timers.reset();
});

test("comments arriving during a retry wait ride along with the retry", async () => {
  const r = rig({ failTimes: 1 });
  r.relay.enqueue("p", mk("p", "first"));
  await r.tick(BATCH_MS);
  r.relay.enqueue("p", mk("p", "second"));
  await r.tick(500);
  assert.equal(r.sent.length, 0, "no early send while waiting out the retry");
  await r.tick(RETRY_MS[0]);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].msg, /"first"\n- \[page\] \(c-[^)]+\) "second"/);
  mock.timers.reset();
});

test("enqueue is idempotent per entry id (restart replay)", async () => {
  const r = rig();
  const es = mk("p", "once");
  r.relay.enqueue("p", es);
  r.relay.enqueue("p", es);
  await r.tick(BATCH_MS);
  assert.equal(r.sent[0].msg.match(/once/g)!.length, 1);
  mock.timers.reset();
});

test("projects are independent", async () => {
  const r = rig();
  r.relay.enqueue("a", mk("a", "for a"));
  r.relay.enqueue("b", mk("b", "for b"));
  await r.tick(BATCH_MS);
  assert.deepEqual(r.sent.map((s) => s.project).sort(), ["a", "b"]);
  mock.timers.reset();
});

test("a failing timeline row does not undo the delivery", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const delivered: string[][] = [];
  const relay = new Relay({
    send: async () => "fm", markDelivered: (_p, ids) => delivered.push(ids), onQueue: () => {},
    afterSend: async () => { throw new Error("no handle"); },
  });
  relay.enqueue("p", mk("p", "x"));
  mock.timers.tick(BATCH_MS);
  await flush();
  assert.equal(delivered.length, 1);
  assert.equal(relay.queued("p"), 0);
  mock.timers.reset();
});

test("the line lists the task's open canvas asks; a canvas-ask target names only its own; a bare 'page' quotes the clicked text", () => {
  const info = { title: "Explainer", asks: [], canvasAsks: [{ id: "env1", text: "Which change?" }, { id: "env2", text: "Ship it?" }] };
  const describe = () => info;
  const both = formatMessage("p", [{ id: "c-1", target: "t-x", text: "hm" }], describe);
  assert.match(both, /\[t-x · "Explainer" · canvas ask env1: "Which change\?" · canvas ask env2: "Ship it\?"\] \(c-1\) "hm"/);
  const one = formatMessage("p", [{ id: "c-2", target: "t-x#c-env2", text: "hm" }], describe);
  assert.match(one, /canvas ask env2: "Ship it\?"\]/);
  assert.ok(!one.includes("env1"));
  const quote = formatMessage("p", [
    { id: "c-3", target: "page", text: "close this", prompt: { prompt: "close this", selector: "div > p", text: "Option   B\nonly" } },
    { id: "c-4", target: "page", text: "hi", prompt: { prompt: "hi", selector: "body", text: "everything" } },
    { id: "c-5", target: "page", text: "typed", prompt: { prompt: "typed" } },
  ]);
  assert.match(quote, /- \[page · on "Option B only"\] \(c-3\) "close this"/);
  assert.match(quote, /- \[page\] \(c-4\) "hi"/);
  assert.match(quote, /- \[page\] \(c-5\) "typed"/);
});

test("tree: a comment on a task under a second mate's group goes to that second mate; the rest still go to the first mate", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const toFm: string[] = [];
  const toMate: { to: string; msg: string }[] = [];
  const delivered: string[][] = [];
  const after: [string, string[]][] = [];
  const relay = new Relay({
    send: async (_p, msg) => { toFm.push(msg); return "fm"; },
    sendTo: async (to, msg) => { toMate.push({ to, msg }); },
    route: async (_p, e) => (e.target === "t-c1" || e.target === "t-g" ? "sm" : null),
    markDelivered: (_p, ids) => delivered.push(ids), onQueue: () => {},
    afterSend: async (_p, entries, id) => { after.push([id, entries.map((e) => e.id)]); },
  });
  const a = mk("p", "inside the group")[0]; a.target = "t-c1"; a.id = "c-a";
  const b = mk("p", "elsewhere")[0]; b.target = "t-other"; b.id = "c-b";
  const g = mk("p", "on the group card")[0]; g.target = "t-g"; g.id = "c-g";
  relay.enqueue("p", [a, b, g]);
  mock.timers.tick(BATCH_MS);
  await flush();
  assert.equal(toMate.length, 1);
  assert.equal(toMate[0].to, "sm");
  assert.match(toMate[0].msg, /inside the group/);
  assert.match(toMate[0].msg, /on the group card/);
  assert.doesNotMatch(toMate[0].msg, /elsewhere/);
  assert.equal(toFm.length, 1);
  assert.match(toFm[0], /elsewhere/);
  assert.doesNotMatch(toFm[0], /inside the group/);
  assert.deepEqual(delivered.flat().sort(), ["c-a", "c-b", "c-g"]);
  assert.deepEqual(after.map(([id]) => id).sort(), ["fm", "sm"]);
  assert.equal(relay.queued("p"), 0);
  mock.timers.reset();
});

test("tree: a second mate that cannot be reached keeps only its own comments queued; the first mate's are delivered", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const toFm: string[] = [];
  const delivered: string[][] = [];
  const relay = new Relay({
    send: async (_p, msg) => { toFm.push(msg); return "fm"; },
    sendTo: async () => { throw new Error("second mate down"); },
    route: async (_p, e) => (e.target === "t-c1" ? "sm" : null),
    markDelivered: (_p, ids) => delivered.push(ids), onQueue: () => {},
  });
  const a = mk("p", "for the mate")[0]; a.target = "t-c1"; a.id = "c-a";
  const b = mk("p", "for the first mate")[0]; b.target = "t-x"; b.id = "c-b";
  relay.enqueue("p", [a, b]);
  mock.timers.tick(BATCH_MS);
  await flush();
  assert.deepEqual(delivered.flat(), ["c-b"]);
  assert.equal(relay.queued("p"), 1);
  mock.timers.reset();
});
