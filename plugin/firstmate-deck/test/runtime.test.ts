process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deck } from "../server/runtime.ts";
import { readInbox, readPageJson } from "../server/store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(10); }
}

type World = { status: string; sendFails: boolean; sent: string[] };
function rig(fleet: object) {
  const root = mkdtempSync(join(tmpdir(), "deck-rt-"));
  const pdir = join(root, "state", "projects", "demo");
  mkdirSync(join(pdir, "sections"), { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo", sections: ["endpoints"] }));
  writeFileSync(join(pdir, "sections", "endpoints.md"), "- GET /x\n");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify(fleet));
  const world: World = { status: "running", sendFails: false, sent: [] };
  const exec = async (args: string[]) => {
    if (args[0] === "status") return JSON.stringify({ listen: "127.0.0.1:1", serverId: "srv" });
    if (args[0] === "ls" && args.includes("--label")) return JSON.stringify([{ id: "fm-1", status: "idle" }]);
    if (args[0] === "ls") return JSON.stringify([{ id: "ag-1", status: world.status }]);
    if (args[0] === "inspect") return JSON.stringify({ CreatedAt: "2026-10-21T10:00:00Z", UpdatedAt: "2026-10-21T10:05:00Z", Model: "m" });
    if (args[0] === "logs") return "[Shell] ls -la\n";
    if (args[0] === "send") {
      if (world.sendFails) throw new Error("daemon down");
      world.sent.push(readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8"));
      return "";
    }
    throw new Error("unexpected " + args.join(" "));
  };
  const rows: any[] = [];
  const deck = new Deck({
    exec, batchMs: 30, readConfig: async () => ({ root, firstmateLabel: "firstmate=true" }),
    timelineRow: async (agentId, id, data) => { rows.push({ agentId, id, data }); },
  });
  return { root, pdir, world, deck, rows, page: join(pdir, "page.html"), live: join(pdir, "page.live.js") };
}
const FLEET = { tasks: [{ id: "t1", intent: "do it", status: "running", project: "demo", agentId: "ag-1", shape: "ship" }] };

test("page.html is rewritten only when the signature moves; live.js on every render", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  await r.deck.render("demo");
  assert.ok(existsSync(r.page) && existsSync(r.live));
  assert.match(readFileSync(r.page, "utf8"), /Demo/);

  writeFileSync(r.page, "MARKER");
  writeFileSync(r.live, "MARKER");
  await r.deck.render("demo");
  assert.equal(readFileSync(r.page, "utf8"), "MARKER", "same signature: html untouched");
  assert.notEqual(readFileSync(r.live, "utf8"), "MARKER", "live.js refreshed");

  r.world.status = "idle"; // agent status is part of the signature
  r.deck.onAgentEvent("ag-1");
  await r.deck.render("demo");
  assert.notEqual(readFileSync(r.page, "utf8"), "MARKER", "agent status changed: html rewritten");

  writeFileSync(r.page, "MARKER");
  writeFileSync(join(r.root, "state", "fleet.json"), JSON.stringify({ tasks: [{ ...FLEET.tasks[0], status: "done" }] }));
  await r.deck.render("demo");
  assert.notEqual(readFileSync(r.page, "utf8"), "MARKER", "fleet change: html rewritten");
  r.deck.stop();
});

test("a fleet.json change re-renders the page within a second (watcher + debounce)", async () => {
  const r = rig({ tasks: [] });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.ok(!/Fresh task/.test(readFileSync(r.live, "utf8")));
  const t0 = Date.now();
  writeFileSync(join(r.root, "state", "fleet.json"), JSON.stringify({ tasks: [{ id: "n1", intent: "x", title: "Fresh task", status: "queued", project: "demo" }] }));
  await until(() => /Fresh task/.test(readFileSync(r.live, "utf8")), 1500);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  r.deck.stop();
});

test("repeated atomic replaces of fleet.json (temp file + rename, like bin/fleet) each re-render within a second", async () => {
  const r = rig({ tasks: [] });
  await r.deck.configure();
  await r.deck.render("demo");
  const fleet = join(r.root, "state", "fleet.json");
  for (let i = 1; i <= 4; i++) {
    const t0 = Date.now();
    writeFileSync(fleet + ".tmpXYZ", JSON.stringify({ tasks: [{ id: "n1", intent: "x", title: `Round ${i}`, status: "queued", project: "demo" }] }));
    renameSync(fleet + ".tmpXYZ", fleet);
    await until(() => readFileSync(r.live, "utf8").includes(`Round ${i}`), 1500);
    assert.ok(Date.now() - t0 < 1000, `round ${i} took ${Date.now() - t0} ms`);
  }
  r.deck.stop();
});

test("a task card appearing later (new tasks/<id>/ dir) is picked up", async () => {
  const r = rig({ tasks: [{ id: "n1", intent: "x", title: "Card task", status: "queued", project: "demo" }] });
  await r.deck.configure();
  await r.deck.render("demo");
  mkdirSync(join(r.root, "state", "tasks", "n1"), { recursive: true });
  await sleep(300); // the new directory gets its watch
  writeFileSync(join(r.root, "state", "tasks", "n1", "card.md"), "Card body from the first mate\n");
  await until(() => readFileSync(r.live, "utf8").includes("Card body from the first mate"), 1500);
  r.deck.stop();
});

test("comments hit the inbox first, then reach the first mate in the exact format, then the timeline", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  r.world.sendFails = true;
  r.deck.ingest("demo", [{ prompt: "Is this right?", selector: "#t-t1 > span" }, { prompt: "More detail", selector: "section#endpoints > p" }]);
  const inbox = readInbox(join(r.pdir, "inbox.jsonl"));
  assert.equal(inbox.length, 2, "on disk before any delivery attempt");
  assert.deepEqual(inbox.map((e) => [e.target, e.delivered]), [["t-t1", false], ["endpoints", false]]);

  await until(() => readPageJson(join(r.pdir, "page.json")).banner != null);
  assert.match(readPageJson(join(r.pdir, "page.json")).banner!, /First mate unreachable, 2 comments queued/);
  const live = (await r.deck.summary("demo")).projects[0];
  assert.equal(live.undelivered, 2);
  assert.match(live.banner ?? "", /unreachable/);

  r.world.sendFails = false;
  await r.deck.flushNow("demo");
  assert.equal(r.world.sent.length, 1);
  assert.equal(r.world.sent[0], '## Page comments · demo\n- [t-t1] "Is this right?"\n- [endpoints] "More detail"\nReply with: bin/page reply demo "<your reply>"');
  assert.deepEqual(readInbox(join(r.pdir, "inbox.jsonl")).map((e) => e.delivered), [true, true]);
  const pj = readPageJson(join(r.pdir, "page.json"));
  assert.equal(pj.undelivered, 0);
  assert.ok(pj.lastDelivery);
  assert.equal(pj.banner ?? null, null);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].agentId, "fm-1");
  assert.equal(r.rows[0].id, "pc-" + inbox[0].id);
  assert.equal(r.rows[0].data.replied, false);
  assert.deepEqual(r.rows[0].data.comments, [{ target: "t-t1", text: "Is this right?" }, { target: "endpoints", text: "More detail" }]);
  r.deck.stop();
});

