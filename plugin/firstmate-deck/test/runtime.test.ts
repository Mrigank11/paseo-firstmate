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

type World = { status: string; sendFails: boolean; sent: string[]; labelled: object[]; all: object[] };
function rig(fleet: object) {
  const root = mkdtempSync(join(tmpdir(), "deck-rt-"));
  const pdir = join(root, "state", "projects", "demo");
  mkdirSync(join(pdir, "sections"), { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo", sections: ["endpoints"] }));
  writeFileSync(join(pdir, "sections", "endpoints.md"), "- GET /x\n");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify(fleet));
  const world: World = { status: "running", sendFails: false, sent: [], labelled: [{ id: "fm-1", status: "idle" }], all: [] };
  const exec = async (args: string[]) => {
    if (args[0] === "status") return JSON.stringify({ listen: "127.0.0.1:1", serverId: "srv" });
    if (args[0] === "ls" && args.includes("--label")) return JSON.stringify(world.labelled);
    if (args[0] === "ls" && args.includes("-g")) return JSON.stringify(world.all);
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
  const mkDeck = () => new Deck({
    exec, batchMs: 30, readConfig: async () => ({ root, firstmateLabel: "firstmate=true" }),
    timelineRow: async (agentId, id, data) => { rows.push({ agentId, id, data }); },
  });
  const deck = mkDeck();
  return { root, pdir, world, deck, mkDeck, rows, page: join(pdir, "page.html"), live: join(pdir, "page.live.js") };
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
  assert.equal(r.world.sent[0], [
    "## Page comments · demo",
    `- [t-t1 · "do it"] (${inbox[0].id}) "Is this right?"`,
    `- [endpoints] (${inbox[1].id}) "More detail"`,
    'Reply with: bin/page reply demo "<your reply>"',
  ].join("\n"));
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
  writeFileSync(join(r.pdir, "inbox.jsonl"), JSON.stringify({ id: "c1", at: "2026-10-21T09:05:00Z", project: "demo", target: "t-f#a1", text: "more detail" }) + "\n");
  await r.deck.configure();
  await r.deck.render("demo");
  const s = await r.deck.summary();
  assert.equal(s.firstmateAgentId, "fm-1");
  const p = s.projects[0];
  assert.deepEqual(p.counts, { needsYou: 1, withFirstMate: 1, running: 1, next: 1, parked: 1, done: 1 });
  assert.deepEqual(p.needsYou, [{ taskId: "a", taskTitle: "ask", text: "Which?", since: "2026-10-20" }]);
  assert.equal(p.running[0].agentStatus, "running");
  assert.equal(p.session, "unknown");
  assert.equal(p.pageUrl, null);
  r.deck.stop();
});

/** The live block html out of page.live.js (a JSON string literal inside a function call). */
const liveHtml = (f: string): string => {
  const m = /__fdLive\((.*)\);\n$/s.exec(readFileSync(f, "utf8")); // (html, isoTimestamp)
  return m ? JSON.parse(`[${m[1]}]`)[0] : "";
};

/** The ISO timestamp the page script compares with the browser clock. */
const liveStamp = (f: string): string => {
  const m = /__fdLive\((.*)\);\n$/s.exec(readFileSync(f, "utf8"));
  return m ? JSON.parse(`[${m[1]}]`)[1] : "";
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
  assert.equal(e.target, "t-t1#a1", "a click targets its ask");
  assert.deepEqual(e.choice, { task: "t1", ask: 1, option: "B console", askText: "Which design?" });
  await until(() => r.world.sent.length === 1, 1500);
  assert.match(r.world.sent[0], /- \[t-t1#a1 · "Pick one"\] \(c-[^)]+\) picked option "B console" for ask 1 \("Which design\?"\)/);
  assert.match(r.world.sent[0], /Apply with: bin\/fleet answer t1 1, then act on it\.$/);
  const g = liveHtml(r.live);
  assert.ok(g.indexOf("With the first mate") > 0 && !/Needs you/.test(g));
  r.deck.stop();
});

test("a comment on the ask itself moves it to 'With the first mate' at once; a comment on the card does not", async () => {
  const r = rig({ tasks: [{ id: "t1", intent: "x", title: "Pick one", status: "needs-captain", project: "demo", asks: [{ text: "Which design?", since: "2026-10-21T09:00:00Z" }] }] });
  await r.deck.configure();
  await r.deck.render("demo");
  r.deck.ingest("demo", [{ prompt: "why so slow?", selector: "article#t-t1 > div.tt" }]);
  await until(() => /why so slow/.test(liveHtml(r.live)), 1000);
  assert.ok(/Needs you/.test(liveHtml(r.live)) && !/With the first mate/.test(liveHtml(r.live)), "a card comment does not move the ask");
  r.deck.ingest("demo", [{ prompt: "show me both", selector: "article#t-t1 > div#a-t1-1 > div.ask" }]);
  await until(() => /With the first mate/.test(liveHtml(r.live)), 1000);
  assert.ok(!/Needs you/.test(liveHtml(r.live)));
  const s = (await r.deck.summary()).projects[0];
  assert.deepEqual([s.counts.needsYou, s.counts.withFirstMate, s.needsYou.length], [0, 1, 0]);
  r.deck.stop();
});

test("each page is stamped with the plugin's root and Lavish config, and the live payload with its production time", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  const pj = () => readPageJson(join(r.pdir, "page.json"));
  assert.equal(pj().pluginRoot, r.root);
  assert.ok("lavishPort" in pj() && "lavishStateDir" in pj());
  await r.deck.render("demo");
  assert.match(liveStamp(r.live), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/, "the payload carries an ISO production time");
  r.deck.stop();
});

test("no claim and no label: delivery fails, comments stay queued, the banner says to run bin/page claim", async () => {
  const r = rig(FLEET);
  r.world.labelled = [];
  await r.deck.configure();
  r.deck.ingest("demo", [{ prompt: "hello?", selector: "#t-t1" }]);
  await until(() => readPageJson(join(r.pdir, "page.json")).banner != null);
  assert.match(readPageJson(join(r.pdir, "page.json")).banner!, /^No first mate claimed this checkout: run bin\/page claim in the first mate's session \(1 comment queued\)$/);
  assert.equal(readInbox(join(r.pdir, "inbox.jsonl"))[0].delivered, false);
  assert.match((await r.deck.summary("demo")).projects[0].banner ?? "", /No first mate claimed/);
  assert.equal(r.world.sent.length, 0);
  // the first mate claims: the very next attempt goes to it
  writeFileSync(join(r.root, "state", "firstmate.json"), JSON.stringify({ agentId: "fm-claimed", claimedAt: "2026-10-21T10:00:00Z" }));
  r.world.all = [{ id: "fm-claimed", status: "idle" }];
  await r.deck.flushNow("demo");
  assert.equal(r.world.sent.length, 1);
  assert.equal(readInbox(join(r.pdir, "inbox.jsonl"))[0].delivered, true);
  r.deck.stop();
});

test("a root that does not exist is reported, not silently idle", async () => {
  const r = rig(FLEET);
  const deck = new Deck({ exec: async () => "[]", readConfig: async () => ({ root: join(r.root, "nope"), firstmateLabel: "firstmate=true" }) });
  await deck.configure();
  assert.match((await deck.summary()).problem ?? "", /does not exist/);
  deck.stop();
  const bare = mkdtempSync(join(tmpdir(), "deck-bare-"));
  const d2 = new Deck({ exec: async () => "[]", readConfig: async () => ({ root: bare, firstmateLabel: "firstmate=true" }) });
  await d2.configure();
  assert.match((await d2.summary()).problem ?? "", /no state\/ directory/);
  d2.stop();
  r.deck.stop();
});

test("configure() is single-flight: overlapping calls collapse into at most one extra run", async () => {
  const r = rig(FLEET);
  let reads = 0;
  const deck = new Deck({ exec: async () => "[]", readConfig: async () => { reads++; await sleep(20); return { root: r.root, firstmateLabel: "firstmate=true" }; } });
  await Promise.all([deck.configure(), deck.configure(), deck.configure(), deck.configure()]);
  assert.ok(reads <= 2, `read the config ${reads} times`);
  deck.stop();
  r.deck.stop();
});

test("timeline rows still awaiting a reply survive a plugin reload (kept in page.json)", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  r.deck.ingest("demo", [{ prompt: "ping", selector: "#t-t1" }]);
  await until(() => r.rows.length === 1, 1500);
  const rowId = r.rows[0].id;
  const pjp = join(r.pdir, "page.json");
  assert.deepEqual(Object.keys(readPageJson(pjp).openRows ?? {}), [rowId]);
  assert.equal(readPageJson(pjp).openRows![rowId].agentId, "fm-1");
  r.deck.stop();

  const deck2 = r.mkDeck(); // a fresh process: nothing in memory
  await deck2.configure();
  const f = join(r.pdir, "inbox.jsonl");
  const answered = readFileSync(f, "utf8").trim().split("\n").map((l) => ({ ...JSON.parse(l), answered: true }));
  writeFileSync(join(r.pdir, ".inbox.jsonl.tmp"), answered.map((x) => JSON.stringify(x) + "\n").join(""));
  renameSync(join(r.pdir, ".inbox.jsonl.tmp"), f);
  await until(() => r.rows.length === 2, 2000);
  assert.equal(r.rows[1].id, rowId, "the same row is replaced");
  assert.equal(r.rows[1].data.replied, true);
  assert.deepEqual(r.rows[1].data.comments, [{ target: "t-t1", text: "ping" }]);
  await until(() => Object.keys(readPageJson(pjp).openRows ?? {}).length === 0, 1000);
  deck2.stop();
});

test("an open session is polled through a real child: listener goes ok while the poll blocks, root and config are stamped, removal kills the child", async () => {
  const r = rig(FLEET);
  const fake = join(r.root, "lavish-axi", "cli.mjs"); // a poll that blocks like a connected browser's does
  mkdirSync(join(r.root, "lavish-axi"));
  writeFileSync(fake, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(r.root, "poll.pid"))}, String(process.pid)); setTimeout(() => {}, 60000);`);
  const prev = process.env.LAVISH_AXI_BIN;
  process.env.LAVISH_AXI_BIN = fake;
  try {
    const pjp = join(r.pdir, "page.json");
    writeFileSync(pjp, JSON.stringify({ lavishUrl: "http://x/session/1", session: "open", listener: "pending", lastRender: null, lastDelivery: null, undelivered: 0 }));
    await r.deck.configure();
    await until(() => readPageJson(pjp).listener === "ok", 4000);
    assert.equal(readPageJson(pjp).pluginRoot, r.root);
    await until(() => existsSync(join(r.root, "poll.pid")), 2000);
    const childPid = Number(readFileSync(join(r.root, "poll.pid"), "utf8"));
    assert.doesNotThrow(() => process.kill(childPid, 0), "poll child alive");
    // the captain ends the session elsewhere: the plugin stops polling and the child goes away
    writeFileSync(pjp, JSON.stringify({ ...readPageJson(pjp), session: "ended" }));
    await until(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }, 4000);
  } finally {
    if (prev === undefined) delete process.env.LAVISH_AXI_BIN; else process.env.LAVISH_AXI_BIN = prev;
    r.deck.stop();
  }
});
