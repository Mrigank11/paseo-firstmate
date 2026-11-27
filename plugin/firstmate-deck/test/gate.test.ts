import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector, type TimelineItem } from "../server/paseo-port.ts";
import { Gate, messageVerdict, notifySwitchOn, rejectionText, type GateEntry, type TurnEndedEvent } from "../server/gate.ts";
import { assistant, FakeHosts, FakeWorld, fakePaseo, shell, type FakeAgent, type FakeHost } from "./fake-paseo.ts";

const user = (text: string) => ({ type: "user_message", text }) as TimelineItem;
const CREW = { "fm.task": "t1", "fm.project": "p", "fm.shape": "ship", "fm.notify": "plugin" };

function setup(o: { switchOn?: boolean; switchOff?: boolean; labels?: Record<string, string>; status?: "idle" | "running" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-"));
  mkdirSync(join(root, "state"));
  if (o.switchOff) writeFileSync(join(root, "state", "decisions.md"), "# d\n\n- notify: off\n");
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

test("notifySwitchOn is ON by default; decisions.md turns it off with notify: off / shadow", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-sw-"));
  mkdirSync(join(root, "state"));
  assert.equal(notifySwitchOn(root), true, "no decisions.md");
  for (const [text, want] of [["notify: plugin", true], ["- **notify:** plugin", true], ["- `notify: plugin`", true], ["no notify line", true], ["notify: off", false], ["- **notify:** off", false], ["notify: shadow", false], ["notify: Off", false], ["# notify: off later", true], ["notify: offline", true]] as const) {
    writeFileSync(join(root, "state", "decisions.md"), `# d\n${text}\n`);
    assert.equal(notifySwitchOn(root), want, text);
  }
});

test("shadow (decisions.md notify: off): narration and DONE are logged, nobody is woken", async () => {
  const s = setup({ switchOff: true });
  const g = s.mk();
  await g.onTurnEnded(s.end("Starting the dev server"));
  await g.onTurnEnded(s.end("DONE: abc @ def", { turnId: "turn-2" }));
  assert.equal(s.world.sent.length, 0);
  assert.deepEqual(s.log().map((e) => [e.turnId, e.verdict, e.result, e.acted]), [["turn-1", "NARRATION", "narration", false], ["turn-2", "DONE", "shadow", false]]);
});

test("notify mode: narration does not wake; a later DONE wakes the parent with the ## Crew DONE message", async () => {
  const s = setup();
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
  const s = setup({ labels: { "fm.task": "t1", "fm.shape": "scout" } });
  await s.mk().onTurnEnded(s.end("DONE: x"));
  assert.equal(s.world.sent.length, 0);
  assert.equal(s.log()[0].result, "shadow");
});

test("agents without fm.task are not crew: nothing is logged", async () => {
  const s = setup({ labels: {} });
  await s.mk().onTurnEnded(s.end("DONE: x"));
  assert.equal(s.log().length, 0);
});

test("failed and canceled turns wake as ERROR and CANCELED", async () => {
  const s = setup();
  const g = s.mk();
  await g.onTurnEnded(s.end("", { outcome: { kind: "failed", error: { message: "boom" } }, turnId: "a" }));
  await g.onTurnEnded(s.end("", { outcome: { kind: "canceled", reason: "user" }, turnId: "b" }));
  assert.deepEqual(s.world.sent.map((m) => m.text.split("\n").slice(0, 2)), [["## Crew ERROR · t1", "ERROR: boom"], ["## Crew CANCELED · t1", "CANCELED: user"]]);
});

test("settle rule: a DONE while the agent is still running is deferred, then woken once it is idle", async () => {
  const s = setup({ status: "running" });
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
  const s = setup();
  await s.mk().onTurnEnded(s.end("DONE: x"));
  await s.mk().onTurnEnded(s.end("DONE: x"));
  assert.equal(s.world.sent.length, 1);
  assert.equal(s.log().filter((e) => e.verdict === "DONE").length, 1);
});

test("target: the project claim -> the checkout claim -> the live parent -> no-target (the owner beats Paseo's parent label)", async () => {
  const s = setup();
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
  // a live parent that is NOT the owner does not get the wake: the claim wins
  s.claim("fm2");
  rmSync(join(s.root, "state", "projects", "p", "claim.json"));
  await g.onTurnEnded(s.end("DONE: y", { turnId: "t-d" }));
  assert.equal(s.world.sent.at(-1)!.id, "fm2");
});

test("a failing send is retried, then logged as failed (not deduped, so a later pass retries)", async () => {
  const s = setup();
  s.world.sendFails = true;
  const g = s.mk();
  await g.onTurnEnded(s.end("DONE: x"));
  assert.equal(s.log().at(-1)!.result, "failed");
  s.world.sendFails = false;
  await g.onTurnEnded(s.end("DONE: x"));
  assert.equal(s.log().at(-1)!.result, "woke");
});

test("agent.closed wakes a plugin-notified agent as CLOSED", async () => {
  const s = setup();
  await s.mk().onClosed({ agent: { id: "crew", parentAgentId: "fm" } });
  assert.match(s.world.sent[0].text, /^## Crew CLOSED · t1\n/);
});

test("startup sweep: a DONE that landed while the plugin was down is woken; handled ones and narration are not", async () => {
  const s = setup();
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
  const s = setup();
  const crew = s.world.agents.get("crew")!;
  crew.updatedAt = new Date().toISOString();
  crew.items = [user("go"), assistant("DONE: x")];
  const g = s.mk();
  await g.onTurnEnded(s.end("DONE: x"));
  assert.equal(await g.sweep(), 0);
  assert.equal(s.world.sent.length, 1);
});

test("start-up sweep without an SDK handle (CLI path): a DONE missed while down is woken", async () => {
  const root = mkdtempSync(join(tmpdir(), "gate-cli-"));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "decisions.md"), "notify: plugin\n");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: [{ id: "t1", project: "p", shape: "scout", state: "active" }, { id: "t2", state: "done" }] }));
  const sent: string[] = [];
  const row = (id: string) => ({ id, status: "idle", name: id });
  const exec = async (a: string[]) => {
    const li = a.indexOf("--label"); const label = li < 0 ? undefined : a[li + 1];
    if (a[0] === "ls") return JSON.stringify(label === undefined ? [row("fm")] : label === "fm.task=t1" || label === "fm.notify=plugin" ? [row("crew")] : label === "fm.task=t2" ? [row("other")] : []);
    if (a[0] === "inspect") return JSON.stringify({ Status: "idle", UpdatedAt: new Date().toISOString(), ParentAgentId: "fm" });
    if (a[0] === "logs") return "[Message received] x\nGo\nStarting\n[Shell] ls\nDONE: missed while down\n";
    if (a[0] === "send") { sent.push(a[1]); return ""; }
    throw new Error(a[0]);
  };
  const ports = new PortSelector(new CliPort(exec), () => {}); // no capture(): no handle
  const g = new Gate({ ports, root: () => root, firstmateLabel: () => "firstmate=true", log: () => {}, retryDelayMs: 1 });
  assert.equal(await g.sweepCli(), 1);
  const entries = readFileSync(join(root, "state", "gate-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as GateEntry);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].task, "t1");
  assert.equal(entries[0].verdict, "DONE");
  assert.equal(entries[0].turnId, null);
  assert.equal(entries[0].result, "woke");
  assert.deepEqual(sent, ["fm"]);
  assert.equal(await g.sweepCli(), 0); // handled once
});

