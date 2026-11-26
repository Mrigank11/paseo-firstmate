// Wake routing in the task tree: a crew's finish goes to the nearest live second mate going up, else the project's first mate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector } from "../server/paseo-port.ts";
import { Gate, ownerHops, type TurnEndedEvent } from "../server/gate.ts";
import { assistant, FakeWorld, fakePaseo } from "./fake-paseo.ts";

function rig(opts: { mateAlive?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "route-"));
  const state = join(root, "state");
  mkdirSync(join(state, "tasks", "g"), { recursive: true });
  mkdirSync(join(state, "projects", "p"), { recursive: true });
  const t = (id: string, x: object = {}) => ({ id, intent: id, state: "active", shape: "ship", project: "p", asks: [], ...x });
  writeFileSync(join(state, "fleet.json"), JSON.stringify({ version: 2, tasks: [t("g", { kind: "group", shape: "scout" }), t("c", { parent: "g" }), t("solo")] }));
  writeFileSync(join(state, "tasks", "g", "claim.json"), JSON.stringify({ agentId: "sm" }));
  writeFileSync(join(state, "projects", "p", "claim.json"), JSON.stringify({ agentId: "fm" }));
  const labels = (task: string) => ({ "fm.task": task, "fm.project": "p", "fm.shape": "ship", "fm.notify": "plugin" });
  const world = new FakeWorld().add({ id: "fm", labels: { firstmate: "true" } }, { id: "crew-c", labels: labels("c") }, { id: "crew-solo", labels: labels("solo") }, { id: "crew-g", labels: labels("g") });
  if (opts.mateAlive !== false) world.add({ id: "sm", labels: labels("g") });
  const ports = new PortSelector(new CliPort(async () => "[]"), () => {});
  ports.capture({ paseo: fakePaseo(world) }, "test");
  const gate = new Gate({ ports, root: () => root, firstmateLabel: () => "firstmate=true", log: () => {}, settleMs: 10, retryDelayMs: 1 });
  const done = (agent: string, task: string): TurnEndedEvent => ({
    agent: { id: agent, parentAgentId: "fm" }, turnId: "turn-1", outcome: { kind: "completed" },
    timeline: [assistant(`DONE: ${task} done`)] as never,
  });
  return { root, world, ports, gate, done };
}

test("a crew under a group with a live second mate wakes the second mate, not the first mate", async () => {
  const r = rig();
  await r.gate.onTurnEnded(r.done("crew-c", "c"));
  assert.deepEqual(r.world.sent.map((s) => s.id), ["sm"]);
});

test("a crew with no group above it wakes the project's first mate, exactly as before", async () => {
  const r = rig();
  await r.gate.onTurnEnded(r.done("crew-solo", "solo"));
  assert.deepEqual(r.world.sent.map((s) => s.id), ["fm"]);
});

test("a dead second mate falls back up the chain to the first mate", async () => {
  const r = rig({ mateAlive: false });
  await r.gate.onTurnEnded(r.done("crew-c", "c"));
  assert.deepEqual(r.world.sent.map((s) => s.id), ["fm"]);
});

test("the second mate's own finish goes up, never back to itself", async () => {
  const r = rig();
  await r.gate.onTurnEnded(r.done("sm", "g"));
  assert.deepEqual(r.world.sent.map((s) => s.id), ["fm"]);
});

test("ownerHops lists the chain nearest first, live agents only", async () => {
  const r = rig();
  assert.deepEqual(await ownerHops(r.ports, r.root, "p", "c"), [{ id: "sm", via: "g" }, { id: "fm", via: "project" }]);
  assert.deepEqual(await ownerHops(r.ports, r.root, "p", "solo"), [{ id: "fm", via: "project" }]);
  assert.deepEqual(await ownerHops(r.ports, r.root, "p"), [{ id: "fm", via: "project" }]);
});
