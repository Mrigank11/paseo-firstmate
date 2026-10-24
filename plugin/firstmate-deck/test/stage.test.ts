import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStage, currentAgent, archiveStateOf, stageAgentsFor, stateOf, type StageAgent, type StageTask } from "../server/stage.ts";

const NOW = new Date("2026-10-24T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const task = (over: Partial<StageTask> = {}): StageTask => ({ state: "active", since: ago(60), asks: [], ...over });
const agent = (over: Partial<StageAgent> = {}): StageAgent => ({ id: "ag-1", status: "running", archived: false, createdAt: ago(50), lastActivityAt: ago(1), pendingPermissions: 0, ...over });
const stage = (t: StageTask, as: StageAgent[], o?: Parameters<typeof computeStage>[3]) => computeStage(t, as, NOW, o);
const keys = (s: { flags: { key: string }[] }) => s.flags.map((f) => f.key);

test("1: an archive line is its verdict, frozen: Paseo is not consulted", () => {
  const s = stage(task({ state: "done" }), [agent()], { archived: true });
  assert.deepEqual([s.stage, s.group, keys(s)], ["Done", "done", []]);
  assert.equal(stage(task({ state: "failed" }), [], { archived: true }).failed, true);
});

test("2: done/failed live; an open ask stays visible; a still-running agent is drift", () => {
  assert.deepEqual([stage(task({ state: "done" }), [agent({ status: "idle" })]).group], ["done"]);
  assert.equal(stage(task({ state: "failed" }), []).failed, true);
  assert.equal(stage(task({ state: "done", asks: [{}] }), []).group, "you");
  assert.equal(stage(task({ state: "done", asks: [{ repliedAt: "x" }] }), []).group, "fm");
  const s = stage(task({ state: "done" }), [agent()]);
  assert.deepEqual([s.group, keys(s), s.flags[0].drift], ["done", ["done-but-running"], true]);
});

test("3: parked; a running agent is drift", () => {
  assert.equal(stage(task({ state: "parked" }), [agent({ status: "idle" })]).group, "parked");
  const s = stage(task({ state: "parked" }), [agent()]);
  assert.deepEqual([s.group, keys(s)], ["parked", ["parked-but-running"]]);
});

test("4: blocked", () => assert.equal(stage(task({ state: "blocked", blocked_on: "Nemath" }), []).group, "blocked"));

test("5: queued; an existing agent is drift", () => {
  assert.deepEqual([stage(task({ state: "queued" }), []).group, keys(stage(task({ state: "queued" }), []))], ["next", []]);
  assert.deepEqual(keys(stage(task({ state: "queued" }), [agent()])), ["queued-but-has-agent"]);
});

test("6: an unanswered ask is Needs you even while the agent runs; a replied one is with the first mate", () => {
  assert.equal(stage(task({ asks: [{}] }), [agent()]).group, "you");
  assert.equal(stage(task({ asks: [{ repliedAt: "x" }] }), [agent()]).group, "fm");
  assert.equal(stage(task({ asks: [{ repliedAt: "x" }, {}] }), [agent()]).group, "you");
});

test("7: a pending permission is Needs you", () => {
  const s = stage(task(), [agent({ pendingPermissions: 2 })]);
  assert.deepEqual([s.stage, s.group], ["Needs you · permission", "you"]);
});

test("8: every ask replied or pending is with the first mate", () => assert.equal(stage(task({ asks: [{ repliedAt: "x" }] }), []).stage, "With the first mate"));

test("9/10: no agent is Dispatching for 10 minutes, then Lost", () => {
  const fresh = stage(task({ since: ago(3) }), []);
  assert.deepEqual([fresh.stage, fresh.group, keys(fresh)], ["Dispatching", "running", []]);
  const lost = stage(task({ since: ago(11) }), []);
  assert.deepEqual([lost.stage, lost.group, keys(lost), lost.flags[0].drift], ["Lost", "fm", ["no-agent"], true]);
});

test("11: a running agent is Running; silence over 30 min is flagged", () => {
  const s = stage(task(), [agent()]);
  assert.deepEqual([s.stage, s.group, keys(s), s.agentId], ["Running", "running", [], "ag-1"]);
  assert.deepEqual(keys(stage(task(), [agent({ lastActivityAt: ago(40) })])), ["silent"]);
  assert.equal(stage(task(), [agent({ status: "initializing" })]).group, "running");
});

test("12: an errored agent", () => {
  const s = stage(task(), [agent({ status: "error" })]);
  assert.deepEqual([s.stage, s.group, s.failed], ["Failed (agent errored)", "fm", true]);
});

test("13/14/15: idle agent by its final line", () => {
  const idle = (final?: string) => stage(task(), [agent({ status: "idle", final })]);
  assert.deepEqual([idle("DONE: shipped").stage, idle("DONE: shipped").group, keys(idle("DONE: x"))], ["Review", "fm", []]);
  assert.equal(idle("BLOCKED: need key").stage, "Blocked by crew");
  assert.deepEqual([idle().stage, keys(idle())], ["Idle", ["idle-no-done"]]);
  assert.equal(stage(task(), [agent({ status: "closed", final: "DONE: x" })]).stage, "Review");
  // a caller that cannot read the last message does not guess "no DONE:"
  assert.deepEqual(keys(stage(task(), [agent({ status: "idle" })], { finalKnown: false })), []);
});

test("16: the current agent is archived", () => {
  const s = stage(task(), [agent({ archived: true, status: "idle" })]);
  assert.deepEqual([s.stage, keys(s)], ["Agent archived", ["archived-agent-open-task"]]);
});

test("an unreadable agent status is Running, flagged", () => {
  const s = stage(task(), [agent({ status: "unknown" })]);
  assert.deepEqual([s.group, keys(s)], ["running", ["status-unknown"]]);
});

test("reuse: the newest live agent wins; an older finished one is history", () => {
  const old = agent({ id: "old", status: "idle", createdAt: ago(300), final: "DONE: earlier task" });
  const cur = agent({ id: "new", createdAt: ago(20) });
  assert.equal(stage(task(), [old, cur]).agentId, "new");
  assert.equal(stage(task(), [cur, old]).stage, "Running");
  assert.equal(currentAgent([agent({ id: "a", archived: true, createdAt: ago(5) }), agent({ id: "b", archived: true, createdAt: ago(9) })])?.id, "a");
  assert.equal(currentAgent([agent({ id: "a", archived: true, createdAt: ago(5) }), agent({ id: "b", createdAt: ago(90) })])?.id, "b");
});

test("state is the registry's intent; the v1 status and agentId are not read any more", () => {
  for (const [state, want] of [["active", "active"], ["parked", "parked"], ["done", "done"], ["queued", "queued"], ["weird", "queued"], [undefined, "queued"]]) assert.equal(stateOf({ state }), want);
  assert.equal(stateOf({ status: "running" } as never), "queued");
  assert.equal(archiveStateOf({ outcome: "failed" }), "failed");
  assert.equal(archiveStateOf({ status: "failed" }), "failed");
  assert.equal(archiveStateOf({ state: "done" }), "done");
  const view = (id: string) => (id === "lab" ? { final: "DONE: ok" } : undefined);
  const labeled = stageAgentsFor([{ id: "lab", status: "idle", archived: false, createdAt: ago(5) }], view);
  assert.deepEqual([labeled.map((a) => a.id), labeled[0].final], [["lab"], "DONE: ok"]);
  assert.deepEqual(stageAgentsFor(undefined, view), []);
});

// ---- the crew's canvas (F1): asks, verdict flags, curated asks that resolve themselves ----
const cv = (asks: { id: string; pending?: boolean }[] = [], verdict = "Working") => ({ asks: asks.map((a) => ({ id: a.id, pending: !!a.pending })), verdict });

test("canvas: an open canvas ask on an idle agent is Needs you", () => {
  const s = stage(task(), [agent({ status: "idle", final: "BLOCKED: canvas ask db" })], { canvas: cv([{ id: "db" }]) });
  assert.deepEqual([s.stage, s.group], ["Needs you", "you"]);
});

test("canvas: a running agent with an open canvas ask is 'Running · 1 question' (agent-canvas's own rule)", () => {
  const one = stage(task(), [agent()], { canvas: cv([{ id: "db" }]) });
  assert.deepEqual([one.stage, one.group], ["Running · 1 question", "running"]);
  assert.equal(stage(task(), [agent()], { canvas: cv([{ id: "a" }, { id: "b" }]) }).stage, "Running · 2 questions");
});

test("canvas: a captain pick waiting on the first mate is With the first mate (running or idle)", () => {
  for (const status of ["running", "idle"]) {
    const s = stage(task(), [agent({ status })], { canvas: cv([{ id: "db", pending: true }]) });
    assert.deepEqual([s.stage, s.group], ["With the first mate", "fm"], status);
  }
  // an unanswered second question still wins over a pending first
  assert.equal(stage(task(), [agent({ status: "idle" })], { canvas: cv([{ id: "db", pending: true }, { id: "x" }]) }).group, "you");
});

test("canvas: no open ask changes nothing; a canvas that was not read changes nothing", () => {
  assert.equal(stage(task(), [agent()], { canvas: cv([]) }).stage, "Running");
  assert.equal(stage(task(), [agent()], {}).stage, "Running");
});

test("canvas: registry asks, permissions and an errored agent keep their precedence", () => {
  assert.equal(stage(task({ asks: [{ repliedAt: "x" }] }), [agent()], { canvas: cv([{ id: "db" }]) }).group, "fm");
  assert.equal(stage(task(), [agent({ pendingPermissions: 1 })], { canvas: cv([{ id: "db" }]) }).stage, "Needs you · permission");
  assert.equal(stage(task(), [agent({ status: "error" })], { canvas: cv([{ id: "db" }]) }).stage, "Failed (agent errored)");
});

test("canvas: only an active task listens to its canvas (parked, queued, done are the registry's)", () => {
  for (const state of ["parked", "queued", "blocked", "done"] as const) {
    assert.ok(!/question|Needs you/.test(stage(task({ state }), [agent({ status: "idle" })], { canvas: cv([{ id: "db" }]) }).stage), state);
  }
});

test("canvas: a Disputed or Stale verdict is a non-drift flag", () => {
  const d = stage(task(), [agent()], { canvas: cv([], "Disputed") });
  assert.deepEqual([keys(d), d.flags[0].drift], [["canvas-disputed"], false]);
  assert.deepEqual(keys(stage(task(), [agent({ status: "idle", final: "DONE: x" })], { canvas: cv([], "Stale") })), ["canvas-stale"]);
  assert.deepEqual(keys(stage(task(), [agent()], { canvas: cv([], "Needs you") })), []);
  // an archived current agent's canvas is a snapshot: no flag
  assert.deepEqual(keys(stage(task(), [agent({ archived: true, status: "idle" })], { canvas: cv([], "Disputed") })), ["archived-agent-open-task"]);
});

test("canvas: a curated ask whose canvas question is answered or gone closes itself: ref-closed, With the first mate", () => {
  const ref = { kind: "canvas", agentId: "ag-1", block: "db" };
  const closed = stage(task({ asks: [{ ref }] }), [agent()], { canvas: cv([]) });
  assert.deepEqual([closed.stage, closed.group, keys(closed), closed.flags[0].drift], ["With the first mate", "fm", ["ref-closed"], true]);
  // still open on the canvas: the curated ask stands, the captain's call
  assert.deepEqual([stage(task({ asks: [{ ref }] }), [agent()], { canvas: cv([{ id: "db" }]) }).group, keys(stage(task({ asks: [{ ref }] }), [agent()], { canvas: cv([{ id: "db" }]) }))], ["you", []]);
  // a registry ask with no ref is never closed by the canvas; and with the canvas unread nothing closes
  assert.equal(stage(task({ asks: [{}] }), [agent()], { canvas: cv([]) }).group, "you");
  assert.equal(stage(task({ asks: [{ ref }] }), [agent()], {}).group, "you");
  // an unrelated canvas question still open beats the closed ask: the captain's call, flag kept
  const raw = stage(task({ asks: [{ ref }] }), [agent({ status: "idle" })], { canvas: cv([{ id: "other" }]) });
  assert.deepEqual([raw.stage, keys(raw)], ["Needs you", ["ref-closed"]]);
  // another curated ask is still open next to the closed one: the open one decides, the flag still tells the first mate
  const two = stage(task({ asks: [{ ref }, {}] }), [agent()], { canvas: cv([]) });
  assert.deepEqual([two.group, keys(two)], ["you", ["ref-closed"]]);
});

test("canvas: a crew whose canvas.relay first mate is gone carries the relay-target-gone drift flag (live tasks only)", () => {
  const s = stage(task(), [agent({ relayGone: "fm-9999999" })]);
  assert.deepEqual([s.stage, keys(s), s.flags[0].drift], ["Running", ["relay-target-gone"], true]);
  assert.deepEqual(keys(stage(task(), [agent()])), []);
  assert.deepEqual(keys(stage(task({ state: "done" }), [agent({ status: "idle", relayGone: "fm-1" })])), [], "a finished task has nothing to relay");
  assert.deepEqual(keys(stage(task(), [agent({ archived: true, relayGone: "fm-1" })])), ["archived-agent-open-task"], "an archived agent has no canvas to relay: only its own flag");
});
