import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector } from "../server/paseo-port.ts";
import { Permission, requestJson, type PermissionEntry, type PermissionEvent } from "../server/permission.ts";
import { FakeWorld, fakePaseo } from "./fake-paseo.ts";

const RULES = (mode: string, extra: object = {}) => "# d\n\n- notify: plugin\n\n```json fm-permission-rules\n" + JSON.stringify({
  mode, allowKinds: ["tool"], read: true, writeWithin: ["$WORKTREE", "$ROOT/state/tasks/$TASK"],
  shell: { allow: ["^git (status|log|diff|show)( |$)", "^(ls|cat) "], denyChars: ";&|><`$()" }, fetchHosts: [], ...extra,
}) + "\n```\n";
const CREW = { "fm.task": "t1", "fm.project": "p", "fm.shape": "ship", "fm.notify": "plugin" };

function setup(o: { mode?: string; decisions?: string | null; labels?: Record<string, string> } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "permhook-")));
  const home = join(base, "home");
  const wt = join(home, "worktrees", "x", "crew");
  const root = join(base, "fm");
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  if (o.decisions !== null) writeFileSync(join(root, "state", "decisions.md"), o.decisions ?? RULES(o.mode ?? "shadow"));
  const world = new FakeWorld().add({ id: "crew", labels: o.labels ?? CREW, status: "running", cwd: wt }, { id: "fm", labels: { firstmate: "true" } });
  const ports = new PortSelector(new CliPort(async () => "[]"), () => {});
  ports.capture({ paseo: fakePaseo(world) }, "test");
  const perm = new Permission({ ports, root: () => root, paseoHome: home, log: () => {}, retryDelayMs: 1 });
  const log = (): PermissionEntry[] => { try { return readFileSync(join(root, "state", "permission-log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const ev = (id: string, detail: object | undefined, kind = "tool"): PermissionEvent => ({ agent: { id: "crew", parentAgentId: "fm" }, request: { id, kind, name: "Tool", ...(detail ? { detail } : {}) } as never });
  return { base, wt, root, world, perm, log, ev };
}

test("shadow: a safe read and an in-worktree write are would-allow; nothing is answered or sent", async () => {
  const s = setup();
  await s.perm.onRequested(s.ev("r1", { type: "read", filePath: "/etc/hosts" }));
  await s.perm.onRequested(s.ev("r2", { type: "write", filePath: join(s.wt, "a.txt") }));
  assert.deepEqual(s.log().map((e) => [e.requestId, e.decision, e.result, e.acted, e.mode]), [["r1", "would-allow", "logged", false, "shadow"], ["r2", "would-allow", "logged", false, "shadow"]]);
  assert.equal(s.world.responded.length, 0);
  assert.equal(s.world.sent.length, 0);
});

test("shadow: a write outside the worktree and a fetch escalate and wake the first mate with the request", async () => {
  const s = setup();
  await s.perm.onRequested(s.ev("r3", { type: "write", filePath: join(s.base, "elsewhere.txt"), content: "SECRET".repeat(1000) }));
  await s.perm.onRequested(s.ev("r4", { type: "fetch", url: "https://example.com/x" }));
  const log = s.log();
  assert.deepEqual(log.map((e) => [e.decision, e.result, e.acted, e.note]), [["escalate", "woke", true, "fm"], ["escalate", "woke", true, "fm"]]);
  assert.equal(s.world.sent.length, 2);
  const m = s.world.sent[0];
  assert.equal(m.id, "fm");
  assert.match(m.text, /^## Crew PERMISSION · t1\nwrite: .*elsewhere\.txt\nescalated by rule: write outside writeWithin .* \(shadow mode\)\nagent crew · ship · project p · request r3\n\{/);
  assert.ok(!m.text.includes("SECRET"), "bulky payload is dropped");
  assert.deepEqual(m.options, { activeTurnBehavior: "steer" });
  assert.equal(s.world.responded.length, 0);
});

test("enforce: safe requests are allowed through the SDK, unsafe ones are escalated and never answered", async () => {
  const s = setup({ mode: "enforce" });
  await s.perm.onRequested(s.ev("r1", { type: "read", filePath: "/etc/hosts" }));
  await s.perm.onRequested(s.ev("r2", { type: "shell", command: "rm -rf /" }));
  assert.deepEqual(s.world.responded, [{ id: "crew", requestId: "r1", response: { behavior: "allow" } }]);
  assert.deepEqual(s.log().map((e) => [e.decision, e.result]), [["allow", "responded"], ["escalate", "woke"]]);
});

test("enforce: a failed response is logged and not retried as a deny; the request stays pending", async () => {
  const s = setup({ mode: "enforce" });
  s.world.respondFails = true;
  await s.perm.onRequested(s.ev("r1", { type: "read", filePath: "/x" }));
  const [e] = s.log();
  assert.deepEqual([e.decision, e.result, e.acted], ["allow", "respond-failed", false]);
});

test("missing or broken rules: everything escalates (even a read), mode counts as shadow, and problem() says why", async () => {
  for (const decisions of [null, "# no block", RULES("shadow").replace('"read":true', '"read":')]) {
    const s = setup({ decisions });
    assert.match(s.perm.problem() ?? "", /every request escalates/);
    await s.perm.onRequested(s.ev("r1", { type: "read", filePath: "/x" }));
    const [e] = s.log();
    assert.equal(e.decision, "escalate", String(decisions));
    assert.match(e.rule, /rules unusable/);
    assert.equal(s.world.responded.length, 0);
  }
  assert.equal(setup().perm.problem(), null);
});

test("questions and plans always escalate", async () => {
  const s = setup({ mode: "enforce" });
  await s.perm.onRequested(s.ev("q1", undefined, "question"));
  assert.equal(s.log()[0].decision, "escalate");
  assert.equal(s.world.responded.length, 0);
});

test("non-crew agents are ignored; without fm.notify=plugin an escalation is logged, not sent", async () => {
  const s = setup({ labels: { foo: "bar" } });
  await s.perm.onRequested(s.ev("r1", { type: "read", filePath: "/x" }));
  assert.deepEqual(s.log(), []);
  const t = setup({ labels: { "fm.task": "t1" } });
  await t.perm.onRequested(t.ev("r1", { type: "fetch", url: "https://example.com" }));
  assert.deepEqual(t.log().map((e) => [e.decision, e.result, e.note]), [["escalate", "no-wake", "no fm.notify=plugin label"]]);
  assert.equal(t.world.sent.length, 0);
  const u = setup({ decisions: RULES("shadow").replace("- notify: plugin", "") });
  await u.perm.onRequested(u.ev("r1", { type: "fetch", url: "https://example.com" }));
  assert.match(u.log()[0].note ?? "", /switch off/);
});

test("the same request is handled once, also across a restart", async () => {
  const s = setup();
  await s.perm.onRequested(s.ev("r1", { type: "fetch", url: "https://example.com" }));
  await s.perm.onRequested(s.ev("r1", { type: "fetch", url: "https://example.com" }));
  assert.equal(s.log().length, 1);
  assert.equal(s.world.sent.length, 1);
  const again = new Permission({ ports: (s.perm as never as { o: { ports: PortSelector } }).o.ports, root: () => s.root, paseoHome: null, log: () => {}, retryDelayMs: 1 });
  await again.onRequested(s.ev("r1", { type: "fetch", url: "https://example.com" }));
  assert.equal(s.log().length, 1);
});

test("a dead parent falls back to the claimed first mate; no target is logged", async () => {
  const s = setup();
  s.world.agents.delete("fm");
  await s.perm.onRequested(s.ev("r1", { type: "fetch", url: "https://example.com" }));
  assert.equal(s.log()[0].result, "no-target");
  s.world.add({ id: "fm2", labels: {} });
  writeFileSync(join(s.root, "state", "firstmate.json"), JSON.stringify({ agentId: "fm2" }));
  await s.perm.onRequested(s.ev("r2", { type: "fetch", url: "https://example.com" }));
  assert.deepEqual(s.log()[1].note, "fm2");
});

test("requestJson drops bulky fields and caps the rest", () => {
  const j = requestJson({ id: "r", detail: { type: "write", filePath: "/a", content: "x".repeat(5000) }, title: "y".repeat(5000) });
  assert.ok(j.length <= 1501);
  assert.ok(!j.includes('"content"'));
});
