// The enforcer. The invariant: **if the first mate is idle, no task is "with the first mate".**
//
// Whenever the owning first mate's turn ends idle and the stage snapshot still lists tasks whose next move is its (group `fm`), the
// plugin re-wakes it with one `## With you · <project>` digest: each task, why it is there, what clears it. Per item (a task in a
// given situation, i.e. its fingerprint `fp`) that is done at most TWICE, the second after a gap, and never while the first mate is
// working or while a reminder's own turn is still running. When the turn a reminder started ends idle and the item is unchanged,
// that is the answer: after the second one the task moves to Needs you as "first mate stalled". With no live first mate at all the
// task is stalled at once. A changed situation (a new reply, a new final line) is a new item with a fresh count.
//
// It also reminds an idle crew that ended without `DONE:`/`BLOCKED:` once (T7); a crew that stays silent after that reaches the first mate.
//
// It cannot loop: reminders only go to an idle owner, one per item per gap, at most 2 per item, 1 per crew, all remembered in
// state/enforcer.json across restarts. The state it writes is the plugin's own; it never touches fleet.json.
//
// Task tree: an item belongs to the nearest live second mate above its task (snapshot.nodeOwners along the parent chain), else the
// project's first mate. A second mate that ignores an item through all its reminders does not stall it: the item moves up one
// level (a fresh count for the next owner), and only after the last owner in the chain does it reach the captain. Group rows are
// never items: their leaves are.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortSelector } from "./paseo-port.ts";
import type { Snapshot, StageRow } from "./stages-file.ts";
import { writeAtomic } from "./store.ts";

export const SETTLE_MS = 60_000;
export const GAP_MS = 30 * 60_000;
export const MAX_NUDGES = 2;
/** How long a group may change before its second mate's canvas is called stale. */
export const CANVAS_SYNC_MS = 5 * 60_000;

type Entry = {
  fp: string;
  stage: string;
  nudges: number;
  lastNudgeAt: number;
  /** A reminder was sent and the owner's turn that follows has not ended yet. */
  awaiting: boolean;
  stalled: boolean;
  why?: string;
  /** How far up the owner chain the item has been escalated (0 = the nearest owner). */
  level?: number;
};
/** A group the second mate has not caught up with: the roll-up changed at `since`; `nudged` once it was reminded for that change. */
type Sync = { fp: string; since: number; nudged: boolean };
type Store = { items: Record<string, Entry>; crews: Record<string, number>; sync?: Record<string, Sync> };

export type EnforcerOptions = {
  ports: PortSelector;
  root: () => string;
  /** The latest stage snapshot (what the page and CLI show). */
  snapshot: () => Snapshot | null;
  /** The enforcement the stage engine must apply: crews already reminded, and the tasks given up on. */
  onChange: (nudgedCrews: string[], stalled: Record<string, { fp: string; why: string }>) => void;
  log: (m: string) => void;
  now?: () => number;
  settleMs?: number;
  gapMs?: number;
  syncMs?: number;
};

/** `enforcer: off` in state/decisions.md switches the enforcer off. Anything else is on. */
export function enforcerOn(root: string): boolean {
  try {
    return !/^[ \t]*(?:[-*][ \t]+)?[*`_]*enforcer[*`_]*[ \t]*:[*`_]*[ \t]*(?:off|false|no)[*`_]*[ \t]*$/im.test(readFileSync(join(root, "state", "decisions.md"), "utf8"));
  } catch {
    return true;
  }
}

const isStalledRow = (r: StageRow) => r.flags.some((f) => f.key === "first-mate-stalled");

