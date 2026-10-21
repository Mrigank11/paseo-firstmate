import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliPort } from "../server/paseo-cli.ts";
import { finalLine, itemStep, PortSelector, resolveFirstMate, sendToFirstMate, SdkPort, TAIL_LIMIT, viewFromItems, type TimelineItem } from "../server/paseo-port.ts";
import { human } from "../server/humanize.ts";
import { COMMENT_ROW_KIND } from "../shared/contract.ts";
import { assistant, FakeWorld, fakePaseo, shell, thought, tool } from "./fake-paseo.ts";

const phrase = (item: TimelineItem) => { const s = itemStep(item); return s ? human(s[0], s[1]) : null; };

// ---------- timeline items -> the phrases humanize.ts produces ----------

test("each timeline item kind maps to the phrase the CLI path would show", () => {
  assert.equal(phrase(shell("cd x && rtk npm run check >/dev/null 2>&1; echo done")), "Ran npm run check");
  assert.equal(phrase(shell("sed -n 1,20p src/foo/bar.ts")), "Read bar.ts");
  assert.equal(phrase(shell("")), "Running a shell command");
  assert.equal(phrase(tool({ type: "read", filePath: "/a/b/c.ts" }, "Read")), "Reading c.ts");
  assert.equal(phrase(tool({ type: "edit", filePath: "/a/b/c.ts" }, "Edit")), "Editing c.ts");
  assert.equal(phrase(tool({ type: "write", filePath: "/a/b/new.md" }, "Write")), "Writing new.md");
  assert.equal(phrase(tool({ type: "search", query: "foo bar", toolName: "grep" }, "Grep")), "Search: foo bar");
  assert.equal(phrase(tool({ type: "fetch", url: "https://x.dev/a" }, "WebFetch")), "Fetch: https://x.dev/a");
  assert.equal(phrase(tool({ type: "sub_agent", subAgentType: "Explore", description: "look around", log: "" }, "Task")), "Explore: look around");
  assert.equal(phrase(tool({ type: "sub_agent", description: "do it", log: "" }, "Task")), "Task: do it");
  assert.equal(phrase(tool({ type: "plan", text: "..." }, "ExitPlanMode")), "Plan");
  assert.equal(phrase(thought("First sentence. Second sentence.")), "Thinking: First sentence.");
  assert.equal(phrase({ type: "todo", items: [{ text: "a", completed: false }] }), "Tasks");
  assert.equal(phrase({ type: "error", message: "boom" }), "Error: boom");
  assert.equal(phrase({ type: "compaction", status: "completed" }), "Compacted");
});

test("skills, task notifications and unknown tools", () => {
  assert.equal(phrase(tool({ type: "unknown", input: { skill: "superpowers:brainstorming" }, output: null }, "Skill")), "Loading skill superpowers:brainstorming");
  assert.equal(phrase(tool({ type: "unknown", input: {}, output: null }, "Skill")), "Skill");
  const note = tool({ type: "plain_text", label: "Background command npm run build completed", icon: "wrench" }, "task_notification");
  assert.deepEqual(itemStep(note), ["Task notification", "Background command npm run build completed"]);
  assert.match(phrase(note)!, /^Finished: /);
  assert.equal(phrase(tool({ type: "unknown", input: { pattern: "TODO" }, output: null }, "Grep")), "Grep: TODO");
  assert.equal(phrase(tool({ type: "unknown", input: null, output: null }, "mcp__x__do_thing")), "mcp__x__do_thing");
  assert.equal(phrase(tool({ type: "unknown", input: {}, output: null }, "web_search")), "Web search");
});

test("messages, notices, plugin rows and inter-agent chatter are not steps", () => {
  assert.equal(itemStep(assistant("hello")), null);
  assert.equal(itemStep({ type: "user_message", text: "hi" }), null);
  assert.equal(itemStep({ type: "notification", level: "info", message: "n" }), null);
  assert.equal(itemStep({ type: "plugin", id: "r", pluginId: "p", kind: "k", version: 1, data: {} }), null);
  const msg = (event: "message" | "finished") => ({ ...tool({ type: "plain_text", text: "x" }, "send"), agentMessage: { event, text: "t", sender: { id: "ag-9", title: "Scout" } } }) as unknown as TimelineItem;
  assert.equal(itemStep(msg("message")), null);
  assert.equal(phrase(msg("finished")), "Agent finished: Scout");
});

