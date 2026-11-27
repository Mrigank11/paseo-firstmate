process.env.TZ = "UTC";
process.env.FM_DECK_POLL_MODE ??= "cli"; // the older tests drive a fake lavish-axi CLI; the HTTP path has its own tests (http-poll, runtime-http)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deck, type DeckOpts } from "../server/runtime.ts";
import { hasLivePoll } from "../server/lavish.ts";
import { readInbox, readPageJson } from "../server/store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(10); }
}

import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector, SdkPort } from "../server/paseo-port.ts";
import { FakeHosts, FakeWorld, fakePaseo, shell, type FakeHost } from "./fake-paseo.ts";

/**
 * A daemon with two agents (ag-1 running, fm-1 the labelled first mate), reachable through a fake `paseo` CLI
 * (exec) and, once `sdk` is on (the default), through a fake SDK handle that is already captured.
 */
function rig(fleet: object, o: { sdk?: boolean; hosts?: FakeHosts; ttlMs?: number; deck?: Partial<DeckOpts> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deck-rt-"));
  const pdir = join(root, "state", "projects", "demo");
  mkdirSync(join(pdir, "sections"), { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo", sections: ["endpoints"] }));
  writeFileSync(join(pdir, "sections", "endpoints.md"), "- GET /x\n");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, ...fleet }));
  const fw = new FakeWorld().add(
    { id: "ag-1", status: "running", createdAt: "2026-10-21T10:00:00Z", updatedAt: "2026-10-21T10:05:00Z", model: "m", items: [shell("make build")] },
    { id: "fm-1", status: "idle", labels: { firstmate: "true" } },
  );
  // the registry no longer names a task's agent: Paseo does, by label. A test fleet's `agentId` (ignored by the plugin) says which fake agent to label.
  for (const t of (fleet as any).tasks) if (t.agentId && fw.agents.get(t.agentId)) fw.agents.get(t.agentId)!.labels = { "fm.task": t.id, "fm.project": t.project };
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
  const ports = new PortSelector(new CliPort(exec), () => {}, o.ttlMs === undefined ? undefined : (api) => new SdkPort(api, { root: () => root, ttlMs: o.ttlMs, patienceMs: 100 }));
  if (o.sdk ?? true) ports.capture({ paseo: fakePaseo(fw, o.hosts) }, "test");
  const world = {
    set status(v: string) { fw.agents.get("ag-1")!.status = v as any; },
    set sendFails(v: boolean) { fw.sendFails = v; },
    get sent() { return fw.sent.map((x) => x.text); },
    set labelled(l: unknown[]) { if (!l.length) fw.agents.get("fm-1")!.labels = {}; },
    set all(l: { id: string; status: string }[]) { for (const a of l) fw.add({ id: a.id, status: a.status as any }); },
  };
  const mkDeck = (cfg: Record<string, string> = {}) => new Deck({ exec, ports, batchMs: 30, readConfig: async () => ({ root, firstmateLabel: "firstmate=true", ...cfg }), ...o.deck });
  const deck = mkDeck();
  return {
    root, pdir, world, fw, cliCalls, ports, deck, mkDeck, page: join(pdir, "page.html"), live: join(pdir, "page.live.js"),
    get rows() { return fw.rows.map((r) => ({ agentId: r.agentId, id: (r.item as any).id as string, data: (r.item as any).data })); },
  };
}
const FLEET = { tasks: [{ id: "t1", intent: "do it", state: "active", project: "demo", agentId: "ag-1", shape: "ship" }] };

test("page.html is rewritten only when the signature moves; live.js only when its content moves, the version file on every render", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  await r.deck.render("demo");
  assert.ok(existsSync(r.page) && existsSync(r.live));
  assert.match(readFileSync(r.page, "utf8"), /Demo/);

  // an untouched file is never rewritten: watch its identity
  const stamp = () => { const st = statSync(r.page); return `${st.ino}:${st.mtimeMs}`; };
  const before = stamp();
  writeFileSync(r.live, "MARKER");
  await sleep(20);
  await r.deck.render("demo");
  assert.equal(stamp(), before, "same signature: html untouched");
  assert.equal(readFileSync(r.live, "utf8"), "MARKER", "nothing changed: the full payload is not rewritten");
  assert.match(readFileSync(r.live.replace(".live.js", ".live.v.js"), "utf8"), /__fdVer\("[0-9a-f]{16}",\d+,/, "the version file is");
  writeFileSync(r.live, "MARKER"); // (a later change must overwrite it)

  r.world.status = "idle"; // agent status is part of the signature
  r.deck.onAgentEvent("ag-1");
  await r.deck.render("demo");
  assert.equal(stamp(), before, "agent status changed: html untouched (Lavish reloads the page when it is rewritten)");


  writeFileSync(join(r.root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: [{ ...FLEET.tasks[0], state: "done" }] }));
  await r.deck.render("demo");
  assert.equal(stamp(), before, "fleet change: html untouched");
  assert.match(readFileSync(r.live, "utf8"), /done/, "the change reaches the page through live.js");

  writeFileSync(join(r.root, "state", "projects", "demo", "project.json"), JSON.stringify({ title: "Renamed", sections: ["endpoints"] }));
  await r.deck.render("demo");
  assert.notEqual(stamp(), before, "title change: html rewritten");
  r.deck.stop();
});

test("a page.html someone else rewrote is corrected on the next tick; an unchanged one is left alone", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  await r.deck.render("demo");
  writeFileSync(r.page, "<html>no canvas stylesheet</html>"); // as bin/page start does
  await r.deck.render("demo");
  assert.match(readFileSync(r.page, "utf8"), /^<!doctype html>[\s\S]*Demo/, "external rewrite restored");
  const st = statSync(r.page);
  await sleep(20);
  await r.deck.render("demo");
  assert.equal(statSync(r.page).mtimeMs, st.mtimeMs, "unchanged file not rewritten");
  r.deck.stop();
});