/** Who may act on a row, nearest first: the live second mates of the groups above it, then the project's first mate. */
export function handlersOf(snap: Snapshot, r: StageRow): string[] {
  const by = new Map(snap.rows.map((x) => [x.id, x]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let n: string | null | undefined = r.id; n && !seen.has(n); n = by.get(n)?.parent) {
    seen.add(n);
    const a = snap.nodeOwners?.[n];
    if (a && !out.includes(a)) out.push(a);
  }
  const p = snap.owners[r.project ?? ""];
  if (p && !out.includes(p)) out.push(p);
  return out;
}

const handlerAt = (hs: string[], level: number | undefined): string | undefined => hs[Math.min(level ?? 0, hs.length - 1)];

/** Every agent that owns something in this snapshot: project first mates and second mates. */
const allOwners = (snap: Snapshot): string[] => [...new Set([...Object.values(snap.owners), ...Object.values(snap.nodeOwners ?? {})].filter((x): x is string => !!x))];

export class Enforcer {
  private o: EnforcerOptions;
  private store: Store | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pending = new Set<string>();
  private stopped = false;
  private published = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: EnforcerOptions) {
    this.o = o;
  }

  private on(): boolean { return !!this.o.root() && enforcerOn(this.o.root()); }
  private now(): number { return (this.o.now ?? Date.now)(); }
  private settle(): number { return this.o.settleMs ?? SETTLE_MS; }
  private gap(): number { return this.o.gapMs ?? GAP_MS; }
  private sync(): number { return this.o.syncMs ?? CANVAS_SYNC_MS; }
  private file(): string { return join(this.o.root(), "state", "enforcer.json"); }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ---------- the store ----------

  private load(): Store {
    if (this.store) return this.store;
    let s: Store = { items: {}, crews: {} };
    try {
      const j = JSON.parse(readFileSync(this.file(), "utf8"));
      if (j && typeof j === "object") s = { items: j.items ?? {}, crews: j.crews ?? {}, sync: j.sync ?? {} };
    } catch { /* first run */ }
    return (this.store = s);
  }

  private save(): void {
    const root = this.o.root();
    if (!root || !this.store) return;
    try {
      mkdirSync(join(root, "state"), { recursive: true });
      writeAtomic(this.file(), JSON.stringify(this.store));
    } catch (e) {
      this.o.log(`enforcer state write failed: ${e}`);
    }
  }

  /** Hand the engine what it needs to show a stall / a reminded crew. Idempotent. */
  publish(): void {
    const s = this.load();
    const stalled: Record<string, { fp: string; why: string }> = {};
    for (const [task, e] of Object.entries(s.items)) if (e.stalled && e.why) stalled[task] = { fp: e.fp, why: e.why };
    this.o.onChange(Object.keys(s.crews), stalled);
  }

  // ---------- triggers ----------

  /** A fresh snapshot: drop entries whose situation ended, stall tasks nobody can clear, and arm a check for owners with work. */
  onStages(snap: Snapshot): void {
    if (this.stopped || !this.on()) return;
    const s = this.load();
    let changed = !this.published; // the first pass tells the engine what an earlier run decided
    this.published = true;
    const byId = new Map(snap.rows.map((r) => [r.id, r]));
    for (const [task, e] of Object.entries(s.items)) {
      const row = byId.get(task);
      // the item is over when the task is gone or its situation moved on; a stalled item stays while its situation does
      if (!row || row.fp !== e.fp || (row.group !== "fm" && !isStalledRow(row))) { delete s.items[task]; changed = true; }
    }
    const liveCrews = new Set(snap.rows.map((r) => r.agentId).filter(Boolean));
    for (const a of Object.keys(s.crews)) if (!liveCrews.has(a)) { delete s.crews[a]; changed = true; }
    // a task for which there is no first mate to do anything: stalled at once, the captain has to see it
    for (const r of snap.rows) {
      if (r.group !== "fm" || r.owner !== "firstmate" || r.kind === "group") continue;
      const owner = handlersOf(snap, r).length > 0;
      const e = s.items[r.id];
      if (!owner && !(e?.stalled)) {
        s.items[r.id] = { fp: r.fp, stage: r.stage, nudges: e?.nudges ?? 0, lastNudgeAt: e?.lastNudgeAt ?? 0, awaiting: false, stalled: true, why: `no first mate is claimed for ${r.project ?? "this checkout"}, so nobody can act on it: ${r.stage}: ${r.reason}` };
        changed = true;
      }
    }
    // a group that a second mate owns: remember when its roll-up last changed (the canvas-stale nudge compares the canvas with this)
    const sy = (s.sync ??= {});
    let syncChanged = false;
    for (const id of Object.keys(sy)) if (!snap.nodeOwners?.[id] || !byId.has(id)) { delete sy[id]; syncChanged = true; }
    for (const g of snap.rows) {
      if (g.kind !== "group" || !snap.nodeOwners?.[g.id]) continue;
      if (sy[g.id]?.fp !== g.fp) { sy[g.id] = { fp: g.fp, since: this.now(), nudged: false }; syncChanged = true; }
    }
    if (changed || syncChanged) this.save();
    if (changed) this.publish();
    for (const owner of allOwners(snap)) this.arm(owner);
    for (const r of snap.rows) if (r.owner === "crew" && r.stage.startsWith("Crew stopped") && r.agentId) this.arm(r.agentId);
  }

  /** `agent.turn_ended` of any agent: an owner or a stopped crew gets checked once the settle time has passed. */
  onTurnEnded(agentId: string): void {
    if (this.stopped || !this.on()) return;
    this.arm(agentId, true);
  }

  /** Called every ~30 s: reminders whose gap has elapsed come due. */
  tick(): void {
    const snap = this.o.snapshot();
    if (!snap || this.stopped || !this.on()) return;
    for (const owner of allOwners(snap)) this.arm(owner);
    for (const r of snap.rows) if (r.owner === "crew" && r.stage.startsWith("Crew stopped") && r.agentId) this.arm(r.agentId);
  }

  private arm(agentId: string, afterTurn = false): void {
    // one pending check per agent; a turn end upgrades it (the settle clock restarts from the turn end)
    const key = `${agentId}|${afterTurn ? "t" : "s"}`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.pending.delete(key);
      if (this.stopped) return;
      this.chain = this.chain.then(() => this.check(agentId, afterTurn)).catch((e) => this.o.log(`enforcer failed: ${(e as Error)?.stack ?? e}`));
    }, this.settle());
    t.unref?.();
    this.timers.add(t);
  }

  /** Test hook: run the pending checks now without waiting for the settle timer. */
  async checkNow(agentId: string, afterTurn = false): Promise<void> {
    await this.check(agentId, afterTurn);
  }

  // ---------- the checks ----------

  private async status(agentId: string): Promise<string | null> {
    const info = await this.o.ports.sdkPort()?.agentInfo(agentId).catch(() => null);
    return info?.status ?? null;
  }

  private async check(agentId: string, afterTurn: boolean): Promise<void> {
    const snap = this.o.snapshot();
    if (!snap || !this.on()) return;
    if (allOwners(snap).includes(agentId)) await this.checkOwner(agentId, snap, afterTurn);
    const crewRow = snap.rows.find((r) => r.agentId === agentId && r.owner === "crew" && r.stage.startsWith("Crew stopped"));
    if (crewRow) await this.checkCrew(agentId, crewRow);
  }

  private async checkOwner(owner: string, snap: Snapshot, afterTurn: boolean): Promise<void> {
    if ((await this.status(owner)) !== "idle") return; // working: its turn end will come back here
    const s = this.load();
    const chain = new Map<string, string[]>(snap.rows.map((r) => [r.id, handlersOf(snap, r)]));
    const items = snap.rows.filter((r) => r.group === "fm" && r.owner === "firstmate" && r.kind !== "group" && handlerAt(chain.get(r.id)!, s.items[r.id]?.fp === r.fp ? s.items[r.id].level : 0) === owner);
    let escalatedTo: string | undefined;
    let changed = false;
    // A reminder's turn has ended with the item untouched: that was the answer (or, after a long silence, assume it was).
    for (const r of items) {
      const e = s.items[r.id];
      if (!e || e.fp !== r.fp || !e.awaiting) continue;
      if (!afterTurn && this.now() - e.lastNudgeAt < this.gap()) continue;
      e.awaiting = false;
      if (e.nudges >= MAX_NUDGES) {
        const hs = chain.get(r.id)!;
        const next = hs[(e.level ?? 0) + 1];
        if (next) {
          // the owner nearest the task ignored it: the next one up takes it over with a fresh count, before it reaches the captain
          e.level = (e.level ?? 0) + 1; e.nudges = 0; e.lastNudgeAt = 0; escalatedTo = next;
          this.o.log(`enforcer: ${r.id} escalated from ${owner.slice(0, 8)} to ${next.slice(0, 8)} after ${MAX_NUDGES} reminders`);
        } else {
          e.stalled = true;
          e.why = `the first mate did not act on ${e.nudges} reminders: ${r.stage}: ${r.reason}`;
          this.o.log(`enforcer: ${r.id} stalled after ${e.nudges} reminders`);
        }
      }
      changed = true;
    }
    const due = items.filter((r) => {
      const e = s.items[r.id];
      if (e?.fp === r.fp && handlerAt(chain.get(r.id)!, e.level) !== owner) return false; // escalated just now: it is the next owner's
      if (!e || e.fp !== r.fp) return true;
      return !e.stalled && !e.awaiting && e.nudges < MAX_NUDGES && this.now() - e.lastNudgeAt >= this.gap();
    });
    if (changed) { this.save(); this.publish(); }
    if (escalatedTo) this.arm(escalatedTo);
    await this.checkCanvas(owner, snap, s);
    if (!due.length) return;
    const text = this.digest(due, s);
    try {
      await this.o.ports.send(owner, text);
    } catch (e) {
      this.o.log(`enforcer: reminder to ${owner.slice(0, 8)} failed: ${(e as Error).message}`);
      return; // not counted: it never arrived
    }
    for (const r of due) {
      const e = s.items[r.id]?.fp === r.fp ? s.items[r.id] : undefined;
      s.items[r.id] = { fp: r.fp, stage: r.stage, nudges: (e?.nudges ?? 0) + 1, lastNudgeAt: this.now(), awaiting: true, stalled: false, ...(e?.level ? { level: e.level } : {}) };
    }
    this.save();
    this.o.log(`enforcer: reminded ${owner.slice(0, 8)} about ${due.map((r) => r.id).join(", ")}`);
  }

  /**
   * Canvas-stale nudge. A second mate's canvas is the group's page for the captain; the roll-up is computed by script, but the
   * prose is the agent's. When a group's roll-up changed and, `syncMs` later, the owner's canvas is still older than the change,
   * it is reminded once per change. Not an escalation: the page already shows the live roll-up, only the prose lags.
   */
  private async checkCanvas(owner: string, snap: Snapshot, s: Store): Promise<void> {
    const sy = (s.sync ??= {});
    const stale = snap.rows.filter((g) => {
      const e = sy[g.id];
      if (g.kind !== "group" || snap.nodeOwners?.[g.id] !== owner || !e || e.fp !== g.fp || e.nudged) return false;
      if ((g.canvasAt ?? 0) >= e.since) { e.nudged = true; return false; } // it caught up on its own
      return this.now() - e.since >= this.sync();
    });
    if (!stale.length) return;
    const text = stale.map((g) => [
      `## Group changed · ${g.id}`,
      `The roll-up moved: ${g.stage}: ${g.reason}.`,
      `Your canvas has not changed since. Update it so the captain reads the current state (BLUF first, then what moved), run \`bin/fleet group-card ${g.id}\`, then end your turn. This reminder is sent once per change.`,
    ].join("\n")).join("\n\n");
    try {
      await this.o.ports.send(owner, text);
    } catch (e) {
      this.o.log(`enforcer: canvas reminder to ${owner.slice(0, 8)} failed: ${(e as Error).message}`);
      return;
    }
    for (const g of stale) sy[g.id].nudged = true;
    this.save();
    this.o.log(`enforcer: canvas reminder to ${owner.slice(0, 8)} about ${stale.map((g) => g.id).join(", ")}`);
  }

  private digest(due: StageRow[], s: Store): string {
    const byProject = new Map<string, StageRow[]>();
    for (const r of due) byProject.set(r.project ?? "", [...(byProject.get(r.project ?? "") ?? []), r]);
    const parts = [...byProject].map(([project, rows]) => {
      const lines = rows.flatMap((r) => {
        const e = s.items[r.id]?.fp === r.fp ? s.items[r.id] : undefined;
        const k = (e?.nudges ?? 0) + 1;
        return [
          `- ${r.id} · ${r.stage}${k > 1 ? ` (reminder ${k} of ${MAX_NUDGES}; the next unanswered one puts it in front of the captain as "first mate stalled")` : ""}`,
          `  why: ${r.reason}${r.owedSince ? ` (since ${r.owedSince})` : ""}`,
          `  clears: ${r.clears || "see the matching skill"}`,
        ];
      });
      return [`## With you · ${project || "(no project)"}`, `You are idle, but these tasks are still with you. Clear each one (the "clears" line says how), then end your turn.`, ...lines].join("\n");
    });
    return parts.join("\n\n");
  }

  private async checkCrew(agentId: string, row: StageRow): Promise<void> {
    const s = this.load();
    if (s.crews[agentId]) return;
    if (this.now() - (Date.parse(row.owedSince ?? "") || this.now()) < this.settle()) return;
    if ((await this.status(agentId)) !== "idle") return;
    try {
      await this.o.ports.send(agentId, [
        `## Reminder · ${row.id}`,
        "Your turn ended without a hand-back. If you are finished, end with `DONE: <branch> @ <commit>` (or `DONE:` and the one-line result); if you are stuck or need the captain, end with `BLOCKED: <the question>`.",
        "If you are only waiting on a background job, say so on your canvas (status Waiting) and carry on. This reminder is sent once.",
      ].join("\n"));
    } catch (e) {
      this.o.log(`enforcer: reminder to crew ${agentId.slice(0, 8)} failed: ${(e as Error).message}`);
      return;
    }
    s.crews[agentId] = this.now();
    this.save();
    this.publish();
    this.o.log(`enforcer: reminded crew ${agentId.slice(0, 8)} (${row.id}) to hand back`);
  }
}
