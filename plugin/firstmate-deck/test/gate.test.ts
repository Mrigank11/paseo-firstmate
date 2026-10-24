import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector, type TimelineItem } from "../server/paseo-port.ts";
import { Gate, messageVerdict, notifySwitchOn, type GateEntry, type TurnEndedEvent } from "../server/gate.ts";
import { assistant, FakeWorld, fakePaseo, shell } from "./fake-paseo.ts";

const user = (text: string) => ({ type: "user_message", text }) as TimelineItem;
const CREW = { "fm.task": "t1", "fm.project": "p", "fm.shape": "ship", "fm.notify": "plugin" };

function setup(o: { switchOn?: boolean; labels?: Record<string, string>; status?: "idle" | "running" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-"));
  mkdirSync(join(root, "state"));
  if (o.switchOn) writeFileSync(join(root, "state", "decisions.md"), "# d\n\n- notify: plugin\n");
  const world = new FakeWorld().add(
    { id: "crew", labels: o.labels ?? CREW, status: o.status ?? "idle" },
    { id: "fm", labels: { firstmate: "true" } },
  );
  const ports = new PortSelector(new CliPort(async (a) => { if (a[0] === "send") throw new Error("daemon down"); return "[]"; }), () => {});
  ports.capture({ paseo: fakePaseo(world) }, "test");
  const mk = () => new Gate({ ports, root: () => root, firstmateLabel: () => "firstmate=true", log: () => {}, settleMs: 10, retryDelayMs: 1 });
  const log = (): GateEntry[] => { try { return readFileSync(join(root, "state", "gate-log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const claim = (id: string) => writeFileSync(join(root, "state", "firstmate.json"), JSON.stringify({ agentId: id }));
  const end = (text: string, extra: Partial<TurnEndedEvent> = {}): TurnEndedEvent => ({ agent: { id: "crew", parentAgentId: "fm" }, turnId: "turn-1", outcome: { kind: "completed" }, timeline: [user("go"), shell("ls"), assistant(text)], ...extra });
  return { root, world, ports, mk, log, claim, end };
}

test("verdict: first line of the final message decides", () => {
  assert.equal(messageVerdict([user("x"), assistant("DONE: abc @ def\nmore")]).verdict, "DONE");
  assert.equal(messageVerdict([assistant("BLOCKED: which one?")]).verdict, "BLOCKED");
  assert.equal(messageVerdict([assistant("\n\nDONE: after blank lines")]).verdict, "DONE");
  assert.deepEqual(messageVerdict([assistant("DONE: a"), assistant("\nx")]).verdict, "DONE"); // chunks join
  assert.equal(messageVerdict([user("x"), assistant("Starting the dev server")]).verdict, "NARRATION");
  // narration, then a tool call, then the final message: only the final message counts
  assert.equal(messageVerdict([assistant("DONE: old"), shell("ls"), assistant("still working")]).verdict, "NARRATION");
  assert.equal(messageVerdict([assistant("working"), shell("ls"), assistant("DONE: now")]).verdict, "DONE");
  assert.equal(messageVerdict([]).verdict, "NARRATION");
});

test("a DONE: line later in the text is a near-miss, not a verdict", () => {
  const m = messageVerdict([assistant("Summary below\nDONE: abc")]);
  assert.equal(m.verdict, "NARRATION");
  assert.equal(m.nearMiss, "DONE: abc");
});

test("notifySwitchOn reads decisions.md and is off by default", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-sw-"));
  mkdirSync(join(root, "state"));
  assert.equal(notifySwitchOn(root), false);
  for (const [text, want] of [["notify: plugin", true], ["- **notify:** plugin", true], ["- `notify: plugin`", true], ["notify: off", false], ["# notify: plugin later", false], ["notify: plugins", false]] as const) {
    writeFileSync(join(root, "state", "decisions.md"), `# d\n${text}\n`);
    assert.equal(notifySwitchOn(root), want, text);
  }
});

test("shadow (switch off): narration and DONE are logged, nobody is woken", async () => {
  const s = setup();
  const g = s.mk();
  await g.onTurnEnded(s.end("Starting the dev server"));
  await g.onTurnEnded(s.end("DONE: abc @ def", { turnId: "turn-2" }));
  assert.equal(s.world.sent.length, 0);
  assert.deepEqual(s.log().map((e) => [e.turnId, e.verdict, e.result, e.acted]), [["turn-1", "NARRATION", "narration", false], ["turn-2", "DONE", "shadow", false]]);
});

test("notify mode: narration does not wake; a later DONE wakes the parent with the ## Crew DONE message", async () => {
  const s = setup({ switchOn: true });
  const g = s.mk();
  await g.onTurnEnded(s.end("Starting the dev server"));
  assert.equal(s.world.sent.length, 0);
  await g.onTurnEnded(s.end("DONE: abc @ def", { turnId: "turn-2" }));
  assert.equal(s.world.sent.length, 1);
  assert.equal(s.world.sent[0].id, "fm");
  assert.equal(s.world.sent[0].text, "## Crew DONE · t1\nDONE: abc @ def\nagent crew · ship · project p · turn turn-2");
  assert.deepEqual(s.world.sent[0].options, { activeTurnBehavior: "steer" });
  const last = s.log().at(-1)!;
  assert.deepEqual([last.verdict, last.result, last.acted, last.note], ["DONE", "woke", true, "fm"]);
});

test("without the fm.notify=plugin label the agent is only shadowed, even with the switch on", async () => {
  const s = setup({ switchOn: true, labels: { "fm.task": "t1", "fm.shape": "scout" } });
  await s.mk().onTurnEnded(s.end("DONE: x"));
  assert.equal(s.world.sent.length, 0);
  assert.equal(s.log()[0].result, "shadow");
});

test("agents without fm.task are not crew: nothing is logged", async () => {
  const s = setup({ switchOn: true, labels: {} });
  await s.mk().onTurnEnded(s.end("DONE: x"));
  assert.equal(s.log().length, 0);
});

test("failed and canceled turns wake as ERROR and CANCELED", async () => {
  const s = setup({ switchOn: true });
  const g = s.mk();
  await g.onTurnEnded(s.end("", { outcome: { kind: "failed", error: { message: "boom" } }, turnId: "a" }));
  await g.onTurnEnded(s.end("", { outcome: { kind: "canceled", reason: "user" }, turnId: "b" }));
  assert.deepEqual(s.world.sent.map((m) => m.text.split("\n").slice(0, 2)), [["## Crew ERROR · t1", "ERROR: boom"], ["## Crew CANCELED · t1", "CANCELED: user"]]);
});

test("settle rule: a DONE while the agent is still running is deferred, then woken once it is idle", async () => {
  const s = setup({ switchOn: true, status: "running" });
  const g = s.mk();
  await g.onTurnEnded(s.end("DONE: step-scoped"));
  assert.equal(s.world.sent.length, 0);
  assert.equal(s.log()[0].result, "deferred");
  s.world.agents.get("crew")!.status = "idle";
  await new Promise((r) => setTimeout(r, 60)); // settleMs = 10
  assert.equal(s.world.sent.length, 1);
  assert.equal(s.log().at(-1)!.result, "woke");
  g.stop();
});

test("dedupe survives a re-created gate (restart): the same turn is not woken twice", async () => {
  const s = setup({ switchOn: true });
  await s.mk().onTurnEnded(s.end("DONE: x"));
  await s.mk().onTurnEnded(s.end("DONE: x"));
  assert.equal(s.world.sent.length, 1);
  assert.equal(s.log().filter((e) => e.verdict === "DONE").length, 1);
});

test("target: parent gone -> the project claim -> the checkout claim -> no-target", async () => {
  const s = setup({ switchOn: true });
  s.world.add({ id: "fm2", labels: {} });
  const ev = (turnId: string) => s.end("DONE: x", { agentId: undefined, turnId, agent: { id: "crew", parentAgentId: "gone" } } as never);
  const g = s.mk();
  await g.onTurnEnded(ev("t-a"));
  assert.equal(s.log().at(-1)!.result, "no-target");
  s.claim("fm2");
  await g.onTurnEnded(ev("t-b"));
  assert.equal(s.world.sent.at(-1)!.id, "fm2");
  mkdirSync(join(s.root, "state", "projects", "p"), { recursive: true });
  writeFileSync(join(s.root, "state", "projects", "p", "claim.json"), JSON.stringify({ agentId: "fm" }));
  await g.onTurnEnded(ev("t-c"));
  assert.equal(s.world.sent.at(-1)!.id, "fm");
});

test("a failing send is retried, then logged as failed (not deduped, so a later pass retries)", async () => {
  const s = setup({ switchOn: true });
  s.world.sendFails = true;
  const g = s.mk();
  await g.onTurnEnded(s.end("DONE: x"));
  assert.equal(s.log().at(-1)!.result, "failed");
  s.world.sendFails = false;
  await g.onTurnEnded(s.end("DONE: x"));
  assert.equal(s.log().at(-1)!.result, "woke");
});

test("agent.closed wakes a plugin-notified agent as CLOSED", async () => {
  const s = setup({ switchOn: true });
  await s.mk().onClosed({ agent: { id: "crew", parentAgentId: "fm" } });
  assert.match(s.world.sent[0].text, /^## Crew CLOSED · t1\n/);
});

test("startup sweep: a DONE that landed while the plugin was down is woken; handled ones and narration are not", async () => {
  const s = setup({ switchOn: true });
  const crew = s.world.agents.get("crew")!;
  crew.updatedAt = new Date().toISOString();
  crew.items = [user("go"), shell("ls"), assistant("DONE: missed")];
  s.world.add({ id: "quiet", labels: { ...CREW, "fm.task": "t2" }, updatedAt: new Date().toISOString(), items: [assistant("Starting the dev server")] });
  s.world.add({ id: "old", labels: { ...CREW, "fm.task": "t3" }, updatedAt: "2020-01-01T00:00:00Z", items: [assistant("DONE: ancient")] });
  s.claim("fm");
  const g = s.mk();
  assert.equal(await g.sweep(), 1);
  assert.equal(s.world.sent.length, 1);
  assert.equal(s.world.sent[0].text.split("\n")[0], "## Crew DONE · t1");
  assert.equal(await s.mk().sweep(), 0); // a fresh gate reads the log: nothing new
  assert.equal(s.world.sent.length, 1);
});

test("sweep does not repeat a finish the turn hook already handled", async () => {
  const s = setup({ switchOn: true });
  const crew = s.world.agents.get("crew")!;
  crew.updatedAt = new Date().toISOString();
  crew.items = [user("go"), assistant("DONE: x")];
  const g = s.mk();
  await g.onTurnEnded(s.end("DONE: x"));
  assert.equal(await g.sweep(), 0);
  assert.equal(s.world.sent.length, 1);
});
