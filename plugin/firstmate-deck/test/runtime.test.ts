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

import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector } from "../server/paseo-port.ts";
import { FakeWorld, fakePaseo, shell } from "./fake-paseo.ts";

/**
 * A daemon with two agents (ag-1 running, fm-1 the labelled first mate), reachable through a fake `paseo` CLI
 * (exec) and, once `sdk` is on (the default), through a fake SDK handle that is already captured.
 */
function rig(fleet: object, o: { sdk?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deck-rt-"));
  const pdir = join(root, "state", "projects", "demo");
  mkdirSync(join(pdir, "sections"), { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo", sections: ["endpoints"] }));
  writeFileSync(join(pdir, "sections", "endpoints.md"), "- GET /x\n");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify(fleet));
  const fw = new FakeWorld().add(
    { id: "ag-1", status: "running", createdAt: "2026-10-21T10:00:00Z", updatedAt: "2026-10-21T10:05:00Z", model: "m", items: [shell("make build")] },
    { id: "fm-1", status: "idle", labels: { firstmate: "true" } },
  );
  const cliCalls: string[][] = [];
  const exec = async (args: string[]) => {
    cliCalls.push(args);
    const live = [...fw.agents.values()].filter((a) => !a.archivedAt);
    if (args[0] === "status") return JSON.stringify({ listen: "127.0.0.1:1", serverId: "srv" });
    if (args[0] === "ls" && args.includes("--label")) return JSON.stringify(live.filter((a) => a.labels?.firstmate === "true").map((a) => ({ id: a.id, status: a.status })));
    if (args[0] === "ls") return JSON.stringify(live.map((a) => ({ id: a.id, status: a.status })));
    if (args[0] === "inspect") return JSON.stringify({ CreatedAt: fw.agents.get(args[1])?.createdAt ?? "2026-10-21T10:00:00Z" });
    if (args[0] === "send") {
      if (fw.sendFails) throw new Error("daemon down");
      fw.sent.push({ id: args[1], text: readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8"), options: "cli" });
      return "";
    }
    throw new Error("unexpected " + args.join(" "));
  };
  const ports = new PortSelector(new CliPort(exec));
  if (o.sdk ?? true) ports.capture({ paseo: fakePaseo(fw) }, "test");
  const world = {
    set status(v: string) { fw.agents.get("ag-1")!.status = v as any; },
    set sendFails(v: boolean) { fw.sendFails = v; },
    get sent() { return fw.sent.map((x) => x.text); },
    set labelled(l: unknown[]) { if (!l.length) fw.agents.get("fm-1")!.labels = {}; },
    set all(l: { id: string; status: string }[]) { for (const a of l) fw.add({ id: a.id, status: a.status as any }); },
  };
  const mkDeck = () => new Deck({ exec, ports, batchMs: 30, readConfig: async () => ({ root, firstmateLabel: "firstmate=true" }) });
  const deck = mkDeck();
  return {
    root, pdir, world, fw, cliCalls, ports, deck, mkDeck, page: join(pdir, "page.html"), live: join(pdir, "page.live.js"),
    get rows() { return fw.rows.map((r) => ({ agentId: r.agentId, id: (r.item as any).id as string, data: (r.item as any).data })); },
  };
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
    { id: "g", intent: "wait", status: "blocked", blocked_on: "Nemath: Trigger Prod API key", project: "demo" },
  ] });
  writeFileSync(join(r.pdir, "inbox.jsonl"), JSON.stringify({ id: "c1", at: "2026-10-21T09:05:00Z", project: "demo", target: "t-f#a1", text: "more detail" }) + "\n");
  await r.deck.configure();
  await r.deck.render("demo");
  const s = await r.deck.summary();
  assert.equal(s.firstmateAgentId, "fm-1");
  const p = s.projects[0];
  assert.deepEqual(p.counts, { needsYou: 1, withFirstMate: 1, running: 1, blocked: 1, next: 1, parked: 1, done: 1, failed: 0 });
  assert.deepEqual(p.needsYou, [{ taskId: "a", askId: "a1", taskTitle: "ask", text: "Which?", since: "2026-10-20" }]);
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
  const data = JSON.stringify({ kind: "ask-choice", task: "t1", ask: "a1", option: "B console" }, null, 2);
  r.deck.ingest("demo", [{ prompt: `Picked: B console\n\nContext data:\n${data}`, selector: "article#t-t1" }]);
  await until(() => /You picked <b>B console<\/b> · the first mate is applying it/.test(liveHtml(r.live)), 1000);
  const [e] = readInbox(join(r.pdir, "inbox.jsonl"));
  assert.equal(e.target, "t-t1#a1", "a click targets its ask");
  assert.deepEqual(e.choice, { task: "t1", ask: "a1", option: "B console", askText: "Which design?" });
  assert.equal(e.stale, undefined, "a valid click is not stale");
  await until(() => r.world.sent.length === 1, 1500);
  assert.match(r.world.sent[0], /- \[t-t1#a1 · "Pick one"\] \(c-[^)]+\) picked option "B console" for ask a1 \("Which design\?"\)/);
  assert.match(r.world.sent[0], /Option picks are applied automatically when you reply; use --keep-open <task>#<askId> to keep an ask open\.$/);
  assert.ok(!/Apply with/.test(r.world.sent[0]), "the relay no longer tells the first mate to run bin/fleet answer");
  const g = liveHtml(r.live);
  assert.ok(g.indexOf("With the first mate") > 0 && !/Needs you/.test(g));
  r.deck.stop();
});

/** The HTML of one ask block (from its id to the next block or the end of its card). */
const askBlock = (html: string, task: string, ask: string): string => {
  const i = html.indexOf(`id="a-${task}-${ask}"`);
  if (i < 0) return "";
  const rest = html.slice(i + 10);
  const j = rest.search(/class="askbox"|<\/article>/);
  return j < 0 ? rest : rest.slice(0, j);
};
const THREE = (asks: object[]) => ({ tasks: [{ id: "pick", intent: "x", title: "Pick stack", status: "needs-captain", project: "demo", asks }] });
const ASKS3 = [
  { id: "a1", text: "Postgres or SQLite?", since: "2026-10-21T09:00:00Z", options: ["Postgres", "SQLite"] },
  { id: "a2", text: "Which CI provider?", since: "2026-10-21T09:00:00Z", options: ["Buildkite", "Actions"] },
  { id: "a3", text: "Fly or Render?", since: "2026-10-21T09:00:00Z", options: ["Fly", "Render"] },
];
const click = (task: string, ask: string, option: string) => ({ prompt: `Picked: ${option}\n\nContext data:\n${JSON.stringify({ kind: "ask-choice", task, ask, option }, null, 2)}`, selector: `article#t-${task}` });

test("C1: answering ask 1 does not move a click on ask 2 onto another question", async () => {
  const r = rig(THREE(ASKS3));
  await r.deck.configure();
  await r.deck.render("demo");
  r.deck.ingest("demo", [click("pick", "a2", "Buildkite")]);
  await until(() => /You picked/.test(liveHtml(r.live)), 1000);
  assert.match(askBlock(liveHtml(r.live), "pick", "a2"), /You picked <b>Buildkite<\/b>/);
  // the first mate answers ask 1 first: ask 2 becomes the first element of the array
  writeFileSync(join(r.root, "state", "fleet.json"), JSON.stringify(THREE(ASKS3.slice(1))));
  await r.deck.render("demo");
  const html = liveHtml(r.live);
  assert.match(askBlock(html, "pick", "a2"), /You picked <b>Buildkite<\/b>/, "the pick still sits under 'Which CI provider?'");
  assert.match(askBlock(html, "pick", "a2"), /Which CI provider\?/);
  const a3 = askBlock(html, "pick", "a3");
  assert.ok(!/You picked/.test(a3) && /Your call:/.test(a3) && /data-opt="Fly"/.test(a3), "'Fly or Render?' is still an open question with live buttons");
  assert.ok(!/id="a-pick-a1"/.test(html), "the answered ask is gone");
  const s = (await r.deck.summary()).projects[0];
  assert.deepEqual(s.needsYou.map((n) => [n.askId, n.text]), [["a3", "Fly or Render?"]]);
  assert.equal(readInbox(join(r.pdir, "inbox.jsonl"))[0].target, "t-pick#a2");
  r.deck.stop();
});

test("C1: a click on an ask that is no longer open is recorded as stale, relayed as ignored, and shown nowhere as a pick", async () => {
  const r = rig(THREE(ASKS3.slice(1))); // a1 is already answered
  await r.deck.configure();
  await r.deck.render("demo");
  r.deck.ingest("demo", [click("pick", "a1", "Postgres"), click("pick", "a2", "Bogus option"), click("pick", "a2", "Actions")]);
  const [gone, bogus, good] = readInbox(join(r.pdir, "inbox.jsonl"));
  assert.equal(gone.stale, true, "the ask id is gone");
  assert.equal(bogus.stale, true, "the option is not one of the ask's options");
  assert.equal(good.stale, undefined);
  await until(() => r.world.sent.length === 1, 1500);
  const msg = r.world.sent[0];
  assert.match(msg, /\(c-[^)]+\) option click on an ask that is no longer open, ignored: option "Postgres" for ask a1/);
  assert.match(msg, /option click on an ask that is no longer open, ignored: option "Bogus option" for ask a2/);
  assert.match(msg, /picked option "Actions" for ask a2/);
  await until(() => /You picked/.test(liveHtml(r.live)), 1000);
  const html = liveHtml(r.live);
  assert.match(askBlock(html, "pick", "a2"), /You picked <b>Actions<\/b>/, "only the valid click is shown as a pick");
  assert.ok(!/You picked <b>(Postgres|Bogus)/.test(html));
  assert.match(html, /that question was already closed|clicked <b>/, "the stale click stays visible on the card, marked as not applied");
  r.deck.stop();
});

test("C1: a stale-only message does not tell the first mate that picks are applied", async () => {
  const r = rig(THREE(ASKS3.slice(1)));
  await r.deck.configure();
  r.deck.ingest("demo", [click("pick", "a1", "Postgres")]);
  await until(() => r.world.sent.length === 1, 1500);
  assert.ok(!/applied automatically/.test(r.world.sent[0]));
  r.deck.stop();
});

test("C1: asks without ids (written before ids existed) fall back to their index", async () => {
  const r = rig(THREE([{ text: "Old one?", since: "2026-10-21T09:00:00Z", options: ["Yes", "No"] }]));
  await r.deck.configure();
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /id="a-pick-a1"/);
  r.deck.ingest("demo", [click("pick", "a1", "Yes")]);
  assert.equal(readInbox(join(r.pdir, "inbox.jsonl"))[0].stale, undefined);
  r.deck.stop();
});

test("C2: a first-mate claim held by a crew agent is ignored (with a log line)", async () => {
  const logs: string[] = [];
  const r = rig({ tasks: [{ id: "t1", intent: "x", status: "running", project: "demo", agentId: "ag-1" }] });
  const deck = new Deck({ exec: async () => "", ports: r.ports, batchMs: 30, log: (m) => logs.push(m), readConfig: async () => ({ root: r.root, firstmateLabel: "firstmate=true" }) });
  writeFileSync(join(r.root, "state", "firstmate.json"), JSON.stringify({ agentId: "ag-1", claimedAt: "2026-10-21T10:00:00Z" }));
  await deck.configure();
  assert.equal((await deck.summary()).firstmateAgentId, "fm-1", "the labelled non-crew agent wins over the crew claim");
  assert.ok(logs.some((l) => /ignoring the first-mate claim on ag-1: fleet\.json lists it as crew/.test(l)));
  deck.stop();
  r.deck.stop();
});

test("C3: a malformed archive line is skipped with a warning; the page still renders", async () => {
  const logs: string[] = [];
  const r = rig({ tasks: [{ id: "t1", intent: "live", status: "running", project: "demo" }] });
  writeFileSync(join(r.root, "state", "fleet-archive.jsonl"), [
    JSON.stringify({ id: "old1", intent: "Archived one", status: "done", project: "demo" }),
    '{"id":"half","project":"demo","stat',
    JSON.stringify({ id: "old2", intent: "Archived two", status: "failed", project: "demo" }),
  ].join("\n") + "\n");
  const deck = new Deck({ exec: async () => "", ports: r.ports, log: (m) => logs.push(m), readConfig: async () => ({ root: r.root, firstmateLabel: "firstmate=true" }) });
  await deck.configure();
  await deck.render("demo");
  const html = liveHtml(r.live);
  assert.ok(/Archived one/.test(html) && /Archived two/.test(html), "good archive lines still show");
  assert.ok(logs.some((l) => /skipped 1 malformed line\(s\) in fleet-archive\.jsonl/.test(l)));
  assert.equal(readPageJson(join(r.pdir, "page.json")).loadError ?? null, null, "a bad archive line is not a load error");
  deck.stop();
  r.deck.stop();
});

test("C3: an empty or malformed fleet.json keeps the last good view, sets loadError and a banner; fixing it clears both", async () => {
  const r = rig({ tasks: [{ id: "t1", intent: "keep me visible", status: "queued", project: "demo" }] });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /keep me visible/);
  const fleet = join(r.root, "state", "fleet.json");
  writeFileSync(fleet, "");
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /keep me visible/, "an empty fleet.json does not empty the page");
  assert.equal(readPageJson(join(r.pdir, "page.json")).loadError, "fleet.json: file is empty");
  assert.match(readFileSync(r.page, "utf8"), /Task state could not be read \(fleet\.json\): showing the last good view/);
  assert.match((await r.deck.summary()).projects[0].banner ?? "", /Task state could not be read \(fleet\.json\)/);
  writeFileSync(fleet, '{"tasks":[{"id":"t1","intent":"half');
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /keep me visible/);
  assert.match(readPageJson(join(r.pdir, "page.json")).loadError ?? "", /^fleet\.json: invalid JSON/);
  writeFileSync(fleet, JSON.stringify({ tasks: [{ id: "t1", intent: "back to normal", status: "queued", project: "demo" }] }));
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /back to normal/);
  assert.equal(readPageJson(join(r.pdir, "page.json")).loadError, null);
  assert.ok(!/Task state could not be read/.test(readFileSync(r.page, "utf8")), "the banner goes away");
  r.deck.stop();
});

