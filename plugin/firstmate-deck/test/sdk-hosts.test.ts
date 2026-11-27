// SdkPort across hosts: the merged agent list, routing every per-agent call to the owning host, and last-known records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector, resolveFirstMate, SdkPort, type SdkPortOptions } from "../server/paseo-port.ts";
import { readRemoteStore } from "../server/remote-store.ts";
import { assistant, FakeHosts, FakeWorld, fakePaseo, type FakeHost } from "./fake-paseo.ts";
import { tmp } from "./tmp.ts";

const OLD = "2026-11-25T10:00:00.000Z";
const MID = "2026-11-26T10:00:00.000Z";
const NEW = "2026-11-27T10:00:00.000Z";
const CREW = { "fm.task": "demo-ux-task" };

function setup(o: SdkPortOptions = {}) {
  const root = mkdtempSync(join(tmp(), "sdkhosts-"));
  const local = new FakeWorld().add(
    { id: "local-old", status: "idle", labels: CREW, createdAt: OLD },
    { id: "fm", status: "idle", labels: { firstmate: "true" }, createdAt: OLD },
  );
  const remote = new FakeWorld().add(
    { id: "mac-old", status: "idle", labels: CREW, createdAt: MID },
    { id: "mac-new", status: "running", labels: CREW, createdAt: NEW, background: true, cwd: "/Users/m/wt", items: [assistant("DONE: on mac")] },
    { id: "mac-gone", status: "closed", labels: CREW, createdAt: OLD, archivedAt: MID },
    { id: "mac-plain", status: "idle", labels: { firstmate: "true" }, createdAt: NEW },
  );
  const mac: FakeHost = { serverId: "srv_mac", label: "mac", world: remote };
  const hosts = new FakeHosts(mac);
  const api = fakePaseo(local, hosts);
  const opts = { root: () => root, ttlMs: 0, patienceMs: 30, timeoutMs: 60, cooldownMs: 0, ...o };
  const port = new SdkPort(api, opts);
  return { root, local, remote, mac, hosts, api, port, again: () => new SdkPort(api, opts) };
}
const ids = (xs: { id: string }[]) => xs.map((a) => a.id).sort();

test("listAgents merges every online host's agents, background ones too, each marked with its host", async () => {
  const s = setup();
  const l = await s.port.listAgents({ label: "fm.task" });
  assert.deepEqual(ids(l), ["local-old", "mac-new", "mac-old"]);
  const m = l.find((a) => a.id === "mac-new")!;
  assert.deepEqual([m.host, m.serverId, m.status, m.hostOffline], ["mac", "srv_mac", "running", undefined]);
  assert.equal(l.find((a) => a.id === "local-old")!.host, undefined);
  assert.deepEqual(ids(await s.port.listAgents({ label: "fm.task=demo-ux-task", includeArchived: true })), ["local-old", "mac-gone", "mac-new", "mac-old"]);
  assert.deepEqual(ids(await s.port.listAgents({ label: "firstmate=true" })), ["fm", "mac-plain"]);
});

test("listAgents local: only this daemon's agents, and no host is asked", async () => {
  const s = setup();
  assert.deepEqual(ids(await s.port.listAgents({ local: true })), ["fm", "local-old"]);
  assert.equal(s.hosts.lists, 0);
});

test("the first mate is never an agent of another host", async () => {
  const s = setup();
  const ports = new PortSelector(new CliPort(async () => "[]"), () => {}, () => s.port);
  ports.capture({ paseo: s.api }, "t");
  assert.equal((await resolveFirstMate(ports.current(), "firstmate=true"))!.id, "fm");
  mkdirSync(join(s.root, "state"), { recursive: true });
  writeFileSync(join(s.root, "state", "firstmate.json"), JSON.stringify({ agentId: "mac-plain" }));
  s.local.agents.delete("fm");
  assert.equal(await resolveFirstMate(ports.current(), "firstmate=true", s.root), null);
});

test("every per-agent call goes to the owning host", async () => {
  const s = setup();
  await s.port.listAgents();
  assert.equal((await s.port.agentView("mac-new")).final, "DONE: on mac");
  assert.deepEqual(await s.port.agentInfo("mac-new").then((i) => [i!.status, i!.serverId, i!.host, i!.cwd]), ["running", "srv_mac", "mac", "/Users/m/wt"]);
  assert.equal((await s.port.tailItems("mac-new")).length, 1);
  await s.port.send("mac-new", "hello");
  await s.port.respondToPermission("mac-new", "p1", { behavior: "allow" });
  await s.port.appendTimelineRow("mac-new", "r1", { project: "p", pageUrl: null, at: NEW, comments: [], replied: false });
  assert.deepEqual(s.remote.sent.map((x) => x.text), ["hello"]);
  assert.deepEqual(s.remote.responded.map((x) => x.requestId), ["p1"]);
  assert.equal(s.remote.rows.length, 1);
  assert.equal(s.local.sent.length + s.local.responded.length + s.local.rows.length, 0);
  assert.equal(s.local.calls.filter((c) => c.endsWith(":mac-new")).length, 0, "the local daemon is never asked about a remote agent");
});