test("viewFromItems: step count, the last 8 humanized, and the final DONE/BLOCKED line", () => {
  const items: TimelineItem[] = [];
  for (let i = 1; i <= 12; i++) items.push(shell(`make step${i}`), assistant(`working on ${i}`));
  items.push(assistant("All good.\nDONE: shipped it\nthanks"), assistant("one more word"));
  const v = viewFromItems(items);
  assert.equal(v.stepCount, 12);
  assert.equal(v.recent.length, 8);
  assert.equal(v.recent[0], "Ran make step5");
  assert.equal(v.recent[7], "Ran make step12");
  assert.equal(v.final, "DONE: shipped it");
  assert.equal(finalLine([assistant("BLOCKED: no creds"), assistant("DONE: later")]), "DONE: later");
  assert.equal(finalLine([assistant("not DONE: yet")]), undefined);
});

// ---------- SdkPort ----------

test("SdkPort.listAgents: label filter goes to the daemon, archived agents are not listed", async () => {
  const w = new FakeWorld().add(
    { id: "fm-1", status: "idle", labels: { firstmate: "true" }, createdAt: "2026-10-21T08:00:00Z", model: "m1", thinking: "high", title: "First mate" },
    { id: "crew", status: "running" },
    { id: "gone", status: "idle", labels: { firstmate: "true" }, archivedAt: "2026-10-21T09:00:00Z" },
  );
  const port = new SdkPort(fakePaseo(w));
  const some = await port.listAgents({ label: "firstmate=true" });
  assert.deepEqual(some.map((a) => a.id), ["fm-1"]);
  assert.deepEqual(w.calls, ['list:{"firstmate":"true"}']);
  assert.deepEqual(some[0], { id: "fm-1", status: "idle", labels: { firstmate: "true" }, createdAt: "2026-10-21T08:00:00Z", updatedAt: "2026-10-21T10:05:00.000Z", model: "m1", thinking: "high", title: "First mate", archived: false });
  assert.deepEqual((await port.listAgents()).map((a) => a.id), ["fm-1", "crew"]);
  assert.deepEqual((await port.listAgents({ label: "firstmate" })).map((a) => a.id), ["fm-1"], "a bare key matches any value");
});

test("SdkPort.send steers instead of interrupting; appendTimelineRow writes the plugin row", async () => {
  const w = new FakeWorld().add({ id: "fm-1" });
  const port = new SdkPort(fakePaseo(w));
  await port.send("fm-1", "hello");
  assert.deepEqual(w.sent, [{ id: "fm-1", text: "hello", options: { activeTurnBehavior: "steer" } }]);
  const data = { project: "demo", pageUrl: null, at: "2026-10-21T10:00:00Z", comments: [{ target: "page", text: "x" }], replied: false };
  assert.equal(await port.appendTimelineRow("fm-1", "pc-1", data), true);
  assert.deepEqual(w.rows[0], { agentId: "fm-1", item: { type: "plugin", id: "pc-1", kind: COMMENT_ROW_KIND, version: 1, data } });
});

test("SdkPort.agentView: status, times, model, thinking and the steps from a bounded tail", async () => {
  const items: TimelineItem[] = [];
  for (let i = 0; i < 250; i++) items.push(shell(`make n${i}`));
  items.push(assistant("DONE: finished"));
  const w = new FakeWorld().add({ id: "ag", status: "running", createdAt: "2026-10-21T10:00:00Z", updatedAt: "2026-10-21T10:30:00Z", model: "claude-x", thinking: "medium", items, hasOlder: true });
  const v = await new SdkPort(fakePaseo(w)).agentView("ag");
  assert.equal(v.status, "running");
  assert.deepEqual([v.createdAt, v.updatedAt, v.model, v.thinking], ["2026-10-21T10:00:00Z", "2026-10-21T10:30:00Z", "claude-x", "medium"]);
  assert.equal(v.stepCount, TAIL_LIMIT - 1, "only the tail is read (the last item is the DONE message)");
  assert.equal(v.stepsAtLeast, true, "older entries exist: the count is a lower bound");
  assert.equal(v.recent.at(-1), "Ran make n249");
  assert.equal(v.final, "DONE: finished");
  w.agents.get("ag")!.archivedAt = "2026-10-21T11:00:00Z";
  w.agents.get("ag")!.hasOlder = false;
  const v2 = await new SdkPort(fakePaseo(w)).agentView("ag");
  assert.equal(v2.status, "archived");
  assert.equal(v2.stepsAtLeast, undefined);
});

