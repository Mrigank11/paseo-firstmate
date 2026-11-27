import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector } from "../server/paseo-port.ts";
import { Enforcer, enforcerOn, GAP_MS, MAX_NUDGES } from "../server/enforcer.ts";
import type { Snapshot, StageRow } from "../server/stages-file.ts";
import { FakeHosts, FakeWorld, fakePaseo, type FakeHost } from "./fake-paseo.ts";

const row = (id: string, over: Partial<StageRow> = {}): StageRow => ({
  id, project: "p", state: "active", stage: "With the first mate", group: "fm", agentId: "crew-1", flags: [], owner: "firstmate",
  reason: `ask a1: the captain replied (${id})`, clears: "bin/page reply p --task " + id, fp: `fp-${id}-1`, owedSince: "2026-10-24T10:00:00Z", ...over,
});
const snap = (rows: StageRow[], owners: Record<string, string | null> = { p: "fm" }): Snapshot => ({ version: 1, writtenAt: new Date().toISOString(), pid: 1, inputsMtimeMs: 1, owners, rows });

function setup(o: { fmStatus?: "idle" | "running"; rows?: StageRow[]; owners?: Record<string, string | null>; root?: string } = {}) {
  const root = o.root ?? mkdtempSync(join(tmpdir(), "enf-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const world = new FakeWorld().add({ id: "fm", status: o.fmStatus ?? "idle", labels: { firstmate: "true" } }, { id: "crew-1", status: "idle", labels: { "fm.task": "t1" } });
  const ports = new PortSelector(new CliPort(async (a) => { if (a[0] === "send") throw new Error("daemon down"); return "[]"; }), () => {});
  ports.capture({ paseo: fakePaseo(world) }, "test");
  let clock = Date.parse("2026-10-24T12:00:00Z");
  let current = snap(o.rows ?? [row("t1")], o.owners);
  const changes: { crews: string[]; stalled: Record<string, { fp: string; why: string }> }[] = [];
  const mk = () => new Enforcer({ ports, root: () => root, snapshot: () => current, log: () => {}, now: () => clock, settleMs: 1, onChange: (crews, stalled) => changes.push({ crews, stalled }) });
  const enf = mk();
  return {
    root, world, enf, mk, changes,
    feed: (rows: StageRow[], owners?: Record<string, string | null>) => { current = snap(rows, owners ?? current.owners); enf.onStages(current); },
    advance: (ms: number) => { clock += ms; },
    toFm: () => world.sent.filter((s) => s.id === "fm"),
  };
}

test("an idle first mate that still owns a task is re-woken with a digest: the task, why it is there, how it clears", async () => {
  const s = setup();
  s.feed([row("t1")]);
  await s.enf.checkNow("fm");
  assert.equal(s.toFm().length, 1);
  const text = s.toFm()[0].text;
  assert.match(text, /^## With you · p/);
  assert.ok(text.includes("t1") && text.includes("With the first mate") && text.includes("the captain replied") && text.includes("bin/page reply p --task t1"));
  s.enf.stop();
});

test("a first mate that is working is never nudged; nothing is sent for tasks that are not its", async () => {
  const busy = setup({ fmStatus: "running" });
  busy.feed([row("t1")]);
  await busy.enf.checkNow("fm");
  assert.equal(busy.world.sent.length, 0);
  const other = setup();
  other.feed([row("t1", { group: "you", owner: "captain", stage: "Needs you" }), row("t2", { group: "running", owner: "crew", stage: "Running" })]);
  await other.enf.checkNow("fm");
  assert.equal(other.world.sent.length, 0);
  busy.enf.stop(); other.enf.stop();
});

test("limit: while a reminder's turn is still running, and before the gap, no second reminder is sent", async () => {
  const s = setup();
  s.feed([row("t1")]);
  await s.enf.checkNow("fm");
  await s.enf.checkNow("fm"); // the owner is still "in" the reminder's turn: awaiting
  await s.enf.checkNow("fm");
  assert.equal(s.toFm().length, 1);
  await s.enf.checkNow("fm", true); // that turn ended with the item untouched
  s.advance(GAP_MS - 1000);
  await s.enf.checkNow("fm");
  assert.equal(s.toFm().length, 1, "gap not elapsed");
  s.enf.stop();
});

test("limit: two reminders at most; the turn after the second ends the item as 'first mate stalled' and nothing more is ever sent", async () => {
  const s = setup();
  s.feed([row("t1")]);
  await s.enf.checkNow("fm");
  await s.enf.checkNow("fm", true);
  s.advance(GAP_MS + 1);
  await s.enf.checkNow("fm");
  assert.equal(s.toFm().length, MAX_NUDGES);
  assert.match(s.toFm()[1].text, /reminder 2 of 2/);
  assert.deepEqual(s.changes.at(-1)?.stalled ?? {}, {}, "not stalled until the second reminder's turn is over");
  await s.enf.checkNow("fm", true);
  const stalled = s.changes.at(-1)!.stalled;
  assert.deepEqual(Object.keys(stalled), ["t1"]);
  assert.equal(stalled.t1.fp, "fp-t1-1");
  assert.match(stalled.t1.why, /did not act on 2 reminders/);
  // however long it sits and however often it is checked, no third reminder
  for (let i = 0; i < 20; i++) { s.advance(GAP_MS * 3); await s.enf.checkNow("fm"); await s.enf.checkNow("fm", true); s.feed([row("t1", { group: "you", owner: "captain", stage: "Needs you · first mate stalled", flags: [{ key: "first-mate-stalled", text: "x", drift: true }] })]); }
  assert.equal(s.toFm().length, MAX_NUDGES);
  s.enf.stop();
});

test("a changed situation is a new item with a fresh count; an item that cleared is forgotten", async () => {
  const s = setup();
  s.feed([row("t1")]);
  await s.enf.checkNow("fm");
  await s.enf.checkNow("fm", true);
  // the first mate acted: the comment was answered and the captain replied again (new fingerprint)
  s.feed([row("t1", { fp: "fp-t1-2", reason: "ask a1: the captain replied again" })]);
  await s.enf.checkNow("fm");
  assert.equal(s.toFm().length, 2);
  assert.ok(!/reminder 2 of 2/.test(s.toFm()[1].text), "counted from 1 again");
  // cleared: no more
  s.feed([]);
  s.advance(GAP_MS * 2);
  await s.enf.checkNow("fm");
  assert.equal(s.toFm().length, 2);
  s.enf.stop();
});

test("with no live first mate the task is stalled at once and nobody is messaged", () => {
  const s = setup({ owners: { p: null } });
  s.feed([row("t1")]);
  const stalled = s.changes.at(-1)!.stalled;
  assert.match(stalled.t1.why, /no first mate is claimed for p/);
  assert.equal(s.world.sent.length, 0);
  s.enf.stop();
});

test("a reminder that cannot be delivered is not counted", async () => {
  const s = setup();
  s.feed([row("t1")]);
  s.world.sendFails = true;
  await s.enf.checkNow("fm");
  s.world.sendFails = false;
  await s.enf.checkNow("fm");
  assert.equal(s.toFm().length, 1);
  assert.doesNotMatch(s.toFm()[0].text, /reminder 2/);
  s.enf.stop();
});

test("the count survives a plugin restart: a new enforcer on the same state does not start over", async () => {
  const s = setup();
  s.feed([row("t1")]);
  await s.enf.checkNow("fm");
  s.enf.stop();
  const again = s.mk();
  again.onStages(snap([row("t1")]));
  await again.checkNow("fm", true);
  await again.checkNow("fm"); // gap not elapsed after the restart
  assert.equal(s.toFm().length, 1);
  s.advance(GAP_MS + 1);
  await again.checkNow("fm");
  assert.equal(s.toFm().length, 2);
  await again.checkNow("fm", true);
  s.advance(GAP_MS * 5);
  await again.checkNow("fm");
  assert.equal(s.toFm().length, 2, "never a third");
  again.stop();
});

test("an idle crew with no hand-back is reminded once, then reaches the first mate", async () => {
  const s = setup({ rows: [] });
  const stopped = row("t1", { group: "running", owner: "crew", stage: "Crew stopped · no hand-back", agentId: "crew-1", owedSince: "2026-10-24T11:00:00Z", fp: "fp-crew" });
  s.feed([stopped], { p: "fm" });
  await s.enf.checkNow("crew-1");
  const toCrew = s.world.sent.filter((x) => x.id === "crew-1");
  assert.equal(toCrew.length, 1);
  assert.match(toCrew[0].text, /DONE:/);
  assert.deepEqual(s.changes.at(-1)!.crews, ["crew-1"]);
  await s.enf.checkNow("crew-1");
  assert.equal(s.world.sent.filter((x) => x.id === "crew-1").length, 1, "once");
  s.enf.stop();
});

test("a crew that is working again is not reminded", async () => {
  const s = setup({ rows: [] });
  s.world.agents.get("crew-1")!.status = "running";
  s.feed([row("t1", { group: "running", owner: "crew", stage: "Crew stopped · no hand-back", agentId: "crew-1", owedSince: "2026-10-24T11:00:00Z" })]);
  await s.enf.checkNow("crew-1");
  assert.equal(s.world.sent.length, 0);
  s.enf.stop();
});

test("enforcer: off in decisions.md switches it off", async () => {
  const s = setup();
  writeFileSync(join(s.root, "state", "decisions.md"), "# d\n- enforcer: off\n");
  assert.equal(enforcerOn(s.root), false);
  s.feed([row("t1")]);
  await s.enf.checkNow("fm");
  assert.equal(s.world.sent.length, 0);
  writeFileSync(join(s.root, "state", "decisions.md"), "# d\n- enforcer: on\n");
  assert.equal(enforcerOn(s.root), true);
  s.enf.stop();
});

test("state/enforcer.json records the count so the next run knows", async () => {
  const s = setup();
  s.feed([row("t1")]);
  await s.enf.checkNow("fm");
  const saved = JSON.parse(readFileSync(join(s.root, "state", "enforcer.json"), "utf8"));
  assert.deepEqual([saved.items.t1.nudges, saved.items.t1.awaiting, saved.items.t1.stalled], [1, true, false]);
  s.enf.stop();
});

// ---------- crews on other Paseo hosts ----------

const away = (id: string) => row(id, { host: "mac", group: "running", owner: "crew", stage: "Unknown · mac offline", fp: `Unknown|${id}`, flags: [{ key: "host-offline", text: "mac offline since 2026-10-24T11:00:00Z", drift: false }] });

test("a host going offline does not reset a task's reminder count", async () => {
  const s = setup();
  s.feed([row("t1", { host: "mac" })]);
  await s.enf.checkNow("fm");
  await s.enf.checkNow("fm", true);
  s.feed([away("t1")]); // the Mac sleeps
  s.advance(GAP_MS + 1);
  await s.enf.checkNow("fm");
  assert.equal(s.toFm().length, 1, "nothing to do while it is unknown");
  s.feed([row("t1", { host: "mac" })]); // and wakes in the same situation
  await s.enf.checkNow("fm");
  assert.equal(s.toFm().length, 2);
  assert.match(s.toFm()[1].text, /reminder 2 of 2/);
  s.enf.stop();
});

test("a reminder to a crew on a hung host never holds up the first mate's", async () => {
  const s = setup();
  const mac: FakeHost = { serverId: "srv_mac", label: "mac", world: new FakeWorld().add({ id: "far", status: "idle", labels: { "fm.task": "t2" } }) };
  const ports = new PortSelector(new CliPort(async () => "[]"), () => {});
  ports.capture({ paseo: fakePaseo(s.world, new FakeHosts(mac)) }, "test");
  await ports.current().listAgents();
  mac.world.hang = true;
  const current = snap([row("t1"), row("t2", { host: "mac", agentId: "far", owner: "crew", group: "running", stage: "Crew stopped · no hand-back" })]);
  const enf = new Enforcer({ ports, root: () => s.root, snapshot: () => current, log: () => {}, settleMs: 1, onChange: () => {} });
  enf.onTurnEnded("far");
  await new Promise((r) => setTimeout(r, 20));
  enf.onTurnEnded("fm");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.toFm().length, 1);
  enf.stop(); s.enf.stop();
  ports.sdkPort()!.hosts!.stop();
});