// ---------- the needs-you bounce (canvas.strict) ----------

const STRICT = { ...CREW, "canvas.strict": "on" };
const sum = (openIds: string[], lastRejection?: unknown) => ({ openAsks: openIds.map((id) => ({ id })), lastRejection });

test("a strict crew's BLOCKED naming a canvas ask that is not open is sent back once, not logged as a verdict, no wake", async () => {
  const s = setup({ labels: STRICT });
  const g = new Gate({ ports: s.ports, root: () => s.root, firstmateLabel: () => "firstmate=true", log: () => {}, settleMs: 10, retryDelayMs: 1, canvas: async () => sum([], { code: "needs_you_structure", error: "missing: impact, fix" }) });
  await g.onTurnEnded(s.end("BLOCKED: canvas ask q1"));
  assert.deepEqual(s.world.sent.map((m) => m.id), ["crew"], "the crew is sent back, the first mate is not woken");
  assert.match(s.world.sent[0].text, /^## Canvas question not accepted · t1\n/);
  assert.match(s.world.sent[0].text, /missing: impact, fix/);
  assert.match(s.world.sent[0].text, /BLOCKED: canvas ask q1 again/);
  assert.deepEqual(s.log().map((e) => [e.verdict, e.result, e.acted]), [["BLOCKED", "bounced", false]]);
  // the second time is an ordinary BLOCKED and wakes the first mate
  await g.onTurnEnded(s.end("BLOCKED: canvas ask q1", { turnId: "turn-2" }));
  assert.deepEqual(s.world.sent.map((m) => m.id), ["crew", "fm"]);
  assert.equal(s.log().at(-1)!.result, "woke");
});

test("the bounce is remembered across a restart (from the log)", async () => {
  const s = setup({ labels: STRICT });
  const mk = () => new Gate({ ports: s.ports, root: () => s.root, firstmateLabel: () => "firstmate=true", log: () => {}, settleMs: 10, retryDelayMs: 1, canvas: async () => sum([], "refused") });
  await mk().onTurnEnded(s.end("BLOCKED: canvas ask q1"));
  await mk().onTurnEnded(s.end("BLOCKED: canvas ask q1", { turnId: "turn-2" }));
  assert.deepEqual(s.world.sent.map((m) => m.id), ["crew", "fm"]);
});

test("no bounce when the ask is open, the crew is not strict, the canvas is unreachable, or it is not a canvas ask", async () => {
  for (const [labels, lookup, line] of [
    [STRICT, async () => sum(["q1"]), "BLOCKED: canvas ask q1"],
    [CREW, async () => sum([]), "BLOCKED: canvas ask q1"],
    [STRICT, async () => null, "BLOCKED: canvas ask q1"],
    [STRICT, async () => sum([]), "BLOCKED: which database?"],
  ] as const) {
    const s = setup({ labels });
    const g = new Gate({ ports: s.ports, root: () => s.root, firstmateLabel: () => "firstmate=true", log: () => {}, settleMs: 10, retryDelayMs: 1, canvas: lookup });
    await g.onTurnEnded(s.end(line));
    assert.deepEqual(s.world.sent.map((m) => m.id), ["fm"], line);
  }
});

test("rejectionText reads a string, {error} or {errors}", () => {
  assert.equal(rejectionText("a"), "a");
  assert.equal(rejectionText({ code: "x", error: "b" }), "b");
  assert.equal(rejectionText({ errors: ["c", "d"] }), "c\nd");
  assert.equal(rejectionText(undefined), "");
});

test("the turn-end event's timeline is empty (deprecated): the verdict comes from the agent's tail, and the bounce still works", async () => {
  const s = setup({ labels: STRICT });
  s.world.agents.get("crew")!.items = [user("go"), shell("ls"), assistant("BLOCKED: canvas ask q1")];
  const g = new Gate({ ports: s.ports, root: () => s.root, firstmateLabel: () => "firstmate=true", log: () => {}, settleMs: 10, retryDelayMs: 1, canvas: async () => sum([], "refused") });
  await g.onTurnEnded(s.end("", { timeline: [] }));
  assert.deepEqual(s.world.sent.map((m) => m.id), ["crew"]);
  assert.equal(s.log().at(-1)!.result, "bounced");
});

// ---------- crews on other Paseo hosts ----------

const SWEPT = [user("go"), shell("ls"), assistant("DONE: far")];

/** A local first mate plus crew "far" on host mac, known to the port as the Mac's. */
async function remote(labels: Record<string, string> = CREW, ...more: FakeAgent[]) {
  const s = setup();
  const mac: FakeHost = { serverId: "srv_mac", label: "mac", world: new FakeWorld().add({ id: "far", labels, status: "idle", items: SWEPT, updatedAt: new Date().toISOString() }, ...more) };
  const ports = new PortSelector(new CliPort(async () => "[]"), () => {});
  ports.capture({ paseo: fakePaseo(s.world, new FakeHosts(mac)) }, "test");
  await ports.current().listAgents();
  s.claim("fm");
  const mk = () => new Gate({ ports, root: () => s.root, firstmateLabel: () => "firstmate=true", log: () => {}, settleMs: 10, retryDelayMs: 1 });
  const end = (turnId: string | null, text = "DONE: far"): TurnEndedEvent => ({ agent: { id: "far", parentAgentId: "fm", serverId: "srv_mac", labels, status: "idle" }, turnId, outcome: { kind: "completed" }, timeline: [user("go"), assistant(text)] });
  return { ...s, ports, mac, mk, end };
}

const soon = <T>(p: Promise<T>, ms = 500) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("held up")), ms).unref())]);

