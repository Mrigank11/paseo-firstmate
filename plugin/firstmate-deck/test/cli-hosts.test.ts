// CliPort and the cold-start listing (the plugin before it has an SDK handle) see and reach crews on other Paseo hosts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliPort, makeExec } from "../server/paseo-cli.ts";
import { coldLabelled } from "../server/cold-agents.ts";
import { crew, fakeExec, mac, MAC, SELF, type World } from "./fake-hosts.ts";

// this daemon's home: its server id says which agents on other hosts are ours
process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "deck-clip-home-"));
writeFileSync(join(process.env.PASEO_HOME, "server-id"), `${SELF}\n`);

const LOCAL = crew("local-1", "lh", "2026-11-27T08:00:00Z", { status: "idle" });
const REMOTE = crew("mac-1", "lh", "2026-11-27T12:00:00Z", { labels: { "fm.task": "lh", "fm.notify": "plugin" }, pending: 1 });
const world = (): World => ({ local: [LOCAL], hosts: [mac([REMOTE])] });
const root = () => mkdtempSync(join(tmpdir(), "deck-clip-"));
const offline = (w: World) => { w.hosts[0].status = "offline"; };

test("listAgents: crews of online hosts come with their host; local ones are aged so the newest can be told", async () => {
  const f = fakeExec(world());
  const list = await new CliPort(f.exec, { root: root() }).listAgents({ label: "fm.task=lh" });
  assert.deepEqual(list.map((a) => [a.id, a.host, a.serverId, a.status, a.createdAt]), [
    ["local-1", undefined, undefined, "idle", "2026-11-27T08:00:00Z"],
    ["mac-1", "mac", "srv_mac", "running", "2026-11-27T12:00:00Z"],
  ]);
  assert.equal(list[1].pendingPermissions, 1);
  assert.equal(list[1].labels["fm.task"], "lh");
});

test("listAgents: every host's agents match the label, crews or not, unless `local` asks for this daemon only", async () => {
  const w = world();
  w.hosts[0].agents.push({ id: "mac-fm", createdAt: "2026-11-27T12:30:00Z", labels: { firstmate: "true" } });
  const f = fakeExec(w);
  const dir = root();
  const port = new CliPort(f.exec, { root: dir });
  assert.deepEqual((await port.listAgents({ label: "fm.notify=plugin" })).map((a) => a.id), ["mac-1"]);
  assert.deepEqual((await port.listAgents({ label: "firstmate=true" })).map((a) => [a.id, a.host]), [["mac-fm", "mac"]]);
  assert.deepEqual((await port.listAgents()).map((a) => a.id).sort(), ["local-1", "mac-1", "mac-fm"]);
  assert.doesNotMatch(readFileSync(join(dir, "state", "remote-agents.json"), "utf8"), /mac-fm/, "only crews are remembered");
  f.calls.length = 0;
  const here = new CliPort(f.exec);
  assert.deepEqual((await here.listAgents({ local: true })).map((a) => a.id), ["local-1"]);
  assert.deepEqual((await here.listAgents({ label: "firstmate=true", local: true })).map((a) => a.id), []);
  assert.ok(!f.calls.some((c) => c[0] === "host" || c.includes("--host")), "a local listing asks no host");
});

test("listAgents: archived crews only with includeArchived", async () => {
  const w = world();
  w.hosts[0].agents.push(crew("mac-old", "lh", "2026-11-26T00:00:00Z", { archived: true, status: "closed" }));
  const port = new CliPort(fakeExec(w).exec);
  assert.ok(!(await port.listAgents()).some((a) => a.id === "mac-old"));
  assert.equal((await port.listAgents({ includeArchived: true })).find((a) => a.id === "mac-old")?.archived, true);
});

test("listAgents: an offline host's crews are unknown (from the store); a failing host never fails the local part", async () => {
  const dir = root();
  const w = world();
  await new CliPort(fakeExec(w).exec, { root: dir }).listAgents();
  offline(w);
  const away = (await new CliPort(fakeExec(w).exec, { root: dir }).listAgents()).find((a) => a.id === "mac-1")!;
  assert.deepEqual([away.status, away.host, away.hostOffline?.label], ["unknown", "mac", "mac"]);
  w.hostLsFails = true;
  assert.deepEqual((await new CliPort(fakeExec(w).exec).listAgents()).map((a) => a.id), ["local-1"]);
});

