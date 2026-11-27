// bin/fleet stage(s) and the other CLI lookups see crews on other Paseo hosts: through stage-cli.ts, canvas-cmd.ts and
// page-tool.ts with a fake `paseo` (PASEO_BIN) and a temp daemon home holding the local agent files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crew, fakeBin, mac, MAC, type FakeAgent, type World } from "./fake-hosts.ts";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server");
const NOW = "2026-11-27T13:00:00Z";

const OLD = crew("e0e0e0e0-0000-4000-8000-000000000003", "lh", "2026-11-27T08:00:00Z", { status: "idle" });
const MAC_FIRST = crew("a0a0a0a0-0000-4000-8000-000000000002", "lh", "2026-11-27T12:00:00Z", { status: "idle" });
const MAC_NEW = crew("c0c0c0c0-0000-4000-8000-000000000001", "lh", "2026-11-27T12:48:00Z", { labels: { "fm.task": "lh", "canvas.relay": "fm-old" } });

function rig(w: World = { local: [OLD], hosts: [mac([MAC_FIRST, MAC_NEW])] }, tasks: object[] = [{ id: "lh", intent: "x", state: "active", since: "2026-11-27T07:00:00Z", project: "demo" }]) {
  const dir = mkdtempSync(join(tmpdir(), "deck-hosts-"));
  const root = join(dir, "root");
  const home = join(dir, "home");
  mkdirSync(join(root, "state", "projects", "demo"), { recursive: true });
  writeFileSync(join(root, "state", "projects", "demo", "project.json"), "{}");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks }));
  const files = (agents: FakeAgent[]) => {
    rmSync(join(home, "agents"), { recursive: true, force: true });
    mkdirSync(join(home, "agents", "shard"), { recursive: true });
    for (const a of agents) writeFileSync(join(home, "agents", "shard", `${a.id}.json`), JSON.stringify({ id: a.id, labels: a.labels ?? {}, createdAt: a.createdAt, lastStatus: a.status, ...(a.archived ? { archivedAt: a.createdAt } : {}) }));
  };
  files(w.local);
  const fake = fakeBin(dir, w);
  const env: Record<string, string> = { PASEO_BIN: fake.bin, PASEO_HOME: home, AGENT_CANVAS_URL: "off", STAGE_SNAPSHOT_WAIT_MS: "0", STAGE_AGENTS_JSON: "", STAGE_CANVAS_JSON: "", NODE_NO_WARNINGS: "1" };
  const run = (script: string, args: string[], more: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn("node", [join(server, script), ...args], { env: { ...process.env, ...env, ...more } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
  const cli = (args: string[], more?: Record<string, string>) => run("stage-cli.ts", [args[0], root, ...args.slice(1)], more);
  const stage = async (id = "lh", more?: Record<string, string>) => {
    const r = await cli(["stage", id], more);
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out);
  };
  const calls = (): string[][] => (existsSync(fake.calls) ? readFileSync(fake.calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const reset = () => rmSync(fake.calls, { force: true });
  const storeFile = join(root, "state", "remote-agents.json");
  const store = () => JSON.parse(readFileSync(storeFile, "utf8"));
  return { dir, root, home, fake, run, cli, stage, calls, reset, store, storeFile, files };
}

test("stage: the newest crew on another host is the task's agent, and the row names the host", async () => {
  const r = rig();
  const row = await r.stage();
  assert.deepEqual([row.agentId, row.host, row.stage, row.group], [MAC_NEW.id, "mac", "Running", "running"]);
  const table = (await r.cli(["stages", "--table"])).out;
  assert.match(table, /c0c0c0c0@mac/);
  assert.equal(r.store().hosts.srv_mac.agents.length, 2, "recorded for the offline case");
  assert.equal(r.store().hosts.srv_mac.target, MAC);
  for (const c of r.calls()) assert.ok(!(c.includes("--host") && c.includes("--home")), c.join(" "));
  assert.ok(r.calls().some((c) => c[0] === "host" && c.includes("--home") && c.includes(r.home)), "host ls asks the local daemon");
});

test("stage: a local agent newer than the other hosts' stays the task's agent, with no host", async () => {
  const newer = crew("local-new", "lh", "2026-11-27T12:59:00Z");
  const r = rig({ local: [OLD, newer], hosts: [mac([MAC_NEW])] });
  const row = await r.stage();
  assert.deepEqual([row.agentId, row.host], ["local-new", undefined]);
});

test("stage: an agent archived on its host is archived here too", async () => {
  const r = rig({ local: [OLD], hosts: [mac([{ ...MAC_NEW, archived: true, status: "closed" }])] });
  assert.equal((await r.stage()).agentId, OLD.id);
  assert.equal(r.store().hosts.srv_mac.agents[0].archived, true);
});

test("stage: a crew that appears between the two listings of its host is not taken for archived", async () => {
  const r = rig({ local: [OLD], hosts: [mac([{ ...MAC_NEW, unlisted: true }])] });
  const row = await r.stage();
  assert.deepEqual([row.agentId, row.stage], [MAC_NEW.id, "Running"]);
});

test("stage: a pending permission on another host's crew is the captain's", async () => {
  const r = rig({ local: [], hosts: [mac([{ ...MAC_NEW, pending: 1 }])] });
  const row = await r.stage();
  assert.deepEqual([row.stage, row.group, row.host], ["Needs you · permission", "you", "mac"]);
});

test("inspect: the age is paid for once (cached in the store); only running or idle crews of live tasks are inspected again", async () => {
  const gone = crew("mac-old-archived", "finished", "2026-11-20T10:00:00Z", { archived: true, status: "closed" });
  const r = rig({ local: [], hosts: [mac([MAC_NEW, gone])] });
  await r.stage();
  const inspected = () => r.calls().filter((c) => c[0] === "inspect").map((c) => c[1]).sort();
  assert.deepEqual(inspected(), [MAC_NEW.id, "mac-old-archived"].sort());
  r.reset();
  await r.stage();
  assert.deepEqual(inspected(), [MAC_NEW.id]);
});

test("inspect fails: the age comes from the listing's relative text, and is not cached as fact", async () => {
  const r = rig({ local: [OLD], hosts: [mac([{ ...MAC_NEW, created: "2 minutes ago" }], { inspectFails: true })] });
  const row = await r.stage();
  assert.deepEqual([row.agentId, row.host], [MAC_NEW.id, "mac"]);
  assert.equal(r.store().hosts.srv_mac.agents[0].createdAt, null);
});

test("offline host: its crews stay, as unknown, and nothing is asked of it", async () => {
  const w: World = { local: [OLD], hosts: [mac([MAC_NEW])] };
  const r = rig(w);
  await r.stage();
  r.fake.world({ local: [OLD], hosts: [mac([], { status: "offline", lastOnlineAt: NOW })] });
  r.reset();
  const row = await r.stage();
  assert.deepEqual([row.agentId, row.host, row.stage], [MAC_NEW.id, "mac", "Unknown · mac offline"]);
  assert.ok(!r.calls().some((c) => c.includes("--host")));
  assert.equal(r.store().hosts.srv_mac.offlineSince, NOW);
});

test("a disabled host keeps its crews as unknown", async () => {
  const r = rig({ local: [], hosts: [mac([MAC_NEW])] });
  await r.stage();
  r.fake.world({ local: [], hosts: [mac([MAC_NEW], { enabled: false })] });
  r.reset();
  assert.equal((await r.stage()).stage, "Unknown · mac offline");
  assert.ok(!r.calls().some((c) => c.includes("--host")));
});

test("a host that says online but cannot be listed, or never answers, is unknown and cannot hang the command", async () => {
  for (const broken of [{ lsFails: true }, { hangs: true }]) {
    const r = rig({ local: [OLD], hosts: [mac([MAC_NEW])] });
    await r.stage();
    r.fake.world({ local: [OLD], hosts: [mac([MAC_NEW], broken)] });
    const t0 = Date.now();
    const row = await r.stage("lh", { PASEO_HOST_TIMEOUT_MS: "1000" });
    assert.ok(Date.now() - t0 < 8000, "bounded");
    assert.deepEqual([row.agentId, row.stage], [MAC_NEW.id, "Unknown · mac offline"]);
  }
});

test("host ls fails: local agents as before, the store is not touched and its crews read as unknown", async () => {
  const r = rig();
  await r.stage();
  const before = readFileSync(r.storeFile, "utf8");
  r.fake.world({ local: [OLD], hosts: [], hostLsFails: true });
  r.reset();
  const row = await r.stage();
  assert.deepEqual([row.agentId, row.stage], [MAC_NEW.id, "Unknown · mac offline"]);
  assert.equal(readFileSync(r.storeFile, "utf8"), before);
  assert.ok(!r.calls().some((c) => c.includes("--host")));
  rmSync(r.storeFile);
  assert.deepEqual([(await r.stage()).agentId, existsSync(r.storeFile)], [OLD.id, false]);
});

test("no registered hosts: one extra `host ls`, nothing else", async () => {
  const r = rig({ local: [OLD], hosts: [] });
  assert.equal((await r.stage()).agentId, OLD.id);
  assert.deepEqual(r.calls().map((c) => c.filter((x) => x !== r.home).join(" ")).sort(), ["host ls --json --home", "ls -g --background --json --home"]);
  assert.equal(existsSync(r.storeFile), false);
});

test("task-of, agents and canvas-off know the crews of other hosts", async () => {
  const r = rig({ local: [OLD], hosts: [mac([MAC_FIRST, { ...MAC_NEW, labels: { "fm.task": "lh", canvas: "off" } }])] });
  assert.equal((await r.cli(["task-of", MAC_NEW.id])).out.trim(), "lh");
  assert.deepEqual(JSON.parse((await r.cli(["agents", "lh"])).out), [OLD.id, MAC_FIRST.id, MAC_NEW.id]);
  assert.equal((await r.cli(["canvas-off", "lh"])).out.trim(), "off");
  r.fake.world({ local: [OLD], hosts: [mac([], { status: "offline" })] });
  assert.equal((await r.cli(["task-of", MAC_NEW.id])).out.trim(), "lh", "from the store while the host is away");
});

test("task-of a local agent asks no host", async () => {
  const fm: FakeAgent = { id: "fm-1", createdAt: NOW };
  const r = rig({ local: [OLD, fm], hosts: [mac([MAC_NEW])] });
  assert.equal((await r.cli(["task-of", OLD.id])).out.trim(), "lh");
  assert.equal((await r.cli(["task-of", "fm-1"])).out.trim(), "");
  assert.ok(!r.calls().some((c) => c[0] === "host" || c.includes("--host")));
});

test("claim re-label list: crews on other hosts are listed; a live first mate is not 'gone' for them", async () => {
  const r = rig();
  const res = await r.run("canvas-cmd.ts", ["relabel", r.root, "fm-new"]);
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(res.out.trim().split("\n"), [MAC_NEW.id]);
  assert.ok((await r.stage()).flags.some((f: any) => f.key === "relay-target-gone"), "fm-old runs nowhere");
  r.fake.world({ local: [OLD, { id: "fm-old", createdAt: NOW }], hosts: [mac([MAC_FIRST, MAC_NEW])] });
  assert.ok(!(await r.stage()).flags.some((f: any) => f.key === "relay-target-gone"));
});

test("page status: drift counts a crew running on another host", async () => {
  const r = rig({ local: [], hosts: [mac([MAC_NEW])] }, [{ id: "lh", intent: "x", state: "queued", project: "demo" }]);
  const res = await r.run("page-tool.ts", ["status", r.root]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.err, /drift: lh \(demo\) is Running/);
});
