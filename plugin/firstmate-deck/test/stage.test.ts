import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStage, currentAgent, stageAgentsFor, stateOf, type StageAgent, type StageTask } from "../server/stage.ts";

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

test("v1 shim: status maps to state; agentId is only a hint when Paseo has no labelled agent", () => {
  for (const [status, state] of [["dispatched", "active"], ["running", "active"], ["needs-captain", "active"], ["done", "done"], ["queued", "queued"], ["weird", "queued"]]) assert.equal(stateOf({ status }), state);
  assert.equal(stateOf({ state: "parked", status: "running" }), "parked");
  const view = (id: string) => (id === "hint" ? { status: "idle", createdAt: ago(9), final: "DONE: ok" } : undefined);
  const hinted = stageAgentsFor({ agentId: "hint" }, undefined, view);
  assert.deepEqual([hinted.length, stage(task(), hinted).stage], [1, "Review"]);
  const labeled = stageAgentsFor({ agentId: "hint" }, [{ id: "lab", status: "running", archived: false, createdAt: ago(5) }], view);
  assert.deepEqual(labeled.map((a) => a.id), ["lab"]);
  assert.deepEqual(stageAgentsFor({}, undefined, view), []);
  assert.equal(stageAgentsFor({ agentId: "nope" }, undefined, view)[0].status, "unknown");
});
