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
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortSelector } from "./paseo-port.ts";
import type { Snapshot, StageRow } from "./stages-file.ts";
import { writeAtomic } from "./store.ts";

export const SETTLE_MS = 60_000;
export const GAP_MS = 30 * 60_000;
export const MAX_NUDGES = 2;

type Entry = {
  fp: string;
  stage: string;
  nudges: number;
  lastNudgeAt: number;
  /** A reminder was sent and the owner's turn that follows has not ended yet. */
  awaiting: boolean;
  stalled: boolean;
  why?: string;
};
type Store = { items: Record<string, Entry>; crews: Record<string, number> };

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
      if (j && typeof j === "object") s = { items: j.items ?? {}, crews: j.crews ?? {} };
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
      if (r.group !== "fm" || r.owner !== "firstmate") continue;
      const owner = snap.owners[r.project ?? ""];
      const e = s.items[r.id];
      if (!owner && !(e?.stalled)) {
        s.items[r.id] = { fp: r.fp, stage: r.stage, nudges: e?.nudges ?? 0, lastNudgeAt: e?.lastNudgeAt ?? 0, awaiting: false, stalled: true, why: `no first mate is claimed for ${r.project ?? "this checkout"}, so nobody can act on it: ${r.stage}: ${r.reason}` };
        changed = true;
      }
    }
    if (changed) { this.save(); this.publish(); }
    for (const owner of new Set(Object.values(snap.owners).filter((x): x is string => !!x))) this.arm(owner);
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
    for (const owner of new Set(Object.values(snap.owners).filter((x): x is string => !!x))) this.arm(owner);
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
    const asOwner = Object.entries(snap.owners).filter(([, id]) => id === agentId).map(([p]) => p);
    if (asOwner.length) await this.checkOwner(agentId, asOwner, snap, afterTurn);
    const crewRow = snap.rows.find((r) => r.agentId === agentId && r.owner === "crew" && r.stage.startsWith("Crew stopped"));
    if (crewRow) await this.checkCrew(agentId, crewRow);
  }

  private async checkOwner(owner: string, projects: string[], snap: Snapshot, afterTurn: boolean): Promise<void> {
    if ((await this.status(owner)) !== "idle") return; // working: its turn end will come back here
    const s = this.load();
    const items = snap.rows.filter((r) => r.group === "fm" && r.owner === "firstmate" && projects.includes(r.project ?? ""));
    let changed = false;
    // A reminder's turn has ended with the item untouched: that was the answer (or, after a long silence, assume it was).
    for (const r of items) {
      const e = s.items[r.id];
      if (!e || e.fp !== r.fp || !e.awaiting) continue;
      if (!afterTurn && this.now() - e.lastNudgeAt < this.gap()) continue;
      e.awaiting = false;
      if (e.nudges >= MAX_NUDGES) {
        e.stalled = true;
        e.why = `the first mate did not act on ${e.nudges} reminders: ${r.stage}: ${r.reason}`;
        this.o.log(`enforcer: ${r.id} stalled after ${e.nudges} reminders`);
      }
      changed = true;
    }
    const due = items.filter((r) => {
      const e = s.items[r.id];
      if (!e || e.fp !== r.fp) return true;
      return !e.stalled && !e.awaiting && e.nudges < MAX_NUDGES && this.now() - e.lastNudgeAt >= this.gap();
    });
    if (changed) { this.save(); this.publish(); }
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
      s.items[r.id] = { fp: r.fp, stage: r.stage, nudges: (e?.nudges ?? 0) + 1, lastNudgeAt: this.now(), awaiting: true, stalled: false };
    }
    this.save();
    this.o.log(`enforcer: reminded ${owner.slice(0, 8)} about ${due.map((r) => r.id).join(", ")}`);
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