test("undelivered inbox entries are re-sent when the plugin starts", async () => {
  const r = rig(FLEET);
  writeFileSync(join(r.pdir, "inbox.jsonl"), JSON.stringify({ id: "c-old", at: "2026-10-21T09:00:00Z", project: "demo", target: "page", text: "left over", prompt: {}, delivered: false, answered: false }) + "\n");
  await r.deck.configure();
  await until(() => r.world.sent.length === 1);
  assert.match(r.world.sent[0], /"left over"/);
  await until(() => readInbox(join(r.pdir, "inbox.jsonl"))[0].delivered);
  r.deck.stop();
});

test("summary follows the contract shape", async () => {
  const r = rig({ tasks: [
    { id: "a", intent: "ask", status: "needs-captain", project: "demo", asks: [{ text: "Which?", since: "2026-10-20" }] },
    { id: "b", intent: "run", status: "running", project: "demo", agentId: "ag-1" },
    { id: "f", intent: "replied", status: "needs-captain", project: "demo", asks: [{ text: "Options?", since: "2026-10-21T09:00:00Z" }] },
    { id: "c", intent: "later", status: "queued", project: "demo" },
    { id: "d", intent: "hold", status: "parked", project: "demo" },
    { id: "e", intent: "fin", status: "done", project: "demo" },
  ] });
  writeFileSync(join(r.pdir, "inbox.jsonl"), JSON.stringify({ id: "c1", at: "2026-10-21T09:05:00Z", project: "demo", target: "t-f", text: "more detail" }) + "\n");
  await r.deck.configure();
  await r.deck.render("demo");
  const s = await r.deck.summary();
  assert.equal(s.firstmateAgentId, "fm-1");
  const p = s.projects[0];
  assert.deepEqual(p.counts, { needsYou: 1, running: 1, next: 1, parked: 1, done: 1 });
  assert.deepEqual(p.needsYou, [{ taskId: "a", taskTitle: "ask", text: "Which?", since: "2026-10-20" }]);
  assert.equal(p.running[0].agentStatus, "running");
  assert.equal(p.session, "unknown");
  assert.equal(p.pageUrl, null);
  r.deck.stop();
});