test("C3: with no last good view (plugin just started) a broken fleet.json renders the banner, not a crash", async () => {
  const r = rig({ tasks: [] });
  writeFileSync(join(r.root, "state", "fleet.json"), "{ nope");
  await r.deck.configure();
  await r.deck.render("demo");
  assert.match(readFileSync(r.page, "utf8"), /Task state could not be read \(fleet\.json\)/);
  assert.match(readPageJson(join(r.pdir, "page.json")).loadError ?? "", /^fleet\.json: invalid JSON/);
  r.deck.stop();
});

test("M4: every live payload carries a growing sequence number", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  const seq = () => Number(/,(\d+)\);\n$/.exec(readFileSync(r.live, "utf8"))?.[1]);
  await r.deck.render("demo");
  const a = seq();
  await r.deck.render("demo");
  const b = seq();
  assert.ok(Number.isInteger(a) && b > a, `seq ${a} -> ${b}`);
  r.deck.stop();
});

test("failed tasks are counted as failed, not done, in the summary", async () => {
  const r = rig({ tasks: [
    { id: "ok1", intent: "fine", status: "done", project: "demo" },
    { id: "bad1", intent: "broke", status: "failed", project: "demo" },
  ] });
  writeFileSync(join(r.root, "state", "fleet-archive.jsonl"), JSON.stringify({ id: "bad0", intent: "old fail", status: "failed", project: "demo" }) + "\n" + JSON.stringify({ id: "ok0", intent: "old fine", status: "done", project: "demo" }) + "\n");
  await r.deck.configure();
  const c = (await r.deck.summary()).projects[0].counts;
  assert.deepEqual([c.done, c.failed], [2, 2]);
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /class="sum c-done">2 done</);
  assert.match(liveHtml(r.live), /class="sum c-fail">2 failed</);
  r.deck.stop();
});