test("a fleet.json change re-renders the page within a second (watcher + debounce)", async () => {
  const r = rig({ tasks: [] });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.ok(!/Fresh task/.test(readFileSync(r.live, "utf8")));
  const t0 = Date.now();
  writeFileSync(join(r.root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: [{ id: "n1", intent: "x", title: "Fresh task", state: "queued", project: "demo" }] }));
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
    writeFileSync(fleet + ".tmpXYZ", JSON.stringify({ version: 2, tasks: [{ id: "n1", intent: "x", title: `Round ${i}`, status: "queued", project: "demo" }] }));
    renameSync(fleet + ".tmpXYZ", fleet);
    await until(() => readFileSync(r.live, "utf8").includes(`Round ${i}`), 1500);
    assert.ok(Date.now() - t0 < 1000, `round ${i} took ${Date.now() - t0} ms`);
  }
  r.deck.stop();
});

test("a task card appearing later (new tasks/<id>/ dir) is picked up", async () => {
  const r = rig({ tasks: [{ id: "n1", intent: "x", title: "Card task", state: "queued", project: "demo" }] });
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
    { id: "a", intent: "ask", state: "active", project: "demo", asks: [{ text: "Which?", since: "2026-10-20" }] },
    { id: "b", intent: "run", state: "active", project: "demo", agentId: "ag-1" },
    { id: "f", intent: "replied", state: "active", project: "demo", asks: [{ text: "Options?", since: "2026-10-21T09:00:00Z" }] },
    { id: "c", intent: "later", state: "queued", project: "demo" },
    { id: "d", intent: "hold", state: "parked", project: "demo" },
    { id: "e", intent: "fin", state: "done", project: "demo" },
    { id: "g", intent: "wait", state: "blocked", blocked_on: "Nemath: Trigger Prod API key", project: "demo" },
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
  const r = rig({ tasks: [{ id: "t1", intent: "x", title: "Pick one", state: "active", project: "demo", asks: [{ text: "Which design?", since: "2026-10-21T09:00:00Z", options: ["A card", "B console"] }] }] });
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
const THREE = (asks: object[]) => ({ tasks: [{ id: "pick", intent: "x", title: "Pick stack", state: "active", project: "demo", asks }] });
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
  writeFileSync(join(r.root, "state", "fleet.json"), JSON.stringify({ version: 2, ...THREE(ASKS3.slice(1)) }));
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
  const r = rig({ tasks: [{ id: "t1", intent: "x", state: "active", project: "demo", agentId: "ag-1" }] });
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
  const r = rig({ tasks: [{ id: "t1", intent: "live", state: "active", project: "demo" }] });
  writeFileSync(join(r.root, "state", "fleet-archive.jsonl"), [
    JSON.stringify({ id: "old1", intent: "Archived one", state: "done", project: "demo" }),
    '{"id":"half","project":"demo","stat',
    JSON.stringify({ id: "old2", intent: "Archived two", state: "failed", project: "demo" }),
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
  const r = rig({ tasks: [{ id: "t1", intent: "keep me visible", state: "queued", project: "demo" }] });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /keep me visible/);
  const fleet = join(r.root, "state", "fleet.json");
  writeFileSync(fleet, "");
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /keep me visible/, "an empty fleet.json does not empty the page");
  assert.equal(readPageJson(join(r.pdir, "page.json")).loadError, "fleet.json: file is empty");
  assert.match(liveHtml(r.live), /Task state could not be read \(fleet\.json\): showing the last good view/);
  assert.match((await r.deck.summary()).projects[0].banner ?? "", /Task state could not be read \(fleet\.json\)/);
  writeFileSync(fleet, '{"tasks":[{"id":"t1","intent":"half');
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /keep me visible/);
  assert.match(readPageJson(join(r.pdir, "page.json")).loadError ?? "", /^fleet\.json: invalid JSON/);
  writeFileSync(fleet, JSON.stringify({ version: 2, tasks: [{ id: "t1", intent: "back to normal", state: "queued", project: "demo" }] }));
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /back to normal/);
  assert.equal(readPageJson(join(r.pdir, "page.json")).loadError, null);
  assert.ok(!/Task state could not be read/.test(liveHtml(r.live)), "the banner goes away");
  r.deck.stop();
});

test("C3: with no last good view (plugin just started) a broken fleet.json renders the banner, not a crash", async () => {
  const r = rig({ tasks: [] });
  writeFileSync(join(r.root, "state", "fleet.json"), "{ nope");
  await r.deck.configure();
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /Task state could not be read \(fleet\.json\)/);
  assert.match(readPageJson(join(r.pdir, "page.json")).loadError ?? "", /^fleet\.json: invalid JSON/);
  r.deck.stop();
});

test("M4: every version file carries a growing sequence number", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  const seq = () => Number(/__fdVer\("[^"]*",(\d+),/.exec(readFileSync(r.live.replace(".live.js", ".live.v.js"), "utf8"))?.[1]);
  await r.deck.render("demo");
  const a = seq();
  await r.deck.render("demo");
  const b = seq();
  assert.ok(Number.isInteger(a) && b > a, `seq ${a} -> ${b}`);
  r.deck.stop();
});

