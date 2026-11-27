import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./tmp.ts";
import { fileStore, startRemoteEvents, type RemoteEventsOptions, type HostClient, type HostSource, type HookName, type RemoteAgent, type RemoteApi } from "../server/remote-events.ts";

// ---------- a fake remote host (the shape hosts.client(serverId) returns, as far as remote-events reads it) ----------

type Entry = { seqStart: number; turnId?: string; item: { type: string; text?: string } };
type Observer = { snapshot(s: unknown): void; update(m: unknown): void; error?(e: unknown): void };

let seq = 0;
function agent(id: string, o: Partial<RemoteAgent> = {}): RemoteAgent {
  return {
    id, provider: "claude", cwd: "/w", workspaceId: "ws", title: id, status: "idle", activeTurn: null, pendingPermissions: [],
    archivedAt: null, updatedAt: new Date(Date.UTC(2026, 10, 27, 12, 0, seq++)).toISOString(), lastUserMessageAt: null, lastError: undefined,
    labels: { "fm.task": "t1", "paseo.parent-agent-id": "fm" }, ...o,
  };
}

class FakeHost {
  agents = new Map<string, RemoteAgent>();
  timelines = new Map<string, Entry[]>();
  observers: Observer[] = [];
  lists = 0;
  released = 0;
  refreshes: Record<string, RemoteAgent | null> = {};
  failList: Error | null = null;
  failTail: Error | null = null;
  /** Page size of the agent list (0 = everything in one page). */
  pageSize = 0;
  hangList: Promise<void> | null = null;
  api!: RemoteApi;
  readonly serverId: string;
  constructor(serverId: string) {
    this.serverId = serverId;
    this.rebuild();
  }
  rebuild(): void {
    const self = this;
    this.api = {
      agents: {
        async list(o: any) {
          self.lists++;
          if (self.hangList) await self.hangList;
          if (self.failList) throw self.failList;
          let obs: Observer | null = null;
          const all = [...self.agents.values()].map((a) => ({ agent: structuredClone(a) }));
          const size = self.pageSize || all.length || 1;
          const from = Number(o?.page?.cursor ?? 0);
          const more = from + size < all.length;
          return {
            entries: all.slice(from, from + size),
            pageInfo: { hasMore: more, nextCursor: more ? String(from + size) : null },
            subscription: {
              ready: Promise.resolve({}),
              subscribe(o: Observer) { obs = o; self.observers.push(o); return () => { self.observers = self.observers.filter((x) => x !== obs); }; },
              async release() { self.released++; self.observers = self.observers.filter((x) => x !== obs); },
            },
          };
        },
        ref(id: string) {
          return {
            timeline: { async refetch() { if (self.failTail) throw self.failTail; return { entries: structuredClone(self.timelines.get(id) ?? []) }; } },
            async refresh() { const a = id in self.refreshes ? self.refreshes[id] : self.agents.get(id) ?? null; return a ? { agent: structuredClone(a) } : null; },
          };
        },
      },
    } as unknown as RemoteApi;
  }
  /** Change an agent and push the upsert to live subscribers (a quiet change when offline). */
  upsert(a: RemoteAgent, push = true): void {
    this.agents.set(a.id, a);
    if (push) for (const o of this.observers) o.update({ type: "agent_update", payload: { kind: "upsert", agent: structuredClone(a) } });
  }
  remove(id: string): void {
    this.agents.delete(id);
    for (const o of this.observers) o.update({ type: "agent_update", payload: { kind: "remove", agentId: id } });
  }
  fail(e: Error): void { for (const o of [...this.observers]) o.error?.(e); }
}

class FakeSource implements HostSource {
  online = new Map<string, FakeHost>();
  private cbs = new Set<() => void>();
  dropped: string[] = [];
  drop(serverId: string): void { this.dropped.push(serverId); this.online.get(serverId)?.rebuild(); }
  async clients(): Promise<HostClient[]> { return [...this.online.values()].map((h) => ({ serverId: h.serverId, label: "mac", api: h.api })); }
  onChange(cb: () => void): () => void { this.cbs.add(cb); return () => this.cbs.delete(cb); }
  set(h: FakeHost, on: boolean): void { if (on) this.online.set(h.serverId, h); else this.online.delete(h.serverId); for (const cb of this.cbs) cb(); }
}

