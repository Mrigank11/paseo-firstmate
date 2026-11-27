// Which agents on another host are this daemon's: those it started (label paseo.parent-server-id = its server id) or whose
// canvas.relay is a live agent here. Everything else there is someone else's, even with the same fm.* labels: never listed,
// stored, read, sent to or answered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector, SdkPort, type SdkPortOptions } from "../server/paseo-port.ts";
import { followRemoteEvents } from "../server/remote-events.ts";
import { readRemoteStore, remoteStorePath } from "../server/remote-store.ts";
import { crew, fakeExec, mac as cliMac, type World } from "./fake-hosts.ts";
import { assistant, FakeHosts, FakeWorld, fakePaseo, type FakeHost } from "./fake-paseo.ts";
import { tmp } from "./tmp.ts";

const PARENT = "paseo.parent-server-id";
const AT = "2026-11-27T10:00:00.000Z";
const T = { "fm.task": "t1", "fm.notify": "plugin" };

/** Labels of the remote agents, by id. `started` and `relayed` are ours; the rest are not. */
const REMOTE: Record<string, Record<string, string>> = {
  started: { ...T, [PARENT]: "srv_local" },
  relayed: { ...T, "canvas.relay": "fm" },
  theirs: { ...T, [PARENT]: "srv_other" },
  "their-relay": { ...T, "canvas.relay": "theirs-mate", [PARENT]: "srv_other" },
  "gone-relay": { ...T, "canvas.relay": "old-fm" },
  "prefix-relay": { ...T, "canvas.relay": "f" },
  unlabelled: { ...T },
  "theirs-mate": { firstmate: "true", [PARENT]: "srv_other" },
};
const OURS = ["relayed", "started"];
const FOREIGN = Object.keys(REMOTE).filter((id) => !OURS.includes(id));

function setup(o: SdkPortOptions = {}, root = mkdtempSync(join(tmp(), "own-"))) {
  const local = new FakeWorld().add(
    { id: "fm", status: "idle", labels: { firstmate: "true" } },
    { id: "old-fm", status: "idle", labels: {}, archivedAt: AT },
  );
  const remote = new FakeWorld().add(
    ...Object.entries(REMOTE).map(([id, labels]) => ({ id, bare: true, status: "idle" as const, labels, createdAt: AT, items: [assistant("DONE: x")] })),
  );
  const mac: FakeHost = { serverId: "srv_mac", label: "mac", world: remote };
  const hosts = new FakeHosts(mac);
  const api = fakePaseo(local, hosts);
  const opts = { root: () => root, ttlMs: 0, patienceMs: 30, timeoutMs: 200, cooldownMs: 0, ...o };
  return { root, local, remote, mac, hosts, api, port: new SdkPort(api, opts), again: () => new SdkPort(api, opts) };
}
const remoteIds = (xs: { id: string; serverId?: string }[]) => xs.filter((a) => a.serverId).map((a) => a.id).sort();
const stored = (root: string) => (readRemoteStore(root).hosts.srv_mac?.agents ?? []).map((a) => a.id).sort();
const touched = (w: FakeWorld, id: string) => w.calls.filter((c) => /^(refetch|send|respond|append):/.test(c) && c.endsWith(`:${id}`));

test("SdkPort lists and remembers only our agents on another host", async () => {
  const s = setup();
  assert.deepEqual(remoteIds(await s.port.listAgents({ includeArchived: true })), OURS);
  assert.deepEqual(remoteIds(await s.port.listAgents({ label: "fm.task" })), OURS);
  assert.deepEqual(remoteIds(await s.port.listAgents({ label: "firstmate=true" })), []);
  assert.deepEqual(stored(s.root), OURS);
});

