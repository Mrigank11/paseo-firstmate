import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStage, stageAgentsFor, type StageAgent, type StageTask } from "../server/stage.ts";

const NOW = new Date("2026-11-27T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const task = (over: Partial<StageTask> = {}): StageTask => ({ state: "active", since: ago(600), asks: [], ...over });
const mac = (over: Partial<StageAgent> = {}): StageAgent => ({ id: "mac-1", status: "running", archived: false, createdAt: ago(50), lastActivityAt: ago(200), pendingPermissions: 0, host: "mac", ...over });
const offline = { label: "mac", since: ago(90) };
const stage = (t: StageTask, as: StageAgent[], o?: Parameters<typeof computeStage>[3]) => computeStage(t, as, NOW, o);

test("an offline host's crew is unknown, owed by the crew: never closed, lost, idle or stalled", () => {
  for (const status of ["running", "idle", "error", "closed"]) {
    const s = stage(task(), [mac({ status, hostOffline: offline })]);
    assert.deepEqual([s.stage, s.group, s.owner, s.failed, s.agentId], ["Unknown · mac offline", "running", "crew", false, "mac-1"]);
    assert.equal(s.reason, `unknown · mac offline since ${offline.since}`);
    assert.deepEqual(s.flags.map((f) => [f.key, f.drift]), [["host-offline", false]]);
  }
});

test("an offline crew's stale permission is not asked of the captain, and its quiet time raises no flag", () => {
  const s = stage(task(), [mac({ pendingPermissions: 1, hostOffline: offline, final: "DONE: x" })]);
  assert.equal(s.group, "running");
  assert.ok(!s.flags.some((f) => f.key === "silent" || f.key === "canvas-stale"));
});

test("a stale canvas is expected while the host is offline", () => {
  const s = stage(task(), [mac({ hostOffline: offline })], { canvas: { asks: [], verdict: "Stale" } });
  assert.deepEqual(s.flags.map((f) => f.key), ["host-offline"]);
});

test("registry intent and open asks still decide an offline crew's task", () => {
  const crew = [mac({ hostOffline: offline })];
  assert.equal(stage(task({ asks: [{}] }), crew).group, "you");
  assert.equal(stage(task({ asks: [{ repliedAt: ago(1) }] }), crew).group, "fm");
  assert.equal(stage(task({ state: "parked" }), crew).group, "parked");
  assert.equal(stage(task({ state: "blocked" }), crew).group, "blocked");
  assert.equal(stage(task({ state: "done" }), crew).group, "done");
  assert.deepEqual(stage(task({ state: "done" }), crew).flags, []);
  assert.equal(stage(task(), crew, { canvas: { asks: [{ id: "q", pending: false }] } }).group, "you");
});

test("the newest agent wins across hosts, online or not", () => {
  const local: StageAgent = { id: "local-old", status: "idle", archived: false, createdAt: ago(500), lastActivityAt: ago(400), pendingPermissions: 0 };
  assert.equal(stage(task(), [local, mac({ hostOffline: offline })]).agentId, "mac-1");
  assert.equal(stage(task(), [local, mac()]).agentId, "mac-1");
});

test("stageAgentsFor carries the host and its offline mark", () => {
  const [a] = stageAgentsFor([{ id: "mac-1", status: "running", archived: false, host: "mac", hostOffline: offline }], () => undefined);
  assert.deepEqual([a.host, a.hostOffline], ["mac", offline]);
});