test("first mate resolution through the SDK: claim first, then newest live labelled non-crew agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "deck-sdkfm-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ tasks: [{ id: "t", agentId: "scout" }] }));
  const w = new FakeWorld().add(
    { id: "scout", status: "idle", labels: { firstmate: "true" }, createdAt: "2026-10-21T12:00:00Z" },
    { id: "fm-a", status: "idle", labels: { firstmate: "true" }, createdAt: "2026-10-21T08:00:00Z" },
    { id: "fm-b", status: "closed", labels: { firstmate: "true" }, createdAt: "2026-10-21T11:00:00Z" },
    { id: "fm-c", status: "idle", labels: { firstmate: "true" }, createdAt: "2026-10-21T09:00:00Z" },
    { id: "claimed", status: "running" },
  );
  const port = new SdkPort(fakePaseo(w));
  assert.equal((await resolveFirstMate(port, "firstmate=true", root))?.id, "fm-c", "crew excluded, closed ranks last, newest wins");
  writeFileSync(join(root, "state", "firstmate.json"), JSON.stringify({ agentId: "claimed" }));
  assert.deepEqual(await resolveFirstMate(port, "firstmate=true", root), { id: "claimed", status: "running" });
  w.agents.get("claimed")!.archivedAt = "2026-10-21T13:00:00Z";
  assert.equal((await resolveFirstMate(port, "firstmate=true", root))?.id, "fm-c", "an archived claim falls back to the label");
});

// ---------- the selector ----------

test("selector: cold start sends through the CLI, then a captured handle sends through the SDK", async () => {
  const w = new FakeWorld().add({ id: "fm-1", labels: { firstmate: "true" } });
  const cliSent: string[][] = [];
  const exec = async (args: string[]) => {
    if (args[0] === "ls") return JSON.stringify([{ id: "fm-1", status: "idle" }]);
    if (args[0] === "send") { cliSent.push(args); return ""; }
    return "";
  };
  const logs: string[] = [];
  const sel = new PortSelector(new CliPort(exec), (m) => logs.push(m));
  let firsts = 0;
  sel.onFirstHandle = () => firsts++;
  assert.equal(sel.hasHandle, false);
  assert.equal(sel.current().kind, "cli");
  assert.equal(await sendToFirstMate(sel, "firstmate=true", "one", undefined, undefined), "fm-1");
  assert.equal(cliSent.length, 1);
  assert.ok(cliSent[0].includes("steer"));
  assert.equal(w.sent.length, 0);

  // the send started a turn, a hook fires and hands over the handle
  const api = fakePaseo(w);
  sel.capture({}, "hook nothing");
  assert.equal(sel.hasHandle, false, "a callback without a handle changes nothing");
  sel.capture({ paseo: api }, "hook agent.turn_started");
  sel.capture({ paseo: api }, "hook agent.turn_ended");
  assert.equal(firsts, 1);
  assert.equal(sel.current().kind, "sdk");
  assert.equal(await sendToFirstMate(sel, "firstmate=true", "two", undefined, undefined), "fm-1");
  assert.equal(cliSent.length, 1, "no more CLI sends");
  assert.deepEqual(w.sent.map((s) => s.text), ["two"]);
  assert.ok(logs.some((l) => /SDK handle captured \(from hook agent\.turn_started\)/.test(l)));
  assert.ok(logs.some((l) => /send to fm-1 via cli took \d+ ms/.test(l)));
  assert.ok(logs.some((l) => /send to fm-1 via sdk took \d+ ms/.test(l)));
});

test("selector: an SDK send that fails is retried once through the CLI", async () => {
  const w = new FakeWorld().add({ id: "fm-1" });
  w.sendFails = true;
  const cliSent: string[][] = [];
  const sel = new PortSelector(new CliPort(async (args) => { if (args[0] === "send") cliSent.push(args); return ""; }));
  sel.capture({ paseo: fakePaseo(w) }, "test");
  assert.equal(await sel.send("fm-1", "hi"), "cli");
  assert.equal(cliSent.length, 1);
  w.sendFails = false;
  assert.equal(await sel.send("fm-1", "hi"), "sdk");
});