/** The live block html out of page.live.js (a JSON string literal inside a function call). */
const liveHtml = (f: string): string => {
  const m = /__fdLive\((".*")\);\n$/s.exec(readFileSync(f, "utf8"));
  return m ? JSON.parse(m[1]) : "";
};

test("a polled comment renders on the page at once, then 'first mate has it' once delivered", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  await r.deck.render("demo");
  r.deck.ingest("demo", [{ prompt: "please look at this", selector: "#t-t1" }]);
  const t0 = Date.now();
  await until(() => /please look at this/.test(liveHtml(r.live)), 1000);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  await until(() => /first mate has it/.test(liveHtml(r.live)), 1500);
  assert.equal(r.world.sent.length, 1);
  r.deck.stop();
});

test("bin/page reply (inbox.jsonl rewritten from outside) re-renders with 'answered'", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  await r.deck.render("demo");
  r.deck.ingest("demo", [{ prompt: "ping", selector: "#t-t1" }]);
  await until(() => /first mate has it/.test(liveHtml(r.live)), 1500);
  const f = join(r.pdir, "inbox.jsonl");
  const rows = readFileSync(f, "utf8").trim().split("\n").map((l) => ({ ...JSON.parse(l), answered: true }));
  writeFileSync(join(r.pdir, ".inbox.jsonl.tmp"), rows.map((x) => JSON.stringify(x) + "\n").join(""));
  renameSync(join(r.pdir, ".inbox.jsonl.tmp"), f);
  const t0 = Date.now();
  await until(() => /class="st st-answered">answered/.test(liveHtml(r.live)), 1000);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  r.deck.stop();
});

test("an ask-choice prompt is stored with its choice and shows 'You picked' immediately; the message carries it", async () => {
  const r = rig({ tasks: [{ id: "t1", intent: "x", title: "Pick one", status: "needs-captain", project: "demo", asks: [{ text: "Which design?", since: "2026-10-21T09:00:00Z", options: ["A card", "B console"] }] }] });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /class="opt"/);
  const data = JSON.stringify({ kind: "ask-choice", task: "t1", ask: 1, option: "B console" }, null, 2);
  r.deck.ingest("demo", [{ prompt: `Picked: B console\n\nContext data:\n${data}`, selector: "article#t-t1" }]);
  await until(() => /You picked <b>B console<\/b> · the first mate is applying it/.test(liveHtml(r.live)), 1000);
  const [e] = readInbox(join(r.pdir, "inbox.jsonl"));
  assert.equal(e.target, "t-t1");
  assert.deepEqual(e.choice, { task: "t1", ask: 1, option: "B console", askText: "Which design?" });
  await until(() => r.world.sent.length === 1, 1500);
  assert.match(r.world.sent[0], /- \[t-t1\] picked option "B console" for ask 1 \("Which design\?"\)/);
  assert.match(r.world.sent[0], /Apply with: bin\/fleet answer t1 1, then act on it\.$/);
  const g = liveHtml(r.live);
  assert.ok(g.indexOf("With the first mate") > 0 && !/Needs you/.test(g));
  r.deck.stop();
});