type Emitted = { name: HookName; event: any };
function setup(host = new FakeHost("srv_mac")) {
  const src = new FakeSource();
  const emitted: Emitted[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
  const runTimers = (pred: (ms: number) => boolean = () => true) => { for (const t of timers.splice(0)) if (!t.cancelled && pred(t.ms)) t.fn(); else if (!t.cancelled) timers.push(t); };
  return { host, src, emitted, timers, runTimers, start: (o: Partial<RemoteEventsOptions> = {}) => startRemoteEvents({ hosts: src, emit: (name, event) => emitted.push({ name, event }), log: () => {}, schedule, retryMs: 100, resyncMs: 600_000, syncMs: 700_000, ...o }) };
}
const names = (e: Emitted[]) => e.map((x) => x.name);
const RUN = (turnId: string) => ({ status: "running" as const, activeTurn: { turnId, startedAt: null } });

// ---------- turns ----------

test("running -> idle emits one turn_ended with the turn id and that turn's own timeline", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.timelines.set("crew", [
    { seqStart: 1, turnId: "t0", item: { type: "assistant_message", text: "DONE: old" } },
    { seqStart: 2, turnId: "t1", item: { type: "user_message", text: "go" } },
    { seqStart: 3, turnId: "t1", item: { type: "assistant_message", text: "DONE: new" } },
  ]);
  s.host.upsert(agent("crew", { status: "idle", activeTurn: null }));
  s.host.upsert(agent("crew", { status: "idle", activeTurn: null })); // a later unrelated update
  await r.flush();
  assert.deepEqual(names(s.emitted), ["agent.turn_ended"]);
  const ev = s.emitted[0].event;
  assert.equal(ev.agent.id, "crew");
  assert.equal(ev.agent.serverId, "srv_mac");
  assert.equal(ev.agent.parentAgentId, "fm");
  assert.equal(ev.turnId, "t1");
  assert.deepEqual(ev.outcome, { kind: "completed" });
  assert.deepEqual(ev.timeline.map((i: any) => i.text), ["go", "DONE: new"]);
  r.stop();
});

test("idle -> running emits turn_started; a first sighting emits nothing", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t0")));
  s.host.upsert(agent("other", { status: "idle" }));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  assert.equal(s.emitted.length, 0);
  s.host.upsert(agent("other", RUN("t5")));
  await r.flush();
  assert.deepEqual(names(s.emitted), ["agent.turn_started"]);
  assert.equal(s.emitted[0].event.agent.id, "other");
  assert.equal(s.emitted[0].event.turnId, "t5");
  r.stop();
});

test("agents without an fm.task label are ignored", async () => {
  const s = setup();
  s.host.upsert(agent("x", { ...RUN("t1"), labels: {} }));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.upsert(agent("x", { status: "idle", labels: {} }));
  await r.flush();
  assert.equal(s.emitted.length, 0);
  r.stop();
});

test("a new turn id while still running ends the old turn, then starts the new one", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.upsert(agent("crew", RUN("t2")));
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId]), [["agent.turn_ended", "t1"], ["agent.turn_started", "t2"]]);
  r.stop();
});

test("running -> error is a failed turn carrying the agent's error", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.upsert(agent("crew", { status: "error", lastError: "provider exploded" }));
  await r.flush();
  assert.deepEqual(names(s.emitted), ["agent.turn_ended"]);
  assert.deepEqual(s.emitted[0].event.outcome, { kind: "failed", error: { message: "provider exploded" } });
  r.stop();
});

// ---------- permissions ----------

test("a pending permission emits permission_requested once with the full request, and permission_resolved when it goes", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  const req = { id: "p1", provider: "claude", name: "Bash", kind: "tool", input: { command: "ls" } };
  s.host.upsert(agent("crew", { ...RUN("t1"), pendingPermissions: [req] }));
  s.host.upsert(agent("crew", { ...RUN("t1"), pendingPermissions: [req] }));
  await r.flush();
  assert.deepEqual(names(s.emitted), ["agent.permission_requested"]);
  assert.deepEqual(s.emitted[0].event.request, req);
  assert.equal(s.emitted[0].event.agent.id, "crew");
  s.host.upsert(agent("crew", { ...RUN("t1"), pendingPermissions: [] }));
  await r.flush();
  assert.deepEqual(names(s.emitted), ["agent.permission_requested", "agent.permission_resolved"]);
  assert.equal(s.emitted[1].event.requestId, "p1");
  r.stop();
});

test("a permission already pending at first sighting is emitted (nothing else would ever answer it)", async () => {
  const s = setup();
  const p0 = { id: "p0", provider: "claude", name: "Edit", kind: "tool" };
  s.host.upsert(agent("crew", { ...RUN("t1"), pendingPermissions: [p0] }));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.request?.id]), [["agent.permission_requested", "p0"]]);
  r.stop();
});

// ---------- archive / close ----------