test("a remote crew's finish wakes the local first mate", async () => {
  const s = await remote();
  await s.mk().onTurnEnded(s.end("t1"));
  assert.deepEqual(s.world.sent.map((m) => m.id), ["fm"]);
  assert.equal(s.mac.world.sent.length, 0);
});

test("a hung host never delays a local crew's finish", async () => {
  const s = await remote();
  const g = s.mk();
  s.mac.world.hang = true;
  void g.onTurnEnded(s.end("t1"));
  await soon(g.onTurnEnded({ agent: { id: "crew", parentAgentId: "fm" }, turnId: "l1", outcome: { kind: "completed" }, timeline: [user("go"), assistant("DONE: here")] }));
  assert.match(s.world.sent[0].text, /DONE: here/);
  g.stop();
  s.ports.sdkPort()!.hosts!.stop();
});

test("a host that cannot be reached does not lose the finish its event already carries", async () => {
  const s = await remote();
  s.mac.world.agents.clear();
  s.mac.status = "offline";
  await s.mk().onTurnEnded(s.end("t1"));
  assert.deepEqual(s.world.sent.map((m) => m.id), ["fm"]);
});

test("the sweep covers remote crews, and the host's own event for that turn is not a second wake", async () => {
  const s = await remote();
  assert.equal(await s.mk().sweep(), 1);
  assert.deepEqual(s.world.sent.map((m) => m.id), ["fm"]);
  await s.mk().onTurnEnded(s.end("t9"));
  assert.equal(s.world.sent.length, 1);
  assert.deepEqual([s.log().at(-1)!.result, s.log().at(-1)!.turnId], ["duplicate", "t9"]);
  await s.mk().onTurnEnded(s.end("t9")); // a restart keeps it
  assert.equal(s.world.sent.length, 1);
  await s.mk().onTurnEnded(s.end("t10")); // a later turn that ends the same way is its own finish
  assert.equal(s.world.sent.length, 2);
});

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