test("SdkPort never reads, sends to, answers or writes on a foreign agent", async () => {
  const s = setup();
  await s.port.listAgents();
  for (const id of FOREIGN) {
    await assert.rejects(() => s.port.send(id, "x"), id);
    await assert.rejects(() => s.port.respondToPermission(id, "p", { behavior: "allow" }), id);
    await assert.rejects(() => s.port.agentView(id), id);
    await assert.rejects(() => s.port.tailItems(id), id);
    await assert.rejects(() => s.port.appendTimelineRow(id, "r", { project: "p", pageUrl: null, at: AT, comments: [], replied: false }), id);
    assert.equal(await s.port.agentInfo(id), null, id);
    assert.deepEqual(touched(s.remote, id), [], id);
  }
  assert.deepEqual([s.remote.sent, s.remote.responded, s.remote.rows], [[], [], []]);
});

test("SdkPort: a placement that was never proven is checked again before anything is sent", async () => {
  const s = setup();
  await s.port.listAgents();
  for (const id of ["theirs", "unlabelled"]) {
    s.port.hosts!.note(id, "srv_mac", "mac");
    await assert.rejects(() => s.port.send(id, "x"), /not ours/);
    await assert.rejects(() => s.port.respondToPermission(id, "p", { behavior: "allow" }), /not ours/);
    await assert.rejects(() => s.port.tailItems(id), /not ours/);
    assert.deepEqual(touched(s.remote, id), []);
  }
});

test("SdkPort: ours is reachable before any listing", async () => {
  const s = setup();
  await s.port.send("relayed", "hi");
  await s.port.send("started", "hi");
  assert.deepEqual(s.remote.sent.map((x) => x.id).sort(), OURS);
});

test("a recorded crew stays ours when its relay agent is archived later, across a restart too", async () => {
  const s = setup();
  await s.port.listAgents();
  s.local.agents.get("fm")!.archivedAt = AT;
  const next = s.again();
  assert.deepEqual(remoteIds(await next.listAgents()), OURS);
  await next.send("relayed", "still ours");
  assert.deepEqual(s.remote.sent.map((x) => x.text), ["still ours"]);
});

test("a failed lookup of the local relay claims nothing new and forgets nothing known", async () => {
  const s = setup();
  s.local.refreshFails.add("fm");
  assert.deepEqual(remoteIds(await s.port.listAgents()), ["started"]);
  await assert.rejects(() => s.port.send("relayed", "x"));
  s.local.refreshFails.clear();
  assert.deepEqual(remoteIds(await s.port.listAgents()), OURS, "claimed once the lookup works");
  s.local.refreshFails.add("fm");
  assert.deepEqual(remoteIds(await s.again().listAgents()), OURS, "known stays");
  assert.deepEqual(stored(s.root), OURS);
});

/** A store as written before ownership was checked, or by another daemon. */
function oldStore(root: string) {
  const rec = (id: string, over: object = {}) => ({ id, task: "t1", status: "idle", archived: false, createdAt: AT, lastActivityAt: AT, pending: 0, labels: REMOTE[id] ?? T, ...over });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(remoteStorePath(root), JSON.stringify({ version: 1, hosts: { srv_mac: { label: "mac", offlineSince: AT, agents: [rec("theirs"), rec("copied", { owner: "srv_other" }), rec("mine", { owner: "srv_local" })] } } }));
}

test("foreign records stored earlier are dropped, also while their host is away", async () => {
  const s = setup();
  oldStore(s.root);
  s.mac.status = "offline";
  assert.deepEqual(remoteIds(await s.port.listAgents()), ["mine"]);
  assert.doesNotMatch(readFileSync(remoteStorePath(s.root), "utf8"), /theirs|copied/);
  for (const id of ["theirs", "copied"]) assert.equal(s.port.hostOf(id), undefined, id);
});

test("a stored record of another daemon places nobody, before any listing", async () => {
  const s = setup();
  oldStore(s.root);
  await s.port.hosts!.list();
  assert.equal(s.port.hostOf("copied"), undefined);
  assert.equal(s.port.hostOf("theirs"), undefined);
  assert.equal(s.port.hostOf("mine")?.serverId, "srv_mac");
});

