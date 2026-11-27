// The whole path of a crew on another host: its agent list -> synthesised events -> the same handlers a local hook reaches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatcher } from "../server/dispatch.ts";
import { Enforcer } from "../server/enforcer.ts";
import { Gate } from "../server/gate.ts";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector } from "../server/paseo-port.ts";
import { Permission } from "../server/permission.ts";
import { fileStore, followRemoteEvents } from "../server/remote-events.ts";
import { assistant, FakeHosts, FakeWorld, fakePaseo, type FakeAgent, type FakeHost } from "./fake-paseo.ts";
import { tmp } from "./tmp.ts";

const CREW = { "fm.task": "t1", "fm.project": "p", "fm.shape": "ship", "fm.notify": "plugin" };

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
}

test("a Mac crew's turn and permission requests reach the finish gate and the permission hook; nothing there is auto-allowed", async () => {
  const root = mkdtempSync(join(tmp(), "dispatch-"));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "firstmate.json"), JSON.stringify({ agentId: "fm" }));
  writeFileSync(join(root, "state", "decisions.md"), "```json fm-permission-rules\n" + JSON.stringify({ mode: "enforce", allowKinds: ["tool"], read: true, writeWithin: ["$WORKTREE"], worktreeRoots: [root] }) + "\n```\n");
  const cwd = join(root, "wt");
  const base: FakeAgent = { id: "far", labels: CREW, status: "idle", cwd, updatedAt: "2026-10-22T09:00:00Z" };
  const mac: FakeHost = { serverId: "srv_mac", label: "mac", world: new FakeWorld().add(base) };
  const hosts = new FakeHosts(mac);
  const local = new FakeWorld().add({ id: "fm", status: "idle", labels: { firstmate: "true" } });
  const ports = new PortSelector(new CliPort(async () => "[]"), () => {});
  ports.root = () => root;

  const deckCalls: unknown[][] = [];
  const deck = { onTurnStarted: (...a: unknown[]) => { deckCalls.push(["started", ...a]); }, onAgentEvent: (...a: unknown[]) => { deckCalls.push(["event", ...a]); } };
  const gate = new Gate({ ports, root: () => root, firstmateLabel: () => "firstmate=true", log: () => {}, retryDelayMs: 1 });
  const enforced: string[] = [];
  const enforcer = new Enforcer({ ports, root: () => root, snapshot: () => null, log: () => {}, onChange: () => {} });
  enforcer.onTurnEnded = (id) => { enforced.push(id); };
  const permission = new Permission({ ports, root: () => root, paseoHome: null, log: () => {}, retryDelayMs: 1 });
  const remote = followRemoteEvents(ports, { emit: dispatcher({ deck, gate, enforcer, permission }), log: () => {}, store: fileStore(() => root) });

  assert.equal(mac.world.observers.size, 0, "nothing to follow before there is a handle");
  ports.capture({ paseo: fakePaseo(local, hosts) }, "test");
  await until(() => mac.world.observers.size === 1);
  await remote.flush();

  const push = async (over: Partial<FakeAgent>, at: string) => { mac.world.upsert({ ...base, ...over, updatedAt: at }); await remote.flush(); };
  await push({ status: "running", activeTurn: { turnId: "turn-1", startedAt: "2026-10-22T09:01:00Z" } }, "2026-10-22T09:01:00Z");
  assert.deepEqual(deckCalls.filter((c) => c[0] === "started"), [["started", "far", "2026-10-22T09:01:00Z"]]);
  assert.deepEqual(deckCalls.find((c) => c[0] === "event"), ["event", "far", "srv_mac"]);

  const write = { id: "w1", provider: "claude", name: "Write", kind: "tool", detail: { type: "write", filePath: join(cwd, "a.txt") } };
  await push({ status: "running", activeTurn: { turnId: "turn-1", startedAt: "2026-10-22T09:01:00Z" }, pendingPermissions: [write] }, "2026-10-22T09:02:00Z");
  await until(() => local.sent.length === 1);
  assert.match(local.sent[0].text, /^## Crew PERMISSION · t1\n[\s\S]*on mac/);

  await push({ status: "idle", activeTurn: null, turnId: "turn-1", items: [assistant("DONE: mac @ abc")] }, "2026-10-22T09:03:00Z");
  await until(() => local.sent.length === 2);
  assert.match(local.sent[1].text, /^## Crew DONE · t1\nDONE: mac @ abc\n/);
  assert.deepEqual(local.sent.map((m) => m.id), ["fm", "fm"]);
  assert.deepEqual(enforced, ["far"]);
  assert.equal(mac.world.responded.length, 0, "a write on another host is never auto-allowed");
  assert.equal(mac.world.sent.length, 0);

  // a new handle: the subscription moves to it
  ports.capture({ paseo: fakePaseo(local, new FakeHosts(mac)) }, "test");
  await until(() => mac.world.observers.size === 1);
  await remote.flush();
  assert.equal(local.sent.length, 2, "nothing is replayed");
  remote.stop();
  assert.equal(mac.world.observers.size, 0);
  ports.capture({ paseo: fakePaseo(local, new FakeHosts(mac)) }, "test");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mac.world.observers.size, 0, "stopped stays stopped");
  gate.stop();
  enforcer.stop();
  ports.sdkPort()!.hosts!.stop();
});