test("archivedAt and closed each emit once", async () => {
  const s = setup();
  s.host.upsert(agent("crew", { status: "idle" }));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.upsert(agent("crew", { status: "closed" }));
  s.host.upsert(agent("crew", { status: "closed" }));
  s.host.upsert(agent("crew", { status: "closed", archivedAt: "2026-11-27T13:00:00Z" }));
  s.host.upsert(agent("crew", { status: "closed", archivedAt: "2026-11-27T13:00:00Z" }));
  await r.flush();
  assert.deepEqual(names(s.emitted), ["agent.closed", "agent.archived"]);
  assert.equal(s.emitted[1].event.archivedAt, "2026-11-27T13:00:00Z");
  r.stop();
});

test("an agent removed from the live list is looked up: archived means agent.archived", async () => {
  const s = setup();
  s.host.upsert(agent("crew", { status: "idle" }));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.refreshes.crew = agent("crew", { status: "idle", archivedAt: "2026-11-27T13:00:00Z" });
  s.host.remove("crew");
  await r.flush();
  assert.deepEqual(names(s.emitted), ["agent.archived"]);
  r.stop();
});

// ---------- offline / reconnect ----------

test("offline: the subscription is released and nothing is emitted; on reconnect a turn that ended meanwhile emits one turn_ended", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.src.set(s.host, false);
  await r.flush();
  assert.equal(s.host.released, 1);
  s.host.timelines.set("crew", [{ seqStart: 1, turnId: "t1", item: { type: "assistant_message", text: "DONE: while asleep" } }]);
  s.host.upsert(agent("crew", { status: "idle" }), false);
  await r.flush();
  assert.equal(s.emitted.length, 0);
  s.src.set(s.host, true);
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId]), [["agent.turn_ended", "t1"]]);
  assert.deepEqual(s.emitted[0].event.timeline.map((i: any) => i.text), ["DONE: while asleep"]);
  // the reconnect snapshot again: still one
  s.src.set(s.host, true);
  await r.flush();
  assert.equal(s.emitted.length, 1);
  r.stop();
});

test("a whole turn that started and ended while offline still emits turn_ended (new user message, tail's turn id)", async () => {
  const s = setup();
  s.host.upsert(agent("crew", { status: "idle", lastUserMessageAt: "2026-11-27T10:00:00Z" }));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.src.set(s.host, false);
  await r.flush();
  s.host.timelines.set("crew", [
    { seqStart: 1, turnId: "t9", item: { type: "user_message", text: "next" } },
    { seqStart: 2, turnId: "t9", item: { type: "assistant_message", text: "BLOCKED: need key" } },
  ]);
  s.host.upsert(agent("crew", { status: "idle", lastUserMessageAt: "2026-11-27T11:00:00Z" }), false);
  s.src.set(s.host, true);
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId]), [["agent.turn_ended", "t9"]]);
  r.stop();
});

test("a subscription error drops it and resubscribes after a backoff, diffing what was missed", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  assert.equal(s.host.lists, 1);
  s.host.fail(new Error("link closed"));
  await r.flush();
  assert.equal(s.host.released, 1);
  s.host.upsert(agent("crew", { status: "idle" }), false);
  s.host.failList = new Error("still down");
  s.runTimers((ms) => ms < 600_000);
  await r.flush();
  assert.equal(s.host.lists, 2);
  assert.equal(s.emitted.length, 0);
  s.host.failList = null;
  const retry = s.timers.find((t) => !t.cancelled && t.ms < 600_000);
  assert.ok(retry && retry.ms > 100, "backoff grows after a failed retry");
  s.runTimers((ms) => ms < 600_000);
  await r.flush();
  assert.equal(s.host.lists, 3);
  assert.deepEqual(names(s.emitted), ["agent.turn_ended"]);
  r.stop();
});

test("the periodic resync re-lists and catches an update the stream never delivered", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start({ resyncMs: 1000 });
  await r.flush();
  s.host.upsert(agent("crew", { status: "idle" }), false);
  s.runTimers((ms) => ms === 1000);
  await r.flush();
  assert.deepEqual(names(s.emitted), ["agent.turn_ended"]);
  r.stop();
});

test("stop releases every subscription and emits nothing after", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  r.stop();
  await r.flush();
  assert.equal(s.host.released, 1);
  s.host.upsert(agent("crew", { status: "idle" }));
  s.src.set(s.host, true);
  await r.flush();
  assert.equal(s.emitted.length, 0);
});

// ---------- across a plugin restart ----------

const done = (turnId: string, text: string, seqStart = 1): Entry => ({ seqStart, turnId, item: { type: "assistant_message", text } });