test("a comment on the ask itself moves it to 'With the first mate' at once; a comment on the card does not", async () => {
  const r = rig({ tasks: [{ id: "t1", intent: "x", title: "Pick one", status: "needs-captain", project: "demo", asks: [{ text: "Which design?", since: "2026-10-21T09:00:00Z" }] }] });
  await r.deck.configure();
  await r.deck.render("demo");
  r.deck.ingest("demo", [{ prompt: "why so slow?", selector: "article#t-t1 > div.tt" }]);
  await until(() => /why so slow/.test(liveHtml(r.live)), 1000);
  assert.ok(/Needs you/.test(liveHtml(r.live)) && !/With the first mate/.test(liveHtml(r.live)), "a card comment does not move the ask");
  r.deck.ingest("demo", [{ prompt: "show me both", selector: "article#t-t1 > div#a-t1-a1 > div.ask" }]);
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

// ---------- agent views: SDK only, stale without a handle, refreshed by events ----------

const pill = (f: string) => /<span class="pill p-[\w-]+"><span class="dot"><\/span>([^<]*)<\/span>/.exec(liveHtml(f))?.[1];
const VIEW_CALLS = /^(ls|inspect|logs)$/;

test("rendering never touches the CLI: pills and steps come from the SDK", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  await r.deck.render("demo");
  assert.equal(pill(r.live), "running");
  assert.match(liveHtml(r.live), /Ran make build/);
  assert.match(liveHtml(r.live), /1 steps/);
  assert.deepEqual(r.cliCalls.filter((c) => VIEW_CALLS.test(c[0])), []);
  assert.ok(r.fw.count("refetch:ag-1") >= 1);
  r.deck.stop();
});

test("without a handle the last-known views (remembered in page.json) are shown as 'status unknown (reconnecting)'", async () => {
  const r = rig(FLEET, { sdk: false });
  const view = { status: "running", createdAt: "2026-10-21T10:00:00Z", updatedAt: "2026-10-21T10:05:00Z", model: "m", stepCount: 7, recent: ["Ran make build"] };
  writeFileSync(join(r.pdir, "page.json"), JSON.stringify({ lavishUrl: null, session: "unknown", lastRender: null, lastDelivery: null, undelivered: 0, agentViews: { "ag-1": view } }));
  await r.deck.configure();
  await r.deck.render("demo");
  assert.equal(pill(r.live), "status unknown (reconnecting)");
  assert.match(liveHtml(r.live), /7 steps/, "the last-known facts are kept");
  assert.match(liveHtml(r.live), /Ran make build/);
  assert.deepEqual(r.cliCalls.filter((c) => VIEW_CALLS.test(c[0])), [], "no CLI calls to render");
  assert.equal(readPageJson(join(r.pdir, "page.json")).agentViews!["ag-1"].stepCount, 7, "the remembered view survives");
  // the first hook hands over a handle: the very next render asks the daemon and the pill is real again
  r.ports.capture({ paseo: fakePaseo(r.fw) }, "hook agent.turn_started");
  await until(() => pill(r.live) === "running", 1500);
  assert.match(liveHtml(r.live), /Ran make build/);
  r.deck.stop();
});

test("no handle and nothing remembered: the pill says the status is unknown, not a guess", async () => {
  const r = rig(FLEET, { sdk: false });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.equal(pill(r.live), "status unknown (reconnecting)");
  assert.deepEqual(r.cliCalls.filter((c) => VIEW_CALLS.test(c[0])), []);
  r.deck.stop();
});

test("a failed SDK read keeps the last view but marks it stale", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  await r.deck.render("demo");
  assert.equal(pill(r.live), "running");
  r.fw.refetchFails.add("ag-1");
  await r.deck.render("demo");
  assert.equal(pill(r.live), "status unknown (reconnecting)");
  r.fw.refetchFails.clear();
  await r.deck.render("demo");
  assert.equal(pill(r.live), "running");
  r.deck.stop();
});