test("send, agentView and sweepInfo reach a remote crew through --host, and a local one without it", async () => {
  const f = fakeExec(world());
  const port = new CliPort(f.exec);
  await port.listAgents();
  f.calls.length = 0;
  await port.send("mac-1", "hello");
  const view = await port.agentView("mac-1");
  const info = await port.sweepInfo("mac-1");
  assert.equal(view.status, "running");
  assert.equal(info.finalLine, "DONE: from mac");
  for (const c of f.calls.filter((c) => ["send", "inspect", "logs"].includes(c[0]))) assert.equal(c[c.indexOf("--host") + 1], MAC, c.join(" "));
  f.calls.length = 0;
  await port.send("local-1", "hello");
  assert.ok(!f.calls.some((c) => c.includes("--host")));
});

test("ownership is learnt from the store after a restart, or from a listing when nothing is known", async () => {
  const dir = root();
  await new CliPort(fakeExec(world()).exec, { root: dir }).listAgents();
  const stored = fakeExec(world());
  await new CliPort(stored.exec, { root: dir }).send("mac-1", "x");
  assert.deepEqual(stored.calls.filter((c) => c[0] === "send").map((c) => c.includes("--host")), [true], "no wasted local try");
  const cold = fakeExec(world());
  const port = new CliPort(cold.exec);
  await port.send("mac-1", "x");
  assert.deepEqual(cold.calls.filter((c) => c[0] === "send").map((c) => c.includes("--host")), [false, true]);
  assert.equal((await new CliPort(fakeExec(world()).exec).sweepInfo("mac-1")).finalLine, "DONE: from mac");
  assert.equal((await new CliPort(fakeExec(world()).exec).agentView("mac-1")).status, "running");
});

test("send to a crew on an offline host fails and sends nothing; an unknown id keeps the local error", async () => {
  const dir = root();
  const w = world();
  await new CliPort(fakeExec(w).exec, { root: dir }).listAgents();
  offline(w);
  const f = fakeExec(w);
  await assert.rejects(new CliPort(f.exec, { root: dir }).send("mac-1", "x"), /mac.*offline/);
  assert.ok(!f.calls.some((c) => c[0] === "send"));
  await assert.rejects(new CliPort(fakeExec(world()).exec).send("nobody", "x"), /AGENT_NOT_FOUND/);
});

test("cold start: labelled agents include other hosts' crews, offline ones from the store", async () => {
  const dir = root();
  writeFileSync(join(dir, "server-id"), `${SELF}\n`); // the agents directory's daemon home
  const agents = join(dir, "agents");
  mkdirSync(join(agents, "s"), { recursive: true });
  writeFileSync(join(agents, "s", "local-1.json"), JSON.stringify({ id: "local-1", labels: LOCAL.labels, createdAt: LOCAL.createdAt }));
  const w = world();
  const on = await coldLabelled(agents, "fm.task", fakeExec(w).exec, dir);
  assert.deepEqual(on.map((a) => [a.id, a.host]), [["local-1", undefined], ["mac-1", "mac"]]);
  offline(w);
  const off = await coldLabelled(agents, "fm.task", fakeExec(w).exec, dir);
  assert.deepEqual(off.map((a) => [a.id, a.status]), [["local-1", "idle"], ["mac-1", "unknown"]]);
});

test("makeExec: --home names the local daemon, and is left off a call for another host", async () => {
  const dir = root();
  const bin = join(dir, "paseo");
  writeFileSync(bin, `#!/bin/sh\necho "$@"\n`);
  chmodSync(bin, 0o755);
  const was = process.env.PASEO_BIN;
  process.env.PASEO_BIN = bin;
  try {
    const exec = makeExec("/some/home");
    assert.equal((await exec(["ls"])).trim(), "ls --home /some/home");
    assert.equal((await exec(["ls", "--host", MAC])).trim(), `ls --host ${MAC}`);
  } finally {
    if (was === undefined) delete process.env.PASEO_BIN; else process.env.PASEO_BIN = was;
  }
});

test("a closed remote agent's log is never read (that would load it on its host)", async () => {
  const w = world();
  w.hosts[0].agents[0].status = "closed";
  const f = fakeExec(w);
  const port = new CliPort(f.exec);
  await port.listAgents();
  assert.equal((await port.sweepInfo("mac-1")).finalLine, null);
  const v = await port.agentView("mac-1");
  assert.deepEqual([v.status, v.stepCount], ["closed", 0]);
  assert.ok(!f.calls.some((c) => c[0] === "logs"));
});