test("across a plugin restart: a turn that ended meanwhile emits exactly once, and a reported one never again", async () => {
  const root = mkdtempSync(join(tmp(), "remote-ev-"));
  const store = fileStore(() => root);
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const a = s.start({ store });
  await a.flush();
  a.stop();
  s.host.timelines.set("crew", [done("t1", "DONE: while down")]);
  s.host.upsert(agent("crew", { status: "idle" }), false);
  const b = s.start({ store });
  await b.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId]), [["agent.turn_ended", "t1"]]);
  b.stop();
  const c = s.start({ store });
  await c.flush();
  assert.equal(s.emitted.length, 1);
  c.stop();
});

test("an agent first seen after a restart with an old finished turn is only a baseline", async () => {
  const root = mkdtempSync(join(tmp(), "remote-ev-"));
  const s = setup();
  s.host.timelines.set("crew", [done("t1", "DONE: old")]);
  s.host.upsert(agent("crew", { status: "idle", lastUserMessageAt: "2026-11-27T09:00:00Z" }));
  s.src.set(s.host, true);
  const r = s.start({ store: fileStore(() => root) });
  await r.flush();
  assert.equal(s.emitted.length, 0);
  r.stop();
});

test("while the checkout is not known yet nothing is baselined: it waits, then compares with what was saved", async () => {
  const root = mkdtempSync(join(tmp(), "remote-ev-"));
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const a = s.start({ store: fileStore(() => root) });
  await a.flush();
  a.stop();
  s.host.timelines.set("crew", [done("t1", "DONE: x")]);
  s.host.upsert(agent("crew", { status: "idle" }), false);
  let ready = "";
  const b = s.start({ store: fileStore(() => ready) });
  await b.flush();
  assert.equal(s.emitted.length, 0);
  ready = root;
  s.runTimers((ms) => ms === 100);
  await b.flush();
  assert.deepEqual(names(s.emitted), ["agent.turn_ended"]);
  b.stop();
});

// ---------- turns that must not be lost, or replayed ----------

test("a finished turn with no turn id anywhere is still reported", async () => {
  const s = setup();
  s.host.upsert(agent("crew", { status: "running", activeTurn: null }));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.timelines.set("crew", [{ seqStart: 1, item: { type: "assistant_message", text: "DONE: no ids" } }]);
  s.host.upsert(agent("crew", { status: "idle" }));
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId, e.event.timeline.length]), [["agent.turn_ended", null, 1]]);
  r.stop();
});

test("a tail that cannot be read is tried again before the turn is reported without it", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.failTail = new Error("link blip");
  s.host.upsert(agent("crew", { status: "idle" }));
  await r.flush();
  assert.equal(s.emitted.length, 0);
  s.host.failTail = null;
  s.host.timelines.set("crew", [done("t1", "DONE: read later")]);
  s.runTimers((ms) => ms === 100);
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId, e.event.timeline[0]?.text]), [["agent.turn_ended", "t1", "DONE: read later"]]);
  r.stop();
});

test("a tail that never reads: the turn is reported after a few tries, without a timeline", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.failTail = new Error("broken");
  s.host.upsert(agent("crew", { status: "idle" }));
  await r.flush();
  for (let i = 0; i < 4; i++) { s.runTimers((ms) => ms === 100); await r.flush(); }
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId, e.event.timeline.length]), [["agent.turn_ended", "t1", 0]]);
  r.stop();
});

test("several turns ended while offline: one turn_ended, for the latest", async () => {
  const s = setup();
  s.host.upsert(agent("crew", { ...RUN("t1"), lastUserMessageAt: "2026-11-27T10:00:00Z" }));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.src.set(s.host, false);
  await r.flush();
  s.host.timelines.set("crew", [done("t1", "step one", 1), { seqStart: 2, turnId: "t2", item: { type: "user_message", text: "more" } }, done("t2", "DONE: both", 3)]);
  s.host.upsert(agent("crew", { status: "idle", lastUserMessageAt: "2026-11-27T11:00:00Z" }), false);
  s.src.set(s.host, true);
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId]), [["agent.turn_ended", "t2"]]);
  assert.deepEqual(s.emitted[0].event.timeline.map((i: any) => i.text), ["more", "DONE: both"]);
  s.src.set(s.host, false);
  await r.flush();
  s.src.set(s.host, true);
  await r.flush();
  assert.equal(s.emitted.length, 1);
  r.stop();
});