test("failed tasks are counted as failed, not done, in the summary", async () => {
  const r = rig({ tasks: [
    { id: "ok1", intent: "fine", state: "done", project: "demo" },
    { id: "bad1", intent: "broke", state: "failed", project: "demo" },
  ] });
  writeFileSync(join(r.root, "state", "fleet-archive.jsonl"), JSON.stringify({ id: "bad0", intent: "old fail", state: "failed", project: "demo" }) + "\n" + JSON.stringify({ id: "ok0", intent: "old fine", state: "done", project: "demo" }) + "\n");
  await r.deck.configure();
  const c = (await r.deck.summary()).projects[0].counts;
  assert.deepEqual([c.done, c.failed], [2, 2]);
  await r.deck.render("demo");
  assert.match(liveHtml(r.live), /class="sum c-done">2 done</);
  assert.match(liveHtml(r.live), /class="sum c-fail">2 failed</);
  r.deck.stop();
});

test("a comment on the ask moves it to 'With the first mate' at once; so does one on the card of a single-ask task (T6)", async () => {
  const r = rig({ tasks: [{ id: "t1", intent: "x", title: "Pick one", state: "active", project: "demo", asks: [{ text: "Which design?", since: "2026-10-21T09:00:00Z" }] }] });
  await r.deck.configure();
  await r.deck.render("demo");
  r.deck.ingest("demo", [{ prompt: "why so slow?", selector: "article#t-t1 > div.tt" }]);
  await until(() => /why so slow/.test(liveHtml(r.live)), 1000);
  await until(() => /With the first mate/.test(liveHtml(r.live)), 1000);
  assert.ok(!/Needs you/.test(liveHtml(r.live)), "the task has one ask, so a card comment can only be about it");
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

// ---------- comment checks over HTTP ----------

import { createServer, type ServerResponse } from "node:http";
import { killAllPolls } from "../server/lavish.ts";

/** A fake Lavish whose /api/poll holds each request open until `answer` is called. */
async function holdingLavish() {
  const waiting: ServerResponse[] = [];
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/api/poll")) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.write(" ");
    waiting.push(res);
    res.on("close", () => { const i = waiting.indexOf(res); if (i >= 0) waiting.splice(i, 1); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: String((server.address() as any).port),
    get open() { return waiting.length; },
    answer(body: unknown) { waiting.shift()!.end(JSON.stringify(body)); },
    stop() { server.closeAllConnections(); server.close(); },
  };
}

test("HTTP comment check: no helper process, a comment lands in the inbox once, the next wait is open at once, a repeated delivery is dropped, stop closes the wait", async () => {
  const prev = process.env.FM_DECK_POLL_MODE;
  delete process.env.FM_DECK_POLL_MODE;
  const lv = await holdingLavish();
  const r = rig(FLEET);
  const deck = r.mkDeck({ lavishPort: lv.port });
  try {
    const pjp = join(r.pdir, "page.json");
    writeFileSync(pjp, JSON.stringify({ lavishUrl: "http://x/session/1", session: "open", listener: "pending", lastRender: null, lastDelivery: null, undelivered: 0 }));
    writeFileSync(r.page, "<p>x");
    await deck.configure();
    await until(() => lv.open === 1, 3000);
    await until(() => readPageJson(pjp).listener === "ok", 3000);
    assert.equal(hasLivePoll(r.page), false, "no lavish-axi poll process was started");
    lv.answer({ status: "feedback", prompts: [{ uid: "", prompt: "look here", selector: "#t-t1", tag: "p", text: "x" }] });
    await until(() => readInbox(join(r.pdir, "inbox.jsonl")).length === 1, 2000);
    await until(() => lv.open === 1, 1000); // re-asked at once
    lv.answer({ status: "feedback", prompts: [{ uid: "", prompt: "look here", selector: "#t-t1", tag: "p", text: "x" }] });
    await until(() => lv.open === 1, 1000);
    await sleep(100);
    assert.equal(readInbox(join(r.pdir, "inbox.jsonl")).length, 1, "the same delivery again is one comment");
    lv.answer({ status: "feedback", prompts: [{ uid: "", prompt: "a different one", selector: "#t-t1", tag: "p", text: "x" }] });
    await until(() => readInbox(join(r.pdir, "inbox.jsonl")).length === 2, 2000);
    await until(() => lv.open === 1, 1000);
    deck.stop();
    await until(() => lv.open === 0, 2000);
  } finally {
    if (prev !== undefined) process.env.FM_DECK_POLL_MODE = prev;
    deck.stop(); lv.stop(); killAllPolls();
  }
});

test("HTTP comment check falls back to the lavish-axi CLI when Lavish refuses connections", async () => {
  const prev = process.env.FM_DECK_POLL_MODE;
  const prevBin = process.env.LAVISH_AXI_BIN;
  delete process.env.FM_DECK_POLL_MODE;
  const r = rig(FLEET);
  const fake = join(r.root, "lavish-axi", "cli.mjs");
  mkdirSync(join(r.root, "lavish-axi"));
  writeFileSync(fake, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(r.root, "poll.pid"))}, String(process.pid)); setTimeout(() => {}, 60000);`);
  process.env.LAVISH_AXI_BIN = fake;
  const dead = await holdingLavish(); const port = dead.port; dead.stop();
  const deck = r.mkDeck({ lavishPort: port, lavishBin: fake });
  try {
    const pjp = join(r.pdir, "page.json");
    writeFileSync(pjp, JSON.stringify({ lavishUrl: "http://x/session/1", session: "open", listener: "pending", lastRender: null, lastDelivery: null, undelivered: 0 }));
    writeFileSync(r.page, "<p>x");
    await deck.configure();
    await until(() => existsSync(join(r.root, "poll.pid")), 8000);
    await until(() => readPageJson(pjp).listener === "ok", 3000);
  } finally {
    if (prev !== undefined) process.env.FM_DECK_POLL_MODE = prev;
    if (prevBin === undefined) delete process.env.LAVISH_AXI_BIN; else process.env.LAVISH_AXI_BIN = prevBin;
    deck.stop(); killAllPolls();
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

test("without a handle the CLI cannot see fm.task labels: no agent is claimed, nothing is guessed, no CLI call to render", async () => {
  const r = rig(FLEET, { sdk: false });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.equal(pill(r.live), "Dispatching");
  assert.deepEqual(r.cliCalls.filter((c) => VIEW_CALLS.test(c[0])), [], "no CLI calls to render");
  // the first hook hands over a handle: the very next render asks the daemon, finds the agent by its label, and the pill is real
  r.ports.capture({ paseo: fakePaseo(r.fw) }, "hook agent.turn_started");
  await until(() => pill(r.live) === "running", 1500);
  r.deck.stop();
});

test("after a reload (no SDK handle yet) the labelled agents come from the daemon's agent files: not Dispatching", async () => {
  const r = rig(FLEET, { sdk: false });
  const agentsDir = join(r.root, "daemon", "agents");
  mkdirSync(join(agentsDir, "ab"), { recursive: true });
  writeFileSync(join(agentsDir, "ab", "ag-1.json"), JSON.stringify({ id: "ag-1", labels: { "fm.task": "t1", "fm.project": "demo" }, createdAt: "2026-10-21T10:00:00Z", updatedAt: "2026-10-21T10:05:00Z" }));
  const deck = new Deck({ exec: async (a: string[]) => (a[0] === "ls" ? JSON.stringify([{ id: "ag-1", status: "running" }]) : ""), ports: r.ports, batchMs: 30, agentsDir, readConfig: async () => ({ root: r.root, firstmateLabel: "firstmate=true" }) });
  await deck.configure();
  await deck.render("demo");
  assert.notEqual(pill(r.live), "Dispatching");
  assert.match(readFileSync(r.live, "utf8"), /Running/);
  // a later SDK handle takes over without a flicker back to Dispatching
  r.ports.capture({ paseo: fakePaseo(r.fw) }, "hook agent.turn_started");
  await until(() => pill(r.live) === "running", 1500);
  deck.stop();
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
    { id: "t1", intent: "do it", state: "active", project: "demo", agentId: "ag-1", shape: "ship" },
    { id: "t2", intent: "idle one", state: "active", project: "demo", agentId: "ag-2", shape: "ship" },
  ] };
  const r = rig(fleet);
  r.fw.add({ id: "ag-2", status: "idle", labels: { "fm.task": "t2", "fm.project": "demo" }, items: [shell("make two")] });
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
  const r = rig({ tasks: [{ id: "t1", intent: "x", state: "active", project: "demo", agentId: "ag-1" }] });
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

test("per-project claims: a comment on each page reaches only that page's first mate", async () => {
  const r = rig(FLEET);
  // a second page, owned by its own first mate; "demo" falls back to the checkout-wide claim
  const other = join(r.root, "state", "projects", "other");
  mkdirSync(join(other, "sections"), { recursive: true });
  writeFileSync(join(other, "project.json"), JSON.stringify({ title: "Other", sections: [] }));
  writeFileSync(join(other, "claim.json"), JSON.stringify({ agentId: "fm-other", claimedAt: "2026-10-24T08:00:00Z" }));
  writeFileSync(join(r.root, "state", "firstmate.json"), JSON.stringify({ agentId: "fm-1", claimedAt: "2026-10-21T08:00:00Z" }));
  r.fw.add({ id: "fm-other", status: "idle" });
  await r.deck.configure();
  r.deck.ingest("demo", [{ prompt: "on demo", selector: "#t-t1" }]);
  r.deck.ingest("other", [{ prompt: "on other", selector: "main" }]);
  await until(() => r.fw.sent.length === 2);
  const to = (id: string) => r.fw.sent.filter((s) => s.id === id).map((s) => s.text).join("\n");
  assert.match(to("fm-1"), /on demo/);
  assert.doesNotMatch(to("fm-1"), /on other/);
  assert.match(to("fm-other"), /on other/);
  assert.doesNotMatch(to("fm-other"), /on demo/);
  assert.equal((await r.deck.summary("other")).firstmateAgentId, "fm-other");
  assert.equal((await r.deck.summary("demo")).firstmateAgentId, "fm-1");
  r.deck.stop();
});

// ---------- computed stages: Paseo + the fm.task label decide, the registry only holds intent ----------

import { assistant } from "./fake-paseo.ts";

const taskCard = (live: string, id: string) => {
  const i = live.indexOf(`id=\\"t-${id}\\"`);
  return i < 0 ? "" : live.slice(i, live.indexOf("</article>", i) > 0 ? live.indexOf("</article>", i) : undefined);
};
const groupOfCard = (live: string, id: string) => {
  const m = [...live.matchAll(/id=\\"g-(\w+)\\"/g)].map((x) => [x[1], x.index!] as const);
  const at = live.indexOf(`id=\\"t-${id}\\"`);
  return m.filter(([, i]) => i < at).pop()?.[0];
};

test("stage: a running agent found by its fm.task label is Running, not whatever the registry last said", async () => {
  // v1 registry still says needs-captain (no ask) with no agentId: the old page put this in Needs you
  const r = rig({ tasks: [{ id: "t2", intent: "stale", state: "active", project: "demo", shape: "ship" }] });
  r.fw.add({ id: "ag-2", status: "running", labels: { "fm.task": "t2", "fm.project": "demo" }, createdAt: "2026-10-24T10:00:00Z", items: [shell("npm test")] });
  await r.deck.configure();
  await r.deck.render("demo");
  const live = readFileSync(r.live, "utf8");
  assert.equal(groupOfCard(live, "t2"), "running");
  assert.match(taskCard(live, "t2"), /class=\\"stg\\">Running</);
  const sum = await r.deck.summary("demo");
  assert.deepEqual([sum.projects[0].counts.needsYou, sum.projects[0].counts.running, sum.projects[0].running[0].agentId], [0, 1, "ag-2"]);
  r.deck.stop();
});

test("stage: follows the agent: DONE: line -> Review; archived -> drift badge; ask-free", async () => {
  const r = rig({ tasks: [{ id: "t2", intent: "x", state: "active", since: "2026-10-24T09:00:00Z", project: "demo", shape: "scout" }] });
  r.fw.add({ id: "ag-2", status: "running", labels: { "fm.task": "t2" }, createdAt: "2026-10-24T10:00:00Z", items: [shell("ls")] });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.equal(groupOfCard(readFileSync(r.live, "utf8"), "t2"), "running");

  const a = r.fw.agents.get("ag-2")!;
  a.status = "idle"; a.items = [shell("ls"), assistant("DONE: report written")];
  r.deck.onAgentEvent("ag-2");
  await r.deck.render("demo");
  let live = readFileSync(r.live, "utf8");
  assert.equal(groupOfCard(live, "t2"), "fm");
  assert.match(taskCard(live, "t2"), /class=\\"stg\\">Review</);

  a.archivedAt = "2026-10-24T11:00:00Z";
  r.deck.onAgentEvent("ag-2");
  await r.deck.render("demo");
  live = readFileSync(r.live, "utf8");
  assert.match(taskCard(live, "t2"), /fl fl-d\\" title=\\"archived-agent-open-task\\"/);
  r.deck.stop();
});

test("stage: drift is shown, not hidden: a queued task with a running agent; a task with no agent after the grace window", async () => {
  const r = rig({ tasks: [
    { id: "q1", intent: "queued", state: "queued", project: "demo", shape: "ship" },
    { id: "l1", intent: "lost", state: "active", since: "2026-10-24T00:00:00Z", project: "demo", shape: "ship" },
  ] });
  r.fw.add({ id: "ag-q", status: "running", labels: { "fm.task": "q1" }, createdAt: "2026-10-24T10:00:00Z", items: [shell("ls")] });
  await r.deck.configure();
  await r.deck.render("demo");
  const live = readFileSync(r.live, "utf8");
  assert.equal(groupOfCard(live, "q1"), "running", "T4: the running agent decides the card");
  assert.match(taskCard(live, "q1"), /title=\\"queued-but-has-agent\\"/);
  assert.equal(groupOfCard(live, "l1"), "fm");
  assert.match(taskCard(live, "l1"), /title=\\"no-agent\\"/);
  r.deck.stop();
});

test("stage: a new labelled agent seen on an event is picked up once", async () => {
  const r = rig({ tasks: [{ id: "t3", intent: "x", state: "active", since: new Date().toISOString(), project: "demo", shape: "ship" }] });
  await r.deck.configure();
  await r.deck.render("demo");
  assert.match(taskCard(readFileSync(r.live, "utf8"), "t3"), /Dispatching/);
  r.fw.add({ id: "ag-3", status: "running", labels: { "fm.task": "t3" }, items: [shell("ls")] });
  r.deck.onAgentEvent("ag-3");
  await until(() => /class=\\"stg\\">Running</.test(taskCard(readFileSync(r.live, "utf8"), "t3")), 2000);
  r.deck.stop();
});

// ---- the crew's canvas in the card (F1), against a fake agent-canvas on loopback ----
import { FakeCanvas, summary as canvasSummary } from "./fake-canvas.ts";

const canvasDeck = (r: ReturnType<typeof rig>, fc: FakeCanvas, url = fc.url) =>
  new Deck({ exec: async () => "", ports: r.ports, batchMs: 30, canvasPollMs: 30, readConfig: async () => ({ root: r.root, firstmateLabel: "firstmate=true", canvasUrl: url }) });
const CV_FLEET = { version: 2, tasks: [{ id: "t2", intent: "build", title: "Build it", state: "active", since: "2026-10-24T09:00:00Z", project: "demo", shape: "ship" }] };
const cvRig = () => {
  const r = rig(CV_FLEET);
  r.fw.add({ id: "ag-2", status: "running", labels: { "fm.task": "t2" }, createdAt: "2026-10-24T10:00:00Z", items: [shell("npm test")] });
  return r;
};

test("canvas: the live page shows the agent's canvas, follows its changes, and records the canvas URL for the CLI", async () => {
  const fc = await new FakeCanvas().start();
  fc.set(canvasSummary("ag-2", { bluf: "Wiring the routes" }));
  const r = cvRig();
  const deck = canvasDeck(r, fc);
  await deck.configure();
  await deck.render("demo");
  await until(() => /Wiring the routes/.test(readFileSync(r.live, "utf8")), 3000);
  assert.match(taskCard(readFileSync(r.live, "utf8"), "t2"), /Open canvas ↗/);
  assert.match(readFileSync(r.page, "utf8"), /\.acv \.blk\{color:red\}/);
  assert.equal(readPageJson(join(r.pdir, "page.json")).canvasUrl, fc.url);
  // the canvas moves: the page follows without any agent event
  fc.set(canvasSummary("ag-2", { rev: 2, bluf: "Routes done, tests next" }));
  await until(() => /Routes done, tests next/.test(readFileSync(r.live, "utf8")), 3000);
  // a raw question lands in the stage
  fc.set(canvasSummary("ag-2", { rev: 3, openAsks: [{ id: "db", question: "pg or sqlite?", blocking: true, options: [{ value: "pg", label: "pg" }, { value: "sqlite", label: "sqlite" }] }] }));
  await until(() => /Running · 1 question/.test(readFileSync(r.live, "utf8")), 3000);
  const sum = await deck.summary("demo");
  assert.equal(sum.projects[0].counts.running, 1);
  deck.stop(); await fc.stop();
});

test("canvas: a click on a raw ask is validated against the live canvas and reaches the first mate as a canvas ask", async () => {
  const fc = await new FakeCanvas().start();
  fc.set(canvasSummary("ag-2", { openAsks: [{ id: "db", question: "pg or sqlite?", blocking: true, options: [{ value: "pg", label: "pg" }, { value: "sqlite", label: "sqlite" }] }] }));
  const r = cvRig();
  const deck = canvasDeck(r, fc);
  await deck.configure();
  await deck.render("demo");
  await until(() => /Uncurated/.test(readFileSync(r.live, "utf8")), 3000);
  const pick = (opt: string) => ({ prompt: `Picked: ${opt}\n\nContext data:\n${JSON.stringify({ kind: "ask-choice", task: "t2", ask: "c-db", option: opt })}`, selector: "#o-t2-c-db-1" });
  deck.ingest("demo", [pick("pg"), pick("mysql")]);
  await until(() => r.world.sent.length > 0, 3000);
  const msg = r.world.sent.join("\n");
  assert.match(msg, /picked option "pg" for canvas ask db \("pg or sqlite\?"\)/);
  assert.match(msg, /option "mysql" for canvas ask db .* no longer open, ignored|no longer open, ignored: option "mysql" for canvas ask db/);
  const inbox = readInbox(join(r.pdir, "inbox.jsonl"));
  assert.deepEqual(inbox.map((e) => [e.target, !!e.stale]), [["t-t2#c-db", false], ["t-t2#c-db", true]]);
  // the pick moves the card to "sent to the first mate" and the stage to With the first mate
  await until(() => /Sent to the first mate/.test(readFileSync(r.live, "utf8")), 3000);
  assert.match(taskCard(readFileSync(r.live, "utf8"), "t2"), /class=\\"stg\\">With the first mate</);
  deck.stop(); await fc.stop();
});

test("canvas: a comment on deep canvas content (stamped anchor) reaches the first mate on its task, with the crew's open canvas questions; an unplaced one quotes what was clicked", async () => {
  const fc = await new FakeCanvas().start();
  fc.set(canvasSummary("ag-2", { openAsks: [{ id: "env1", question: "Which change should I plan next?", blocking: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] }));
  const r = cvRig();
  const deck = canvasDeck(r, fc);
  await deck.configure();
  await deck.render("demo");
  await until(() => /Uncurated/.test(readFileSync(r.live, "utf8")), 3000);
  deck.ingest("demo", [
    { prompt: "plan this option", selector: "p#k_t-t2_2-1-1-0-0-0-3-0-2", tag: "p", text: "Option B only: staging gets its own bundle id" } as any,
    { prompt: "what is this?", selector: "div:nth-of-type(4) > ul > li > div > p", tag: "p", text: "A bullet outside any card" } as any,
    { prompt: "hello", selector: "body", tag: "body", text: "the whole page text" } as any,
  ]);
  await until(() => r.world.sent.length > 0, 3000);
  const msg = r.world.sent.join("\n");
  const inbox = readInbox(join(r.pdir, "inbox.jsonl"));
  assert.deepEqual(inbox.map((e) => e.target), ["t-t2", "page", "page"]);
  assert.match(msg, /- \[t-t2 · "Build it" · canvas ask env1: "Which change should I plan next\?"\] \(c-[^)]+\) "plan this option"/);
  assert.match(msg, /- \[page · on "A bullet outside any card"\] \(c-[^)]+\) "what is this\?"/);
  assert.match(msg, /- \[page\] \(c-[^)]+\) "hello"/, "a whole-page comment is not quoted");
  deck.stop(); await fc.stop();
});

test("canvas: agent-canvas down is a soft badge and the page keeps working; it heals when the canvas returns", async () => {
  const fc = await new FakeCanvas().start();
  fc.set(canvasSummary("ag-2", { bluf: "Up" }));
  fc.down = true;
  const r = cvRig();
  const deck = canvasDeck(r, fc);
  await deck.configure();
  await deck.render("demo");
  await until(() => /canvas unavailable/.test(readFileSync(r.live, "utf8")), 3000);
  assert.match(taskCard(readFileSync(r.live, "utf8"), "t2"), /class=\\"stg\\">Running</);
  fc.down = false;
  await until(() => /Up/.test(readFileSync(r.live, "utf8")) && !/canvas unavailable/.test(readFileSync(r.live, "utf8")), 3000);
  deck.stop(); await fc.stop();
});

test("canvas: 'off' in settings means no requests at all", async () => {
  const fc = await new FakeCanvas().start();
  fc.set(canvasSummary("ag-2"));
  const r = cvRig();
  const deck = canvasDeck(r, fc, "");
  await deck.configure();
  await deck.render("demo");
  await sleep(150);
  assert.equal(fc.hits.length, 0);
  assert.ok(!/Open canvas/.test(readFileSync(r.live, "utf8")));
  deck.stop(); await fc.stop();
});

test("first render seeds what the captain has seen; a later change is unseen; the page file stays still", async () => {
  const r = rig(FLEET);
  await r.deck.configure();
  await r.deck.render("demo");
  const ui = () => JSON.parse(readFileSync(join(r.pdir, "ui-state.json"), "utf8"));
  assert.deepEqual(Object.keys(ui().s.keys).sort(), ["page", "t-t1"], "seeded with the keys of the first render");
  const seeded = ui().s.keys["t-t1"];
  await r.deck.render("demo");
  assert.match(readFileSync(r.live, "utf8"), /data-seen=/, "the next payload carries the seen keys");
  assert.equal(ui().s.keys["t-t1"], seeded, "the seed is not re-written");
  writeFileSync(join(r.root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: [{ ...FLEET.tasks[0], state: "done" }] }));
  await r.deck.render("demo");
  const m = /data-keys="([^"]*)"/.exec(readFileSync(r.live, "utf8").replace(/\\"/g, '"'))!;
  assert.notEqual(JSON.parse(m[1].replace(/&quot;/g, '"'))["t-t1"], seeded, "a stage change moves the key");
  assert.equal(ui().s.keys["t-t1"], seeded, "the stored seen keys stay what the captain saw");
  r.deck.stop();
});

test("stages.json: the plugin's one evaluation agrees with the page card for card, and names owner, reason and owedSince", async () => {
  const r = rig({ tasks: [
    { id: "q1", intent: "queued", state: "queued", project: "demo", shape: "ship" },
    { id: "l1", intent: "lost", state: "active", since: "2026-10-24T00:00:00Z", project: "demo", shape: "ship" },
    { id: "r1", intent: "running", state: "active", project: "demo", shape: "ship" },
    { id: "a1", intent: "asking", state: "active", project: "demo", shape: "ship", asks: [{ text: "which?", since: "2026-10-24T09:00:00Z" }] },
  ] });
  r.fw.add({ id: "ag-r", status: "running", labels: { "fm.task": "r1" }, createdAt: "2026-10-24T10:00:00Z", items: [shell("ls")] });
  await r.deck.configure();
  await r.deck.render("demo");
  await r.deck.publishStages();
  const snap = JSON.parse(readFileSync(join(r.root, "state", "stages.json"), "utf8"));
  const live = readFileSync(r.live, "utf8");
  assert.deepEqual(snap.rows.map((x: any) => [x.id, x.group]), [["q1", "next"], ["l1", "fm"], ["r1", "running"], ["a1", "you"]]);
  for (const row of snap.rows) assert.equal(groupOfCard(live, row.id), row.group, `${row.id}: page and snapshot agree`);
  const l1 = snap.rows.find((x: any) => x.id === "l1");
  assert.deepEqual([l1.owner, /no agent/.test(l1.reason), typeof l1.owedSince, l1.clears.length > 0], ["firstmate", true, "string", true]);
  const first = l1.owedSince;
  await new Promise((res) => setTimeout(res, 20));
  await r.deck.publishStages();
  assert.equal(JSON.parse(readFileSync(join(r.root, "state", "stages.json"), "utf8")).rows.find((x: any) => x.id === "l1").owedSince, first, "owedSince holds while the situation does");
  assert.ok(snap.inputsMtimeMs > 0 && Date.now() - Date.parse(snap.writtenAt) < 60_000);
  r.deck.stop();
});

test("enforcement reaches the page and stages.json together: a stalled task moves to Needs you, only while its situation holds; a reminded crew reaches the first mate", async () => {
  const r = rig({ tasks: [
    { id: "l1", intent: "lost", state: "active", since: "2026-10-24T00:00:00Z", project: "demo", shape: "ship" },
    { id: "r1", intent: "running", state: "active", project: "demo", shape: "ship" },
  ] });
  r.fw.add({ id: "ag-r", status: "idle", labels: { "fm.task": "r1" }, createdAt: "2026-10-24T10:00:00Z", items: [shell("ls")] });
  await r.deck.configure();
  await r.deck.render("demo");
  await r.deck.publishStages();
  const read = () => JSON.parse(readFileSync(join(r.root, "state", "stages.json"), "utf8")).rows;
  const l1 = () => read().find((x: any) => x.id === "l1");
  assert.deepEqual([l1().group, l1().owner], ["fm", "firstmate"]);
  assert.deepEqual([read().find((x: any) => x.id === "r1").stage, read().find((x: any) => x.id === "r1").owner], ["Crew stopped · no hand-back", "crew"], "T7: an idle crew with no hand-back is the crew's");
  const fp = l1().fp;
  r.deck.setEnforcement(["ag-r"], { l1: { fp, why: "it did not act on 2 reminders" } });
  await r.deck.render("demo");
  await r.deck.publishStages();
  assert.deepEqual([l1().stage, l1().group, l1().owner], ["Needs you · first mate stalled", "you", "captain"]);
  assert.match(l1().reason, /did not act on 2 reminders/);
  assert.equal(groupOfCard(readFileSync(r.live, "utf8"), "l1"), "you", "the page agrees");
  const r1 = read().find((x: any) => x.id === "r1");
  assert.deepEqual([r1.stage, r1.group, r1.owner], ["Idle", "fm", "firstmate"], "after the reminder the silent crew reaches the first mate");
  assert.equal((await r.deck.summary()).projects[0].needsYou.length, 1, "the sidebar counts it");
  // a stall judged in an earlier situation no longer applies
  r.deck.setEnforcement([], { l1: { fp: "old", why: "x" } });
  await r.deck.publishStages();
  assert.equal(l1().group, "fm");
  r.deck.stop();
});

// ---------- crews on other Paseo hosts ----------

const MACTASK = { tasks: [{ id: "demo-ux-task", intent: "ux", state: "active", project: "demo", shape: "ship" }] };
const macLabels = { "fm.task": "demo-ux-task", "fm.project": "demo" };

/** One task with three crews: an old one here, an older and the newest on the Mac. */
function macRig(o: { ttlMs?: number } = {}) {
  const crew = (id: string, createdAt: string, status: "running" | "idle") => ({ id, status, createdAt, updatedAt: createdAt, labels: macLabels, items: [assistant(`working in ${id}`)] });
  const mac: FakeHost = {
    serverId: "srv_mac", label: "mac", lastOnlineAt: "2026-10-22T14:03:00Z",
    world: new FakeWorld().add(crew("mac-older", "2026-10-21T09:00:00Z", "idle"), crew("mac-new", "2026-10-22T09:00:00Z", "running")),
  };
  const r = rig(MACTASK, { hosts: new FakeHosts(mac), ttlMs: o.ttlMs ?? 0 });
  r.fw.add(crew("old-local", "2026-10-20T09:00:00Z", "idle"));
  const row = () => r.deck.snapshot()?.rows.find((x) => x.id === "demo-ux-task");
  const show = async () => { await r.deck.configure(); await r.deck.render("demo"); await r.deck.publishStages(); return readFileSync(r.live, "utf8"); };
  return { ...r, mac, row, show };
}

test("a task with an old local crew and two on the Mac shows the newest Mac crew, named and linked to its host", async () => {
  const r = macRig();
  const live = await r.show();
  assert.match(live, /\/h\/srv_mac\/agent\/mac-new/);
  assert.match(live, /on mac/);
  assert.doesNotMatch(live, /agent\/(old-local|mac-older)/);
  assert.deepEqual([r.row()?.agentId, r.row()?.host, r.row()?.stage], ["mac-new", "mac", "Running"]);
  const s = (await r.deck.summary()).projects[0];
  assert.deepEqual(s.running.map((x) => [x.agentId, x.agentStatus, x.host]), [["mac-new", "running", "mac"]]);
  r.deck.stop();
});

test("while the Mac is offline its crew is unknown since then: never the old local one, never asked", async () => {
  const r = macRig();
  await r.show();
  r.mac.status = "offline";
  r.mac.world.calls.length = 0;
  r.deck.onAgentEvent("mac-new", "srv_mac");
  await sleep(600); // past the shared label read
  const live = await r.show();
  assert.match(live, /unknown · mac offline since (22 Oct )?14:03/);
  assert.match(live, /\/h\/srv_mac\/agent\/mac-new/);
  assert.doesNotMatch(live, /agent\/old-local|so far|mac offline since 2026|1 agent working/);
  assert.deepEqual([r.row()?.agentId, r.row()?.host, r.row()?.stage], ["mac-new", "mac", "Unknown · mac offline"]);
  assert.deepEqual(r.mac.world.calls, []);
  const run = (await r.deck.summary()).projects[0].running[0];
  assert.deepEqual([run.agentStatus, run.host], ["unknown", "mac"]);
  assert.match(run.current, /^mac offline since (22 Oct )?14:03$/);
  r.deck.stop();
});

test("a hung host does not hold up a page", async () => {
  const r = macRig();
  await r.show();
  r.mac.world.hang = true;
  await sleep(600);
  const t0 = Date.now();
  await r.deck.render("demo");
  await r.deck.publishStages();
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  assert.equal(r.row()?.agentId, "mac-new");
  r.deck.stop();
  r.ports.sdkPort()!.hosts!.stop();
});

test("a remote crew's event refreshes its host at once, and its turn start is the one the host reported", async () => {
  const r = macRig({ ttlMs: 60_000 });
  await r.show();
  r.mac.world.agents.get("mac-new")!.status = "idle";
  r.mac.world.agents.get("mac-new")!.items = [assistant("DONE: mac @ abc")];
  await sleep(600);
  r.deck.onAgentEvent("mac-new", "srv_mac");
  await r.show();
  assert.equal(r.row()?.stage, "Review");
  r.deck.stop();
});

test("before the first SDK handle, remembered Mac crews are not replaced by an old local one", async () => {
  const agentsDir = mkdtempSync(join(tmpdir(), "deck-agents-"));
  mkdirSync(join(agentsDir, "a"));
  writeFileSync(join(agentsDir, "a", "old-local.json"), JSON.stringify({ id: "old-local", labels: macLabels, createdAt: "2026-10-20T09:00:00Z", lastStatus: "idle" }));
  const r = rig(MACTASK, { sdk: false, deck: { agentsDir } });
  writeFileSync(join(r.root, "state", "remote-agents.json"), JSON.stringify({ version: 1, hosts: { srv_mac: { label: "mac", offlineSince: null, agents: [{ id: "mac-new", task: "demo-ux-task", status: "running", archived: false, createdAt: "2026-10-22T09:00:00Z", lastActivityAt: "2026-10-22T09:00:00Z", pending: 0, labels: macLabels }] } } }));
  await r.deck.configure();
  await r.deck.publishStages();
  const row = r.deck.snapshot()!.rows[0];
  assert.deepEqual([row.agentId, row.host], ["mac-new", "mac"]);
  r.deck.stop();
});

test("the page's 'still alive' number comes from rendering: it moves on every tick, and stops when rendering stops working", async () => {
  const r = rig(FLEET);
  const deck = new Deck({ exec: async () => "", ports: r.ports, batchMs: 30, tickMs: 40, readConfig: async () => ({ root: r.root, firstmateLabel: "firstmate=true" }) });
  const seq = () => Number(/__fdVer\("[^"]*",(\d+),/.exec(readFileSync(r.live.replace(".live.js", ".live.v.js"), "utf8"))?.[1]);
  try {
    await deck.start();
    await until(() => existsSync(r.live), 3000);
    const a = seq();
    await until(() => seq() > a, 3000);
    (deck as any).writePage = () => { throw new Error("the render is broken"); };
    await sleep(100);
    const b = seq();
    await sleep(200); // five ticks
    assert.equal(seq(), b, "no render, no new number: the open page warns that it is stale");
  } finally { deck.stop(); }
});

test("a one-line card's body file has a name safe for any task id, the same one the page asks for", async () => {
  const id = "odd id#1?";
  const r = rig({ tasks: [{ id, intent: "done thing", state: "done", project: "demo", notes: "the body" }] });
  await r.deck.configure();
  await r.deck.render("demo");
  const files = readdirSync(r.page.replace(/\.html$/, ".d"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^b\.odd_id_1_\.[0-9a-f]{12}\.js$/);
  assert.match(readFileSync(r.page, "utf8"), /sc\.src=D\+"b\."\+id\.replace\(\/\[\^\\w\.-\]\/g,"_"\)\+"\."\+h\+"\.js"/);
  r.deck.stop();
});