test("remote events of the real port: only our agents raise any", async () => {
  const s = setup();
  const ports = new PortSelector(new CliPort(async () => "[]"), () => {}, () => s.port);
  const seen: string[] = [];
  const remote = followRemoteEvents(ports, { emit: (_n, e) => seen.push((e as { agent: { id: string } }).agent.id), log: () => {} });
  ports.capture({ paseo: s.api }, "t");
  for (let i = 0; i < 300 && !s.remote.observers.size; i++) await new Promise((r) => setTimeout(r, 10));
  await remote.flush();
  for (const [id, labels] of Object.entries(REMOTE)) {
    s.remote.upsert({ id, bare: true, labels, status: "running", activeTurn: { turnId: "t1", startedAt: AT }, updatedAt: "2026-11-27T10:01:00.000Z" });
    s.remote.upsert({ id, bare: true, labels, status: "idle", activeTurn: null, updatedAt: "2026-11-27T10:02:00.000Z" });
  }
  await remote.flush();
  assert.deepEqual([...new Set(seen)].sort(), OURS);
  for (const id of FOREIGN) assert.deepEqual(touched(s.remote, id), [], id);
  remote.stop();
  s.port.hosts!.stop();
});

// ---------- the CLI ----------

const cliWorld = (): World => ({
  local: [crew("fm", "x", AT, { labels: { firstmate: "true" }, status: "idle" }), crew("old-fm", "x", AT, { labels: {}, archived: true })],
  hosts: [cliMac(Object.entries(REMOTE).map(([id, labels]) => crew(id, "t1", AT, { bare: true, labels, status: "idle" })))],
});
const cli = (w = cliWorld(), root = mkdtempSync(join(tmp(), "own-cli-"))) => {
  const f = fakeExec(w);
  return { w, root, f, port: new CliPort(f.exec, { root, serverId: "srv_local" }) };
};
const onThem = (calls: string[][], id: string) => calls.filter((c) => ["send", "logs"].includes(c[0]) && c[1] === id && c.includes("--host"));

test("CliPort lists and remembers only our agents on another host", async () => {
  const s = cli();
  assert.deepEqual(remoteIds(await s.port.listAgents({ includeArchived: true })), OURS);
  assert.deepEqual(remoteIds(await s.port.listAgents({ label: "firstmate=true" })), []);
  assert.deepEqual(stored(s.root), OURS);
  assert.ok(!s.f.calls.some((c) => c[0] === "inspect" && FOREIGN.includes(c[1])), "a foreign agent is not inspected");
});

test("CliPort never sends to or reads a foreign agent", async () => {
  const s = cli();
  for (const id of FOREIGN) {
    await assert.rejects(() => s.port.send(id, "x"), id);
    await assert.rejects(() => s.port.sweepInfo(id), id);
    await s.port.agentView(id);
    assert.deepEqual(onThem(s.f.calls, id), [], id);
  }
  await s.port.send("relayed", "x");
  assert.equal(onThem(s.f.calls, "relayed").length, 1);
});

test("CliPort: a failing local listing claims nothing new and forgets nothing known", async () => {
  const w = cliWorld();
  w.localLsFails = true;
  const s = cli(w);
  const remoteOnly = async (p: CliPort) => (await p.listAgents({ includeArchived: true }).catch(() => [])).filter((a) => a.serverId).map((a) => a.id).sort();
  await assert.rejects(() => s.port.send("relayed", "x"));
  delete w.localLsFails;
  assert.deepEqual(await remoteOnly(cli(w, s.root).port), OURS);
  w.localLsFails = true;
  await cli(w, s.root).port.send("relayed", "still ours");
  assert.deepEqual(stored(s.root), OURS);
});

test("CliPort: without its own server id, only the relay claims", async () => {
  const w = cliWorld();
  const port = new CliPort(fakeExec(w).exec, { root: mkdtempSync(join(tmp(), "own-cli-")), serverId: "" });
  assert.deepEqual(remoteIds(await port.listAgents()), ["relayed"]);
});