test("an agent not listed yet is found on its host; a local one never leaves this daemon", async () => {
  const s = setup();
  assert.equal((await s.port.agentInfo("mac-new"))!.serverId, "srv_mac");
  const t = setup();
  await t.port.send("mac-old", "x");
  assert.deepEqual(t.remote.sent.map((x) => x.id), ["mac-old"]);
  const u = setup();
  assert.equal((await u.port.agentInfo("local-old"))!.serverId, undefined);
  await u.port.send("fm", "y");
  assert.equal(u.hosts.lists, 0);
  assert.equal(await u.port.agentInfo("nobody"), null);
});

test("after a restart the owner is known from the persisted store, before any list call", async () => {
  const s = setup();
  await s.port.listAgents({ label: "fm.task" });
  assert.deepEqual(ids(readRemoteStore(s.root).hosts.srv_mac.agents), ["mac-gone", "mac-new", "mac-old"]);
  const port = s.again();
  s.remote.calls.length = 0;
  s.local.calls.length = 0;
  await port.send("mac-new", "after restart");
  assert.deepEqual(s.remote.calls, ["send:mac-new"]);
  assert.deepEqual(s.local.calls, []);
});

test("an offline host's crews stay, unknown, with since when; never gone or closed", async () => {
  const s = setup();
  await s.port.listAgents();
  s.mac.status = "offline";
  s.mac.lastOnlineAt = "2026-11-27T11:00:00.000Z";
  const l = await s.again().listAgents({ label: "fm.task" });
  assert.deepEqual(ids(l), ["local-old", "mac-new", "mac-old"]);
  const m = l.find((a) => a.id === "mac-new")!;
  assert.deepEqual([m.status, m.pendingPermissions, m.host, m.serverId, m.createdAt, m.labels["fm.task"]], ["unknown", 0, "mac", "srv_mac", NEW, "demo-ux-task"]);
  assert.deepEqual(m.hostOffline, { label: "mac", since: "2026-11-27T11:00:00.000Z" });
  await assert.rejects(s.again().send("mac-new", "x"), /mac is unavailable/);
  assert.equal(s.local.sent.length, 0);
});

test("a failed list on an online host is the same unknown, with a stable since", async () => {
  const s = setup();
  await s.port.listAgents();
  s.remote.listFails = true;
  const a = (await s.port.listAgents({ label: "fm.task" })).find((x) => x.id === "mac-new")!;
  await new Promise((r) => setTimeout(r, 5));
  const b = (await s.port.listAgents({ label: "fm.task" })).find((x) => x.id === "mac-new")!;
  assert.equal(a.status, "unknown");
  assert.ok(a.hostOffline?.since);
  assert.equal(b.hostOffline!.since, a.hostOffline!.since);
  s.remote.listFails = false;
  const c = (await s.port.listAgents({ label: "fm.task" })).find((x) => x.id === "mac-new")!;
  assert.deepEqual([c.status, c.hostOffline], ["running", undefined]);
});

test("a hung host never stalls the list: it answers with what it knows, quickly", async () => {
  const s = setup({ timeoutMs: 5000, patienceMs: 30 });
  await s.port.listAgents();
  s.remote.hang = true;
  const t0 = Date.now();
  const l = await s.port.listAgents({ label: "fm.task" });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(ids(l), ["local-old", "mac-new", "mac-old"]);
});

test("a host that hung and timed out reads as unknown and does not stall the next list", async () => {
  const s = setup({ timeoutMs: 20, patienceMs: 10, cooldownMs: 60_000 });
  await s.port.listAgents();
  s.remote.hang = true;
  await s.port.listAgents();
  await new Promise((r) => setTimeout(r, 50));
  const l = await s.port.listAgents({ label: "fm.task" });
  assert.equal(l.find((a) => a.id === "mac-new")!.status, "unknown");
});

test("when the host directory cannot be read, remembered crews are unknown, not gone", async () => {
  const s = setup();
  await s.port.listAgents();
  s.hosts.listFails = true;
  const l = await s.again().listAgents({ label: "fm.task" });
  assert.deepEqual(ids(l), ["local-old", "mac-new", "mac-old"]);
  assert.equal(l.find((a) => a.id === "mac-new")!.status, "unknown");
});

test("a send to a remote agent that fails is not retried through the CLI (it may have arrived)", async () => {
  const s = setup();
  const cli: string[][] = [];
  const ports = new PortSelector(new CliPort(async (a) => { cli.push(a); return ""; }), () => {}, () => s.port);
  ports.capture({ paseo: s.api }, "t");
  await s.port.listAgents();
  s.remote.sendFails = true;
  await assert.rejects(ports.send("mac-new", "x"), /daemon down/);
  assert.deepEqual(cli, []);
  s.local.sendFails = true;
  await ports.send("fm", "y");
  assert.equal(cli.length, 1);
});

test("a changed handle gets its own port and the old hosts are stopped", async () => {
  const s = setup();
  const ports = new PortSelector(new CliPort(async () => "[]"));
  let seen = 0;
  ports.onHandle = () => { seen++; };
  ports.capture({ paseo: s.api }, "a");
  await ports.sdkPort()!.listAgents();
  const first = ports.sdkPort()!.hosts!;
  ports.capture({ paseo: s.api }, "again");
  assert.equal(seen, 1);
  ports.capture({ paseo: fakePaseo(s.local, s.hosts) }, "b");
  assert.equal(seen, 2);
  assert.notEqual(ports.sdkPort()!.hosts, first);
  assert.equal(await first.client("srv_mac"), null);
});
