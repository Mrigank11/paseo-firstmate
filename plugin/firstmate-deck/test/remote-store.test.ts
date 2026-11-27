import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteStore, recordHosts, remoteRecords, remoteStorePath, type HostSeen, type RemoteAgent } from "../server/remote-store.ts";

const T0 = new Date("2026-11-27T10:00:00Z");
const T1 = new Date("2026-11-27T11:00:00Z");
const T2 = new Date("2026-11-27T12:00:00Z");
const agent = (id: string, over: Partial<RemoteAgent> = {}): RemoteAgent => ({ id, task: "t1", status: "running", archived: false, createdAt: T0.toISOString(), lastActivityAt: T0.toISOString(), pending: 0, ...over });
const host = (over: Partial<HostSeen> = {}): HostSeen => ({ serverId: "srv_mac", label: "mac", online: true, agents: [agent("a1")], ...over });
const root = () => mkdtempSync(join(tmpdir(), "remote-store-"));

test("a missing or broken file is an empty store", () => {
  const r = root();
  assert.deepEqual(readRemoteStore(r), { version: 1, hosts: {} });
  mkdirSync(join(r, "state"), { recursive: true });
  writeFileSync(remoteStorePath(r), "{nope");
  assert.deepEqual(readRemoteStore(r), { version: 1, hosts: {} });
  rmSync(r, { recursive: true, force: true });
});

test("a listed host's records replace what was there, so a gone agent disappears", () => {
  const r = root();
  recordHosts(r, [host({ agents: [agent("a1"), agent("a2")] })], T0);
  recordHosts(r, [host({ agents: [agent("a2")] })], T1);
  assert.deepEqual(readRemoteStore(r).hosts.srv_mac.agents.map((a) => a.id), ["a2"]);
  assert.equal(readRemoteStore(r).hosts.srv_mac.offlineSince, null);
  rmSync(r, { recursive: true, force: true });
});

test("an offline (or unlisted) host keeps its last-known agents and remembers when it went", () => {
  const r = root();
  recordHosts(r, [host()], T0);
  recordHosts(r, [host({ online: false, agents: null })], T1);
  recordHosts(r, [host({ online: false, agents: null })], T2);
  const h = readRemoteStore(r).hosts.srv_mac;
  assert.deepEqual([h.agents.map((a) => a.id), h.offlineSince], [["a1"], T1.toISOString()]);
  // lastOnlineAt is when the host last CONNECTED: for a host seen online here, "since" is when it was first seen gone
  recordHosts(r, [host()], T2);
  recordHosts(r, [host({ online: false, agents: null, lastOnlineAt: T0.toISOString() })], T2);
  assert.equal(readRemoteStore(r).hosts.srv_mac.offlineSince, T2.toISOString());
  rmSync(r, { recursive: true, force: true });
});

test("a host never seen online here is offline since its lastOnlineAt", () => {
  const r = root();
  recordHosts(r, [host({ online: false, agents: null, lastOnlineAt: T0.toISOString() })], T2);
  recordHosts(r, [host({ online: false, agents: null, lastOnlineAt: T1.toISOString() })], T2);
  assert.equal(readRemoteStore(r).hosts.srv_mac.offlineSince, T0.toISOString());
  rmSync(r, { recursive: true, force: true });
});

test("a host no longer registered is dropped", () => {
  const r = root();
  recordHosts(r, [host()], T0);
  recordHosts(r, [], T1);
  assert.deepEqual(readRemoteStore(r).hosts, {});
  rmSync(r, { recursive: true, force: true });
});

test("records come out as agent records, marked with the host, offline ones as unknown", () => {
  const r = root();
  recordHosts(r, [host()], T0);
  assert.deepEqual(remoteRecords(readRemoteStore(r)).map((a) => [a.id, a.host, a.serverId, a.status, a.hostOffline]), [["a1", "mac", "srv_mac", "running", undefined]]);
  recordHosts(r, [host({ online: false, agents: null })], T1);
  assert.deepEqual(remoteRecords(readRemoteStore(r)).map((a) => [a.status, a.pending, a.hostOffline]), [["unknown", 0, { label: "mac", since: T1.toISOString() }]]);
  rmSync(r, { recursive: true, force: true });
});