test("a sweep-logged finish whose event never came does not swallow a later turn ending in the same line", async () => {
  const s = await remote();
  assert.equal(await s.mk().sweep(), 1);
  // the later turn began after the agent was swept: its own finish, restart or not
  await s.mk().onTurnEnded({ ...s.end("t10"), turnStartedAt: minutes(1) });
  assert.deepEqual(s.world.sent.map((m) => m.id), ["fm", "fm"]);
});

test("a sweep and the host's event for one turn still wake once, however late the event is", async () => {
  const s = await remote();
  const g = s.mk();
  assert.equal(await g.sweep(), 1);
  await s.mk().onTurnEnded({ ...s.end("t9"), turnStartedAt: minutes(-5) });
  assert.equal(s.world.sent.length, 1);
  assert.deepEqual([s.log().at(-1)!.result, s.log().at(-1)!.turnId], ["duplicate", "t9"]);
  await s.mk().onTurnEnded({ ...s.end("t10"), turnStartedAt: minutes(1) });
  assert.equal(s.world.sent.length, 2);
});

test("the sweep does not repeat a remote finish whose event is still being delivered", async () => {
  const s = await remote();
  const g = s.mk();
  const send = s.ports.send.bind(s.ports);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  s.ports.send = async (id, text) => { await held; return send(id, text); };
  const event = g.onTurnEnded(s.end("t1"));
  const swept = g.sweep();
  await new Promise((r) => setTimeout(r, 30));
  release();
  await Promise.all([event, swept]);
  assert.equal(s.world.sent.length, 1);
});

test("the sweep leaves an offline host's crews alone", async () => {
  const s = await remote();
  s.ports.root = () => s.root;
  s.mac.status = "offline";
  const fresh = new PortSelector(new CliPort(async () => "[]"), () => {});
  fresh.root = () => s.root;
  fresh.capture({ paseo: fakePaseo(s.world, new FakeHosts(s.mac)) }, "test");
  const g = new Gate({ ports: fresh, root: () => s.root, firstmateLabel: () => "firstmate=true", log: () => {} });
  assert.equal(await g.sweep(), 0);
  assert.equal(s.world.sent.length, 0);
});

test("a remote agent is never the wake target, by claim or as a parent", async () => {
  const s = await remote(CREW, { id: "mac-boss", labels: { firstmate: "true" } });
  s.claim("mac-boss");
  await s.mk().onTurnEnded({ ...s.end("t1"), agent: { id: "far", parentAgentId: "mac-boss", serverId: "srv_mac", labels: CREW, status: "idle" } });
  assert.equal(s.world.sent.length + s.mac.world.sent.length, 0);
  assert.equal(s.log().at(-1)!.result, "no-target");
});
