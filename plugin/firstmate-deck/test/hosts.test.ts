import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Hosts } from "../server/hosts.ts";
import { recordHosts } from "../server/remote-store.ts";
import { FakeHosts, FakeWorld, fakePaseo, type FakeHost } from "./fake-paseo.ts";
import { tmp } from "./tmp.ts";

const mac = (over: Partial<FakeHost> = {}): FakeHost => ({ serverId: "srv_mac", label: "mac", world: new FakeWorld(), ...over });
const clock = () => { let t = 1_000_000; return { now: () => t, pass: (ms: number) => { t += ms; } }; };
const make = (fh: FakeHosts, o: ConstructorParameters<typeof Hosts>[1] = {}) => new Hosts(fakePaseo(new FakeWorld(), fh), o);

test("list: every registered host but this one, cached for the TTL", async () => {
  const fh = new FakeHosts(mac(), mac({ serverId: "srv_old", label: "old", status: "offline", lastOnlineAt: "2026-11-26T00:00:00Z" }), mac({ serverId: "srv_local", label: "me" }));
  const c = clock();
  const h = make(fh, { ttlMs: 1000, now: c.now });
  const l = await h.list();
  assert.deepEqual(l!.map((x) => [x.serverId, x.label, x.online, x.enabled, x.target]), [["srv_mac", "mac", true, true, "tcp://mac:6767"], ["srv_old", "old", false, true, "tcp://old:6767"]]);
  await h.list();
  assert.equal(fh.lists, 1);
  c.pass(1001);
  await h.list();
  assert.equal(fh.lists, 2);
  assert.deepEqual(h.offline().map((x) => x.serverId), ["srv_old"]);
});

test("clients: only online, enabled hosts; the client is built once and kept", async () => {
  const m = mac();
  const fh = new FakeHosts(m, mac({ serverId: "b", status: "offline" }), mac({ serverId: "c", enabled: false }));
  const h = make(fh);
  const a = await h.clients();
  const b = await h.clients();
  assert.deepEqual(a.map((x) => [x.serverId, x.label]), [["srv_mac", "mac"]]);
  assert.equal(a[0].api, b[0].api);
  assert.equal(m.built, 1);
  assert.equal(await h.client("b"), null);
  assert.equal(await h.client("nope"), null);
});

test("a daemon without hosts, or one whose host list fails, has no clients and a null list", async () => {
  const none = new Hosts(fakePaseo(new FakeWorld()));
  assert.equal(none.supported, false);
  assert.equal(await none.list(), null);
  assert.deepEqual(await none.clients(), []);
  const fh = new FakeHosts(mac());
  fh.listFails = true;
  const h = make(fh);
  assert.equal(await h.list(), null);
  assert.deepEqual(await h.clients(), []);
});

test("a failed call drops the client; the next one is built afresh and onChange says so", async () => {
  const m = mac();
  const h = make(new FakeHosts(m));
  let changes = 0;
  h.onChange(() => changes++);
  const first = (await h.client("srv_mac"))!.api;
  await assert.rejects(h.call("srv_mac", async () => { throw new Error("link closed"); }), /mac: link closed/);
  assert.equal(m.disposed, 1);
  const second = (await h.client("srv_mac"))!.api;
  assert.notEqual(second, first);
  await new Promise((r) => setImmediate(r));
  assert.equal(changes, 1);
});

