import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStalled, computeStage, currentAgent, archiveStateOf, stageAgentsFor, stateOf, type StageAgent, type StageTask } from "../server/stage.ts";

const NOW = new Date("2026-10-24T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const task = (over: Partial<StageTask> = {}): StageTask => ({ state: "active", since: ago(60), asks: [], ...over });
const agent = (over: Partial<StageAgent> = {}): StageAgent => ({ id: "ag-1", status: "running", archived: false, createdAt: ago(50), lastActivityAt: ago(1), pendingPermissions: 0, ...over });
const stage = (t: StageTask, as: StageAgent[], o?: Parameters<typeof computeStage>[3]) => computeStage(t, as, NOW, o);
const keys = (s: { flags: { key: string }[] }) => s.flags.map((f) => f.key);

test("1: an archive line is its verdict, frozen: Paseo is not consulted", () => {
  const s = stage(task({ state: "done" }), [agent()], { archived: true });
  assert.deepEqual([s.stage, s.group, keys(s)], ["Done", "done", []]);
  assert.equal(stage(task({ state: "failed" }), [], { archived: true }).failed, true);
});

test("2: done/failed live; an open ask stays visible; a still-running agent is drift", () => {
  assert.deepEqual([stage(task({ state: "done" }), [agent({ status: "idle" })]).group], ["done"]);
  assert.equal(stage(task({ state: "failed" }), []).failed, true);
  assert.equal(stage(task({ state: "done", asks: [{}] }), []).group, "you");
  assert.equal(stage(task({ state: "done", asks: [{ repliedAt: "x" }] }), []).group, "fm");
  const s = stage(task({ state: "done" }), [agent()]);
  assert.deepEqual([s.group, keys(s), s.flags[0].drift], ["done", ["done-but-running"], true]);
});

test("3: parked; T4: a running agent makes it Running, with the drift flag", () => {
  assert.equal(stage(task({ state: "parked" }), [agent({ status: "idle" })]).group, "parked");
  const s = stage(task({ state: "parked" }), [agent()]);
  assert.deepEqual([s.group, keys(s)], ["running", ["parked-but-running"]]);
});

test("4: blocked; T4: a running agent makes it Running, flagged (blocked used to carry no flag at all)", () => {
  assert.equal(stage(task({ state: "blocked", blocked_on: "Nemath" }), []).group, "blocked");
  const s = stage(task({ state: "blocked" }), [agent()]);
  assert.deepEqual([s.group, keys(s), s.flags[0].drift], ["running", ["blocked-but-running"], true]);
});

test("5: queued; an existing agent is drift", () => {
  assert.deepEqual([stage(task({ state: "queued" }), []).group, keys(stage(task({ state: "queued" }), []))], ["next", []]);
  assert.deepEqual(keys(stage(task({ state: "queued" }), [agent({ status: "idle" })])), ["queued-but-has-agent"]);
  assert.equal(stage(task({ state: "queued" }), [agent({ status: "idle" })]).group, "next");
  assert.deepEqual([stage(task({ state: "queued" }), [agent()]).group, keys(stage(task({ state: "queued" }), [agent()]))], ["running", ["queued-but-has-agent"]]); // T4
});

test("6: an unanswered ask is Needs you once the agent is idle (a running crew outranks it); a replied one is with the first mate", () => {
  assert.equal(stage(task({ asks: [{}] }), [agent({ status: "idle" })]).group, "you");
  assert.equal(stage(task({ asks: [{ repliedAt: "x" }] }), [agent()]).group, "fm");
  assert.equal(stage(task({ asks: [{ repliedAt: "x" }, {}] }), [agent({ status: "idle" })]).group, "you");
});

test("7: a pending permission is Needs you", () => {
  const s = stage(task(), [agent({ pendingPermissions: 2 })]);
  assert.deepEqual([s.stage, s.group], ["Needs you · permission", "you"]);
});

test("8: every ask replied or pending is with the first mate", () => assert.equal(stage(task({ asks: [{ repliedAt: "x" }] }), []).stage, "With the first mate"));

test("9/10: no agent is Dispatching for 10 minutes, then Lost", () => {
  const fresh = stage(task({ since: ago(3) }), []);
  assert.deepEqual([fresh.stage, fresh.group, keys(fresh)], ["Dispatching", "running", []]);
  const lost = stage(task({ since: ago(11) }), []);
  assert.deepEqual([lost.stage, lost.group, keys(lost), lost.flags[0].drift], ["Lost", "fm", ["no-agent"], true]);
});

test("11: a running agent is Running; silence over 30 min is flagged", () => {
  const s = stage(task(), [agent()]);
  assert.deepEqual([s.stage, s.group, keys(s), s.agentId], ["Running", "running", [], "ag-1"]);
  assert.deepEqual(keys(stage(task(), [agent({ lastActivityAt: ago(40) })])), ["silent"]);
  assert.equal(stage(task(), [agent({ status: "initializing" })]).group, "running");
});

test("12: an errored agent", () => {
  const s = stage(task(), [agent({ status: "error" })]);
  assert.deepEqual([s.stage, s.group, s.failed], ["Failed (agent errored)", "fm", true]);
});

test("13/14/15: idle agent by its final line", () => {
  const idle = (final?: string) => stage(task(), [agent({ status: "idle", final })]);
  assert.deepEqual([idle("DONE: shipped").stage, idle("DONE: shipped").group, keys(idle("DONE: x"))], ["Review", "fm", []]);
  assert.equal(idle("BLOCKED: need key").stage, "Blocked by crew");
  // T7: no hand-back is the crew's to give: Running group, owner crew; after the plugin's one reminder it reaches the first mate
  assert.deepEqual([idle().stage, idle().group, idle().owner, keys(idle())], ["Crew stopped · no hand-back", "running", "crew", ["idle-no-done"]]);
  const nudged = stage(task(), [agent({ status: "idle", nudged: true })]);
  assert.deepEqual([nudged.stage, nudged.group, nudged.owner], ["Idle", "fm", "firstmate"]);
  assert.equal(stage(task(), [agent({ status: "closed", final: "DONE: x" })]).stage, "Review");
  // a caller that cannot read the last message does not guess "no DONE:"
  assert.deepEqual(keys(stage(task(), [agent({ status: "idle" })], { finalKnown: false })), []);
  assert.equal(stage(task(), [agent({ status: "idle" })], { finalKnown: false }).group, "fm");
});

test("16: the current agent is archived", () => {
  const s = stage(task(), [agent({ archived: true, status: "idle" })]);
  assert.deepEqual([s.stage, keys(s)], ["Agent archived", ["archived-agent-open-task"]]);
});

test("an unreadable agent status is Running, flagged", () => {
  const s = stage(task(), [agent({ status: "unknown" })]);
  assert.deepEqual([s.group, keys(s)], ["running", ["status-unknown"]]);
});

test("reuse: the newest live agent wins; an older finished one is history", () => {
  const old = agent({ id: "old", status: "idle", createdAt: ago(300), final: "DONE: earlier task" });
  const cur = agent({ id: "new", createdAt: ago(20) });
  assert.equal(stage(task(), [old, cur]).agentId, "new");
  assert.equal(stage(task(), [cur, old]).stage, "Running");
  assert.equal(currentAgent([agent({ id: "a", archived: true, createdAt: ago(5) }), agent({ id: "b", archived: true, createdAt: ago(9) })])?.id, "a");
  assert.equal(currentAgent([agent({ id: "a", archived: true, createdAt: ago(5) }), agent({ id: "b", createdAt: ago(90) })])?.id, "b");
});

test("state is the registry's intent; the v1 status and agentId are not read any more", () => {
  for (const [state, want] of [["active", "active"], ["parked", "parked"], ["done", "done"], ["queued", "queued"], ["weird", "queued"], [undefined, "queued"]]) assert.equal(stateOf({ state }), want);
  assert.equal(stateOf({ status: "running" } as never), "queued");
  assert.equal(archiveStateOf({ outcome: "failed" }), "failed");
  assert.equal(archiveStateOf({ status: "failed" }), "failed");
  assert.equal(archiveStateOf({ state: "done" }), "done");
  const view = (id: string) => (id === "lab" ? { final: "DONE: ok" } : undefined);
  const labeled = stageAgentsFor([{ id: "lab", status: "idle", archived: false, createdAt: ago(5) }], view);
  assert.deepEqual([labeled.map((a) => a.id), labeled[0].final], [["lab"], "DONE: ok"]);
  assert.deepEqual(stageAgentsFor(undefined, view), []);
});

// ---- the crew's canvas (F1): asks, verdict flags, curated asks that resolve themselves ----
const cv = (asks: { id: string; pending?: boolean }[] = [], verdict = "Working") => ({ asks: asks.map((a) => ({ id: a.id, pending: !!a.pending })), verdict });

test("canvas: an open canvas ask on an idle agent is Needs you", () => {
  const s = stage(task(), [agent({ status: "idle", final: "BLOCKED: canvas ask db" })], { canvas: cv([{ id: "db" }]) });
  assert.deepEqual([s.stage, s.group], ["Needs you", "you"]);
});

test("canvas: an open canvas question beats a 'blocked on captain' note; with no question the note still blocks", () => {
  const blocked = task({ state: "blocked", blocked_on: "captain" });
  const q = stage(blocked, [agent({ status: "idle" })], { canvas: cv([{ id: "db" }]) });
  assert.deepEqual([q.stage, q.group], ["Needs you", "you"]);
  assert.equal(stage(blocked, [agent({ status: "idle" })], { canvas: cv([]) }).group, "blocked");
  assert.equal(stage(task({ state: "blocked", blocked_on: "Nemath" }), [], {}).group, "blocked");
});

test("canvas: a running agent with an open canvas ask is 'Running · 1 question' (agent-canvas's own rule)", () => {
  const one = stage(task(), [agent()], { canvas: cv([{ id: "db" }]) });
  assert.deepEqual([one.stage, one.group], ["Running · 1 question", "running"]);
  assert.equal(stage(task(), [agent()], { canvas: cv([{ id: "a" }, { id: "b" }]) }).stage, "Running · 2 questions");
});

test("canvas: a captain pick waiting on the first mate is With the first mate (running or idle)", () => {
  for (const status of ["running", "idle"]) {
    const s = stage(task(), [agent({ status })], { canvas: cv([{ id: "db", pending: true }]) });
    assert.deepEqual([s.stage, s.group], ["With the first mate", "fm"], status);
  }
  // an unanswered second question still wins over a pending first
  assert.equal(stage(task(), [agent({ status: "idle" })], { canvas: cv([{ id: "db", pending: true }, { id: "x" }]) }).group, "you");
});

test("canvas: no open ask changes nothing; a canvas that was not read changes nothing", () => {
  assert.equal(stage(task(), [agent()], { canvas: cv([]) }).stage, "Running");
  assert.equal(stage(task(), [agent()], {}).stage, "Running");
});

test("canvas: registry asks, permissions and an errored agent keep their precedence", () => {
  assert.equal(stage(task({ asks: [{ repliedAt: "x" }] }), [agent()], { canvas: cv([{ id: "db" }]) }).group, "fm");
  assert.equal(stage(task(), [agent({ pendingPermissions: 1 })], { canvas: cv([{ id: "db" }]) }).stage, "Needs you · permission");
  assert.equal(stage(task(), [agent({ status: "error" })], { canvas: cv([{ id: "db" }]) }).stage, "Failed (agent errored)");
});

test("canvas: only an active or blocked task listens to its canvas (parked, queued, done are the registry's)", () => {
  for (const state of ["parked", "queued", "done"] as const) {
    assert.ok(!/question|Needs you/.test(stage(task({ state }), [agent({ status: "idle" })], { canvas: cv([{ id: "db" }]) }).stage), state);
  }
});

test("canvas: a Disputed or Stale verdict is a non-drift flag", () => {
  const d = stage(task(), [agent()], { canvas: cv([], "Disputed") });
  assert.deepEqual([keys(d), d.flags[0].drift], [["canvas-disputed"], false]);
  assert.deepEqual(keys(stage(task(), [agent({ status: "idle", final: "DONE: x" })], { canvas: cv([], "Stale") })), ["canvas-stale"]);
  assert.deepEqual(keys(stage(task(), [agent()], { canvas: cv([], "Needs you") })), []);
  // an archived current agent's canvas is a snapshot: no flag
  assert.deepEqual(keys(stage(task(), [agent({ archived: true, status: "idle" })], { canvas: cv([], "Disputed") })), ["archived-agent-open-task"]);
});

test("canvas: a curated ask whose canvas question is answered or gone closes itself: ref-closed, With the first mate", () => {
  const ref = { kind: "canvas", agentId: "ag-1", block: "db" };
  const closed = stage(task({ asks: [{ ref }] }), [agent()], { canvas: cv([]) });
  assert.deepEqual([closed.stage, closed.group, keys(closed), closed.flags[0].drift], ["Running", "running", ["ref-closed"], true]); // T3: the crew is running
  const idleClosed = stage(task({ asks: [{ ref }] }), [agent({ status: "idle", final: "DONE: x" })], { canvas: cv([]) });
  assert.deepEqual([idleClosed.stage, idleClosed.group, keys(idleClosed)], ["With the first mate", "fm", ["ref-closed"]]);
  // still open on the canvas: the curated ask stands, the captain's call
  const stands = stage(task({ asks: [{ ref }] }), [agent({ status: "idle" })], { canvas: cv([{ id: "db" }]) });
  assert.deepEqual([stands.group, keys(stands)], ["you", []]);
  // a registry ask with no ref is never closed by the canvas; and with the canvas unread nothing closes
  assert.equal(stage(task({ asks: [{}] }), [agent({ status: "idle" })], { canvas: cv([]) }).group, "you");
  assert.equal(stage(task({ asks: [{ ref }] }), [agent({ status: "idle" })], {}).group, "you");
  // an unrelated canvas question still open beats the closed ask: the captain's call, flag kept
  const raw = stage(task({ asks: [{ ref }] }), [agent({ status: "idle" })], { canvas: cv([{ id: "other" }]) });
  assert.deepEqual([raw.stage, keys(raw)], ["Needs you", ["ref-closed"]]);
  // another curated ask is still open next to the closed one: the open one decides, the flag still tells the first mate
  const two = stage(task({ asks: [{ ref }, {}] }), [agent({ status: "idle" })], { canvas: cv([]) });
  assert.deepEqual([two.group, keys(two)], ["you", ["ref-closed"]]);
});

test("canvas: a crew whose canvas.relay first mate is gone carries the relay-target-gone drift flag (live tasks only)", () => {
  const s = stage(task(), [agent({ relayGone: "fm-9999999" })]);
  assert.deepEqual([s.stage, keys(s), s.flags[0].drift], ["Running", ["relay-target-gone"], true]);
  assert.deepEqual(keys(stage(task(), [agent()])), []);
  assert.deepEqual(keys(stage(task({ state: "done" }), [agent({ status: "idle", relayGone: "fm-1" })])), [], "a finished task has nothing to relay");
  assert.deepEqual(keys(stage(task(), [agent({ archived: true, relayGone: "fm-1" })])), ["archived-agent-open-task"], "an archived agent has no canvas to relay: only its own flag");
});

// ---- honest stages: an idle crew is not "with the first mate" while it waits on something else ----
test("honest: an idle crew with background jobs or sub-agents running (canvas Waiting) is Waiting, not with the first mate", () => {
  const s = stage(task(), [agent({ status: "idle", final: "Starting the review sub-agents, back when they report." })], { canvas: cv([], "Waiting") });
  assert.deepEqual([s.stage, s.group], ["Waiting", "running"]);
  // the canvas said Working before Paseo's idle landed
  assert.deepEqual([stage(task(), [agent({ status: "idle" })], { canvas: cv([], "Working") }).stage], ["Running"]);
});

test("honest: a DONE:/BLOCKED: hand-back is with the first mate even if the canvas still says Waiting; Idle canvas changes nothing", () => {
  assert.equal(stage(task(), [agent({ status: "idle", final: "DONE: b @ c" })], { canvas: cv([], "Waiting") }).stage, "Review");
  assert.equal(stage(task(), [agent({ status: "idle", final: "BLOCKED: which one?" })], { canvas: cv([], "Waiting") }).stage, "Blocked by crew");
  assert.equal(stage(task(), [agent({ status: "idle" })], { canvas: cv([], "Idle") }).stage, "Crew stopped · no hand-back");
  assert.equal(stage(task(), [agent({ status: "idle" })]).stage, "Crew stopped · no hand-back"); // canvas not read: nothing changes
});

test("honest: BLOCKED: canvas ask q1 with the ask open on the canvas is Needs you", () => {
  const s = stage(task(), [agent({ status: "idle", final: "BLOCKED: canvas ask q1" })], { canvas: cv([{ id: "q1" }], "Needs you") });
  assert.deepEqual([s.stage, s.group], ["Needs you", "you"]);
});

// ---------- the stage model: owner, reason, and the transition fixes (T1-T12) ----------

test("every stage names its owner and a reason; owner firstmate is exactly the With-the-first-mate group", () => {
  const cases: [StageTask, StageAgent[]][] = [
    [task({ asks: [{}] }), []], [task({ asks: [{ repliedAt: "x" }] }), []], [task(), [agent()]], [task(), [agent({ status: "idle", final: "DONE: x" })]],
    [task({ state: "queued" }), []], [task({ state: "parked" }), []], [task({ state: "blocked" }), []], [task({ state: "done" }), []],
  ];
  const owners = cases.map(([t, as]) => stage(t, as));
  assert.deepEqual(owners.map((s) => s.owner), ["captain", "firstmate", "crew", "firstmate", "nobody", "nobody", "outside", "nobody"]);
  for (const s of owners) { assert.ok(s.reason.length > 0); assert.equal(s.owner === "firstmate", s.group === "fm"); }
});

test("the fingerprint changes when the situation does (a newer reply, a new final line) and not otherwise", () => {
  const a = stage(task({ asks: [{ id: "a1", repliedAt: "t1" }] }), []).fp;
  assert.equal(a, stage(task({ asks: [{ id: "a1", repliedAt: "t1" }] }), []).fp);
  assert.notEqual(a, stage(task({ asks: [{ id: "a1", repliedAt: "t2" }] }), []).fp);
  const idle = (final: string) => stage(task(), [agent({ status: "idle", final })]).fp;
  assert.notEqual(idle("DONE: a"), idle("DONE: b"));
});

test("T1: the captain replied, the first mate answered and the crew works again, but the ask is open: Running with a drift flag, not Needs you", () => {
  const t = task({ asks: [{ id: "a1", answeredAt: ago(5) }] });
  const s = stage(t, [agent({ turnStartedAt: ago(3) })]);
  assert.deepEqual([s.stage, s.group, keys(s), s.flags[0].drift], ["Running", "running", ["ask-open-after-reply"], true]);
  assert.match(s.flags[0].text, /a1/);
  // a crew that is idle again with the ask open is the captain's
  assert.equal(stage(t, [agent({ status: "idle", turnStartedAt: ago(3) })]).group, "you");
});

test("T3: a curated ask that resolved itself while the crew runs: Running plus the drift flag", () => {
  const ref = { kind: "canvas", agentId: "ag-1", block: "db" };
  const s = stage(task({ asks: [{ ref }] }), [agent()], { canvas: cv([]) });
  assert.deepEqual([s.group, keys(s)], ["running", ["ref-closed"]]);
});

test("T5: a pending permission is the captain's in every state, and beside an open ask", () => {
  const perm = agent({ pendingPermissions: 1 });
  for (const state of ["active", "queued", "parked", "blocked", "done"] as const) {
    const s = stage(task({ state }), [perm]);
    assert.deepEqual([s.stage, s.group, s.owner], ["Needs you · permission", "you", "captain"], state);
  }
  const withAsk = stage(task({ asks: [{ repliedAt: "x" }] }), [perm]);
  assert.deepEqual([withAsk.stage, keys(withAsk)], ["Needs you · permission", ["ask-open"]]);
  // an archived agent's stale permission count is ignored
  assert.notEqual(stage(task(), [agent({ pendingPermissions: 1, archived: true })]).stage, "Needs you · permission");
});

test("T6: a card-body comment on a card with 2+ asks flags the card", () => {
  const s = stage(task({ asks: [{ id: "a1" }, { id: "a2" }], commentWaiting: ago(1) }), []);
  assert.deepEqual([s.group, keys(s)], ["you", ["comment-waiting"]]);
});

test("T8: a Review whose branch is already merged is flagged as drift", () => {
  const s = stage(task({ merged: true }), [agent({ status: "idle", final: "DONE: b @ c" })]);
  assert.deepEqual([s.stage, keys(s), s.flags[0].drift], ["Review", ["merged"], true]);
  assert.deepEqual(keys(stage(task({ merged: false }), [agent({ status: "idle", final: "DONE: b @ c" })])), []);
});

test("T11: 'the crew worked since' is measured from its turn start, which a label change or a steer does not move", () => {
  const t = task({ asks: [{ id: "a1", answeredAt: ago(5) }] });
  // lastActivityAt moved 1 minute ago (a re-label), but the turn that is running started before the reply
  assert.equal(stage(t, [agent({ lastActivityAt: ago(1), turnStartedAt: ago(20) })]).flags[0].key, "ask-open-while-running");
  assert.equal(stage(t, [agent({ lastActivityAt: ago(1) })]).group, "running", "without a turn start Paseo's activity is the fallback");
});

test("the enforcer's verdict: a stalled With-the-first-mate task is Needs you, other groups are untouched; fp survives", () => {
  const fm = stage(task({ asks: [{ id: "a1", repliedAt: ago(30) }] }), []);
  const st = applyStalled(fm, "it did not act on 2 reminders");
  assert.deepEqual([st.stage, st.group, st.owner, st.fp === fm.fp, keys(st)], ["Needs you · first mate stalled", "you", "captain", true, ["first-mate-stalled"]]);
  const running = stage(task(), [agent()]);
  assert.equal(applyStalled(running, "x"), running);
});

test("a running crew outranks an open fleet ask: Running, the ask stays as a note", () => {
  const s = stage(task({ asks: [{ id: "a3" }] }), [agent()]);
  assert.deepEqual([s.stage, s.group, keys(s)], ["Running", "running", ["ask-open-while-running"]]);
  assert.equal(stage(task({ asks: [{ id: "a3" }, { id: "a4", answeredAt: ago(5) }] }), [agent({ turnStartedAt: ago(3) })]).group, "running");
  // idle again with the ask open: the captain's
  assert.equal(stage(task({ asks: [{ id: "a3" }] }), [agent({ status: "idle" })]).group, "you");
});

test("an open crew canvas question still beats a blocked note", () => {
  assert.equal(stage(task({ state: "blocked" }), [agent({ status: "idle" })], { canvas: cv([{ id: "q1" }]) }).group, "you");
});