test("a new message with no answer yet does not replay the turn before it", async () => {
  const s = setup();
  s.host.upsert(agent("crew", { status: "idle", lastUserMessageAt: "2026-11-27T10:00:00Z" }));
  s.src.set(s.host, true);
  const r = s.start({ resyncMs: 1000 });
  await r.flush();
  s.host.timelines.set("crew", [done("t0", "DONE: old", 1), { seqStart: 2, item: { type: "user_message", text: "again" } }]);
  s.host.upsert(agent("crew", { status: "idle", lastUserMessageAt: "2026-11-27T11:00:00Z" }), false);
  s.runTimers((ms) => ms === 1000);
  await r.flush();
  assert.equal(s.emitted.length, 0);
  r.stop();
});

test("a row without a turn id after the missed turn does not hide it", async () => {
  const s = setup();
  s.host.upsert(agent("crew", { status: "idle", lastUserMessageAt: "2026-11-27T10:00:00Z" }));
  s.src.set(s.host, true);
  const r = s.start({ resyncMs: 1000 });
  await r.flush();
  s.host.timelines.set("crew", [done("t3", "DONE: three", 1), { seqStart: 2, item: { type: "plugin" } }]);
  s.host.upsert(agent("crew", { status: "idle", lastUserMessageAt: "2026-11-27T11:00:00Z" }), false);
  s.runTimers((ms) => ms === 1000);
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId]), [["agent.turn_ended", "t3"]]);
  r.stop();
});

test("a turn that failed while offline is reported as failed", async () => {
  const s = setup();
  s.host.upsert(agent("crew", { status: "idle", lastUserMessageAt: "2026-11-27T10:00:00Z" }));
  s.src.set(s.host, true);
  const r = s.start({ resyncMs: 1000 });
  await r.flush();
  s.host.timelines.set("crew", [done("t4", "trying", 1)]);
  s.host.upsert(agent("crew", { status: "error", lastError: "boom", lastUserMessageAt: "2026-11-27T11:00:00Z" }), false);
  s.runTimers((ms) => ms === 1000);
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.turnId, e.event.outcome.kind]), [["agent.turn_ended", "t4", "failed"]]);
  r.stop();
});

test("an update older than what is already known is ignored", async () => {
  const s = setup();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  const stale = agent("crew", RUN("t1"));
  s.host.upsert(agent("crew", { status: "idle" }));
  s.host.upsert(stale);
  await r.flush();
  assert.deepEqual(names(s.emitted), ["agent.turn_ended"]);
  r.stop();
});

test("turn_started carries when the turn began, when the host says", async () => {
  const s = setup();
  s.host.upsert(agent("crew", { status: "idle" }));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.upsert(agent("crew", { status: "running", activeTurn: { turnId: "t1", startedAt: "2026-11-27T11:00:00Z" } }));
  await r.flush();
  assert.equal(s.emitted[0].event.startedAt, "2026-11-27T11:00:00Z");
  r.stop();
});

// ---------- the link ----------

test("agents beyond the first page are watched too", async () => {
  const s = setup();
  s.host.pageSize = 1;
  s.host.upsert(agent("a", RUN("t1")));
  s.host.upsert(agent("b", RUN("t2")));
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  s.host.upsert(agent("b", { status: "idle" }));
  await r.flush();
  assert.deepEqual(s.emitted.map((e) => [e.name, e.event.agent.id]), [["agent.turn_ended", "b"]]);
  r.stop();
});

test("a failed subscription drops the host client, so the retry uses a new one", async () => {
  const s = setup();
  s.src.set(s.host, true);
  const r = s.start();
  await r.flush();
  const first = s.host.api;
  s.host.fail(new Error("link closed"));
  await r.flush();
  assert.deepEqual(s.src.dropped, ["srv_mac"]);
  assert.notEqual(s.host.api, first);
  r.stop();
});

test("a subscription that arrives after the list timed out is released", async () => {
  const s = setup();
  let open!: () => void;
  s.host.hangList = new Promise<void>((r) => { open = r; });
  s.src.set(s.host, true);
  const r = s.start({ callTimeoutMs: 5000 });
  await new Promise((x) => setImmediate(x));
  s.runTimers((ms) => ms === 5000);
  await r.flush();
  open();
  await new Promise((x) => setImmediate(x));
  assert.equal(s.host.released, 1);
  r.stop();
});

test("the periodic sync connects a host whose client could not be built earlier", async () => {
  const s = setup();
  const r = s.start({ syncMs: 900 });
  await r.flush();
  s.host.upsert(agent("crew", RUN("t1")));
  s.src.online.set(s.host.serverId, s.host); // no change notice
  s.runTimers((ms) => ms === 900);
  await r.flush();
  assert.equal(s.host.lists, 1);
  r.stop();
});
