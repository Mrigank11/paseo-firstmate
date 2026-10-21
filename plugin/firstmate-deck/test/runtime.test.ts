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
    { id: "c", intent: "later", status: "queued", project: "demo" },
    { id: "d", intent: "hold", status: "parked", project: "demo" },
    { id: "e", intent: "fin", status: "done", project: "demo" },
  ] });
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