test("an error about one agent keeps the host's client: only the link failing drops it", async () => {
  const m = mac();
  const h = make(new FakeHosts(m), { cooldownMs: 0 });
  const first = (await h.client("srv_mac"))!.api;
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });
  for (const e of [new Error("agent x not found"), named("DaemonRpcError", "Agent is closed requestType=send_agent_message_request"), new Error("sendAgentMessage rejected"), new Error("agent x is not ours: leaving it alone"), new Error("no such permission request")]) {
    await assert.rejects(h.call("srv_mac", async () => { throw e; }), new RegExp(`mac: ${e.message.slice(0, 10)}`));
  }
  assert.equal(m.disposed ?? 0, 0);
  assert.equal((await h.client("srv_mac"))!.api, first);
  const down = [
    new Error("Daemon client closed"), new Error("Daemon client is disposed"), new Error("Transport not connected (status: disconnected)"), new Error("Transport disconnected before connect"),
    new Error("The managing daemon is offline"), new Error("Host srv_mac is offline"), new Error("Paseo API is disposed"), new Error("WebSocket not open (readyState=3)"),
    new Error("fetch_agents_request timed out (10000ms)"), new Error("Timeout waiting for message"), named("DaemonConnectionError", "gone"), named("PingTimeoutError", "no pong"),
    new Error("connect ECONNRESET 100.1.1.1:6767"),
  ];
  for (const e of down) {
    const before = m.disposed ?? 0;
    await assert.rejects(h.call("srv_mac", async () => { throw e; }));
    assert.equal(m.disposed, before + 1, e.message);
  }
});

test("a call that hangs times out, and the host is left alone for the cool-down", async () => {
  const m = mac();
  const c = clock();
  const h = make(new FakeHosts(m), { timeoutMs: 20, cooldownMs: 5000, now: c.now });
  await assert.rejects(h.call("srv_mac", () => new Promise(() => {})), /timed out/);
  assert.equal(await h.client("srv_mac"), null);
  await assert.rejects(h.call("srv_mac", async () => 1), /mac is unavailable/);
  c.pass(5001);
  assert.equal(await h.call("srv_mac", async () => 1), 1);
  assert.equal(m.built, 2);
});

test("a host going offline drops its client and fires onChange", async () => {
  const m = mac();
  const c = clock();
  const h = make(new FakeHosts(m), { ttlMs: 10, now: c.now });
  let changes = 0;
  h.onChange(() => changes++);
  await h.client("srv_mac");
  m.status = "offline";
  c.pass(11);
  assert.deepEqual(await h.clients(), []);
  assert.equal(m.disposed, 1);
  assert.equal(changes, 1);
});

test("observe: a pushed directory applies without waiting for the TTL", async () => {
  const m = mac();
  const fh = new FakeHosts(m);
  const api = fakePaseo(new FakeWorld(), fh) as any;
  let observer: any;
  let released = 0;
  api.hosts.observe = () => ({ subscribe: (o: any) => { observer = o; return () => {}; }, release: async () => { released++; } });
  const h = new Hosts(api, { ttlMs: 60_000 });
  let changes = 0;
  h.onChange(() => changes++);
  await h.list();
  const dir = await api.hosts.list();
  dir.hosts[0].status = "offline";
  observer.update({ type: "hosts.changed", payload: { subscriptionId: "s", directory: dir } });
  assert.deepEqual(h.offline().map((x) => x.serverId), ["srv_mac"]);
  assert.equal(changes, 1);
  h.stop();
  assert.equal(released, 1);
});

test("hostOf: noted ids, and ids learned from the persisted store before any list call", () => {
  const root = mkdtempSync(join(tmp(), "hosts-"));
  recordHosts(root, [{ serverId: "srv_mac", label: "mac", online: true, agents: [{ id: "mac-1", task: "t", status: "running", archived: false, createdAt: null, lastActivityAt: null, pending: 0, owner: "srv_local" }] }]);
  const h = make(new FakeHosts(mac()), { root: () => root });
  assert.deepEqual(h.hostOf("mac-1"), { serverId: "srv_mac", label: "mac" });
  assert.equal(h.hostOf("local-1"), undefined);
  h.note("new-1", "srv_mac", "mac");
  assert.deepEqual(h.hostOf("new-1"), { serverId: "srv_mac", label: "mac" });
});

test("stop disposes every client and hands out no more", async () => {
  const m = mac();
  const h = make(new FakeHosts(m));
  await h.client("srv_mac");
  h.stop();
  assert.equal(m.disposed, 1);
  assert.equal(await h.client("srv_mac"), null);
});