test("an agent event refreshes just that agent and re-renders its project; ticks refresh only running agents", async () => {
  const fleet = { tasks: [
    { id: "t1", intent: "do it", status: "running", project: "demo", agentId: "ag-1", shape: "ship" },
    { id: "t2", intent: "idle one", status: "running", project: "demo", agentId: "ag-2", shape: "ship" },
  ] };
  const r = rig(fleet);
  r.fw.add({ id: "ag-2", status: "idle", items: [shell("make two")] });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.equal(r.fw.count("refetch:ag-1"), 1);
  assert.equal(r.fw.count("refetch:ag-2"), 1);

  await r.deck.render("demo"); // a tick: the idle agent's cached view is kept
  assert.equal(r.fw.count("refetch:ag-1"), 2, "running: refreshed every render");
  assert.equal(r.fw.count("refetch:ag-2"), 1, "idle: cached until its status changes");

  r.fw.agents.get("ag-2")!.status = "running";
  r.fw.agents.get("ag-2")!.items!.push(shell("make three"));
  r.deck.onAgentEvent("ag-2"); // turn_started
  await until(() => r.fw.count("refetch:ag-2") === 2 && /Ran make three/.test(liveHtml(r.live)), 1500);
  assert.equal(r.fw.count("refetch:ag-1"), 3 - 1 + 1 - 1 + (r.fw.count("refetch:ag-1") - 2), "ag-1 only refreshes because it is running");

  r.fw.agents.get("ag-2")!.status = "idle";
  r.deck.onAgentEvent("ag-2"); // turn_ended
  await until(() => r.fw.count("refetch:ag-2") === 3, 1500);
  const settled = r.fw.count("refetch:ag-2");
  await r.deck.render("demo");
  assert.equal(r.fw.count("refetch:ag-2"), settled, "idle again: cached");
  r.deck.stop();
});

test("a project with no running agent asks the daemon nothing on a tick", async () => {
  const r = rig({ tasks: [{ id: "t1", intent: "x", status: "running", project: "demo", agentId: "ag-1" }] });
  r.world.status = "idle";
  await r.deck.configure();
  await r.deck.render("demo");
  const n = r.fw.count("refetch:");
  await r.deck.render("demo");
  await r.deck.render("demo");
  assert.equal(r.fw.count("refetch:"), n);
  r.deck.stop();
});

test("cold start end to end: comment goes out through the CLI, the handle arrives, the next one goes through the SDK", async () => {
  const r = rig(FLEET, { sdk: false });
  await r.deck.configure();
  r.deck.ingest("demo", [{ prompt: "first", selector: "#t-t1" }]);
  await until(() => r.fw.sent.length === 1, 2000);
  assert.equal(r.fw.sent[0].options, "cli");
  assert.equal(r.rows.length, 0, "the CLI cannot write the timeline row");
  r.ports.capture({ paseo: fakePaseo(r.fw) }, "hook agent.turn_started");
  r.deck.ingest("demo", [{ prompt: "second", selector: "#t-t1" }]);
  await until(() => r.fw.sent.length === 2, 2000);
  assert.deepEqual(r.fw.sent[1].options, { activeTurnBehavior: "steer" });
  await until(() => r.rows.length === 1, 1000);
  assert.equal(r.rows[0].agentId, "fm-1");
  r.deck.stop();
});
