// The finish gate and notifier (S4). Paseo notifies a parent of a crew agent's finish only once, so a narration-only first
// finish uses it up. The gate reads every `agent.turn_ended` of an `fm.task` agent, applies the completion gate from CLAUDE.md
// (the first line of the final message starts DONE: / BLOCKED:) and, for agents carrying `fm.notify=plugin` while
// state/decisions.md says `notify: plugin`, wakes the first mate with a `## Crew <VERDICT> · <task>` message.
// Without the switch (or the label) it only audits: every decision is appended to state/gate-log.jsonl (shadow mode).
// A strict crew (`canvas.strict=on`) that ends `BLOCKED: canvas ask <id>` with no such open Ask on its canvas (agent-canvas refused
// the question, so the canvas lacks the structure) is sent back once with the plugin's error; it is neither logged as a verdict nor
// woken on. The second time it is an ordinary BLOCKED.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortSelector } from "./paseo-port.ts";
import { projectClaimedId, claimedId } from "./claims.ts";

export type Verdict = "DONE" | "BLOCKED" | "ERROR" | "CANCELED" | "CLOSED" | "NARRATION";
export type GateResult = "woke" | "shadow" | "deferred" | "failed" | "narration" | "near-miss" | "no-target" | "bounced";

export type GateEntry = {
  at: string;
  agentId: string;
  task: string;
  turnId: string | null;
  verdict: Verdict;
  line: string;
  /** True only when a wake message was delivered. */
  acted: boolean;
  result: GateResult;
  /** Where it went (agent id), or why it did not. */
  note?: string;
};

/** The timeline items the gate reads (structurally a subset of AgentTimelineItem). */
export type GateItem = { type: string; text?: string };

export const SETTLE_RECHECK_MS = 60_000;
export const SWEEP_WINDOW_MS = 6 * 3600_000;
export const SWEEP_EVERY_MS = 10 * 60_000;
const SEND_ATTEMPTS = 3;
const PARENT_LABEL = "paseo.parent-agent-id";

/** `notify: plugin` in state/decisions.md (bullet, bold and backticks tolerated). Anything else, or no file, is off. */
export function notifySwitchOn(root: string): boolean {
  try {
    const text = readFileSync(join(root, "state", "decisions.md"), "utf8");
    return /^[ \t]*(?:[-*][ \t]+)?[*`_]*notify[*`_]*[ \t]*:[*`_]*[ \t]*plugin[*`_]*[ \t]*$/m.test(text);
  } catch {
    return false;
  }
}

/**
 * The verdict of a finished turn from its timeline: the trailing run of assistant messages (the final message; streamed
 * chunks arrive as several items), after the last user message and with no tool call in between. Its first non-empty line
 * decides; a DONE:/BLOCKED: line anywhere later is only a near-miss.
 */
export function messageVerdict(items: readonly GateItem[]): { verdict: "DONE" | "BLOCKED" | "NARRATION"; line: string; nearMiss?: string } {
  const run: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === "user_message" || it.type === "tool_call") break;
    if (it.type === "assistant_message" && typeof it.text === "string") run.unshift(it.text);
  }
  const lines = run.join("").split("\n").map((l) => l.trimEnd());
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return { verdict: "NARRATION", line: "" };
  const line = lines[first].trimStart();
  const v = /^DONE:/.test(line) ? "DONE" : /^BLOCKED:/.test(line) ? "BLOCKED" : "NARRATION";
  if (v !== "NARRATION") return { verdict: v, line };
  const late = lines.slice(first + 1).find((l) => /^(DONE|BLOCKED):/.test(l));
  return { verdict: "NARRATION", line, ...(late ? { nearMiss: late } : {}) };
}

/** The agent's parent while it is live, else the project's claimed first mate, else the checkout-wide claim. */
export async function wakeTarget(ports: PortSelector, root: string, parentId: string | null, project: string | undefined): Promise<string | null> {
  const live = await ports.current().listAgents();
  if (parentId && live.some((a) => a.id === parentId && !a.archived)) return parentId;
  for (const c of [project ? projectClaimedId(root, project) : null, claimedId(root)]) {
    if (c && live.some((a) => a.id === c && !a.archived)) return c;
  }
  return null;
}

export type GateAgentInfo = { id: string; status: string; labels: Record<string, string>; archived: boolean; updatedAt: string | null };

export type TurnEndedEvent = {
  agent: { id: string; parentAgentId?: string | null };
  turnId: string | null;
  outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason?: string };
  timeline: readonly GateItem[];
};

/** What the bounce reads from agent-canvas: the agent's open asks and the last write it refused (`/api/fm/summary`). */
export type CanvasLookup = (agentId: string) => Promise<{ openAsks: { id: string }[]; lastRejection?: unknown } | null>;

/** The plugin's refusal text out of `lastRejection` (a string, or `{error}` / `{errors}` as agent-canvas returns it). */
export function rejectionText(r: unknown): string {
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    const o = r as { error?: unknown; errors?: unknown; message?: unknown };
    if (typeof o.error === "string") return o.error;
    if (Array.isArray(o.errors)) return o.errors.map(String).join("\n");
    if (typeof o.message === "string") return o.message;
  }
  return "";
}

export type GateOptions = {
  ports: PortSelector;
  root: () => string;
  firstmateLabel: () => string;
  /** Where a strict crew's canvas is read for the needs-you bounce. Absent or null = no check (the BLOCKED goes through). */
  canvas?: CanvasLookup;
  log: (m: string) => void;
  now?: () => number;
  settleMs?: number;
  sweepEveryMs?: number;
  retryDelayMs?: number;
};

export class Gate {
  private o: GateOptions;
  private seen: Set<string> | null = null;
  private lastByAgent = new Map<string, { verdict: Verdict; line: string }>();
  private bounced = new Set<string>(); // agentId|askId already sent back once (also from the log, so a restart keeps it)
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private stopped = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: GateOptions) {
    this.o = o;
  }

  private now(): number { return (this.o.now ?? Date.now)(); }
  private logPath(): string { return join(this.o.root(), "state", "gate-log.jsonl"); }

  start(): void {
    // At plugin start-up, without waiting for a handle. The root is only known once the deck has read its settings, so retry briefly.
    const boot = (left: number) => {
      if (this.stopped) return;
      if (!this.root() && left > 0) return this.later(() => boot(left - 1), 1000);
      void this.sweepCli().catch((e) => this.o.log(`gate cli sweep failed: ${e}`));
    };
    boot(15);
    this.sweepTimer = setInterval(() => void (this.o.ports.sdkPort() ? this.sweep() : this.sweepCli()).catch((e) => this.o.log(`gate sweep failed: ${e}`)), this.o.sweepEveryMs ?? SWEEP_EVERY_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ---------- the log ----------

  private load(): Set<string> {
    if (this.seen) return this.seen;
    const seen = new Set<string>();
    try {
      for (const l of readFileSync(this.logPath(), "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          const e = JSON.parse(l) as GateEntry;
          if (e.result === "woke" || e.result === "shadow") seen.add(this.key(e.agentId, e.turnId, e.verdict, e.line));
          if (e.result === "woke" || e.result === "shadow" || e.result === "narration") this.lastByAgent.set(e.agentId, { verdict: e.verdict, line: e.line });
          if (e.result === "bounced" && e.note) this.bounced.add(`${e.agentId}|${e.note.split(" ")[0]}`);
        } catch {}
      }
    } catch {}
    return (this.seen = seen);
  }

  // a missed turn (sweep, close) has no turn id: the line stands in for it
  private key(agentId: string, turnId: string | null, verdict: string, line: string): string { return `${agentId}|${turnId ?? `~${line}`}|${verdict}`; }

  private append(e: Omit<GateEntry, "at">): void {
    const entry: GateEntry = { at: new Date(this.now()).toISOString(), ...e };
    const seen = this.load();
    if (e.result === "woke" || e.result === "shadow") seen.add(this.key(e.agentId, e.turnId, e.verdict, e.line));
    if (e.result === "woke" || e.result === "shadow" || e.result === "narration") this.lastByAgent.set(e.agentId, { verdict: e.verdict, line: e.line });
    try {
      mkdirSync(join(this.o.root(), "state"), { recursive: true });
      appendFileSync(this.logPath(), JSON.stringify(entry) + "\n");
    } catch (err) {
      this.o.log(`gate-log write failed: ${err}`);
    }
  }

  // ---------- agents ----------

  private async info(id: string): Promise<GateAgentInfo | null> {
    const sdk = this.o.ports.sdkPort();
    return sdk ? sdk.agentInfo(id) : null;
  }

  // ---------- events ----------

  /** `agent.turn_ended`. Handlers run serially per event in the daemon; the chain also serialises our own async work. */
  onTurnEnded(ev: TurnEndedEvent): Promise<void> {
    return this.enqueue(() => this.handleTurn(ev, true));
  }

  /** `agent.closed` of a plugin-notified agent. */
  onClosed(ev: { agent: { id: string; parentAgentId?: string | null } }): Promise<void> {
    return this.enqueue(async () => {
      const info = await this.info(ev.agent.id);
      const task = info?.labels["fm.task"];
      if (!info || !task || !this.root()) return;
      const line = "agent closed";
      await this.decide({ agentId: ev.agent.id, task, turnId: null, verdict: "CLOSED", line, labels: info.labels, parentId: ev.agent.parentAgentId ?? info.labels[PARENT_LABEL] ?? null });
    });
  }

  private root(): string { return this.o.root(); }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn).catch((e) => this.o.log(`gate failed: ${(e as Error)?.stack ?? e}`));
    this.chain = run;
    return run as Promise<void>;
  }

  private async handleTurn(ev: TurnEndedEvent, allowRecheck: boolean): Promise<void> {
    if (this.stopped || !this.root()) return;
    const id = ev.agent.id;
    const info = await this.info(id);
    const task = info?.labels["fm.task"];
    if (!info || !task) return; // not crew
    const base = { agentId: id, task, turnId: ev.turnId, labels: info.labels, parentId: ev.agent.parentAgentId ?? info.labels[PARENT_LABEL] ?? null };

    if (ev.outcome.kind === "failed") return this.decide({ ...base, verdict: "ERROR", line: ev.outcome.error.message });
    if (ev.outcome.kind === "canceled") return this.decide({ ...base, verdict: "CANCELED", line: ev.outcome.reason ?? "canceled" });

    const m = messageVerdict(ev.timeline);
    if (m.verdict === "NARRATION") {
      this.append({ agentId: id, task, turnId: ev.turnId, verdict: "NARRATION", line: m.line, acted: false, result: "narration" });
      if (m.nearMiss) this.append({ agentId: id, task, turnId: ev.turnId, verdict: "NARRATION", line: m.nearMiss, acted: false, result: "near-miss", note: "DONE:/BLOCKED: not on the first line; not acted on" });
      return;
    }
    // Settle rule: a step-scoped turn can end while the agent keeps working. Only an idle (or closed) agent is finished.
    const fresh = (await this.info(id)) ?? info;
    if (fresh.status !== "idle" && fresh.status !== "closed") {
      this.append({ agentId: id, task, turnId: ev.turnId, verdict: m.verdict, line: m.line, acted: false, result: "deferred", note: `agent is ${fresh.status}; re-evaluated on the next turn end` });
      if (allowRecheck) this.later(() => this.enqueue(() => this.handleTurn(ev, false)), this.o.settleMs ?? SETTLE_RECHECK_MS);
      return;
    }
    if (m.verdict === "BLOCKED" && (await this.bounce(id, task, ev.turnId, m.line, info.labels))) return;
    await this.decide({ ...base, verdict: m.verdict, line: m.line });
  }

  /**
   * A strict crew's `BLOCKED: canvas ask <id>` while its canvas holds no such open Ask: send it back once with agent-canvas's
   * refusal. True = bounced (the BLOCKED is not a finish). False = nothing to bounce (not strict, ask is open, canvas unreachable,
   * or this ask was already bounced once), so the caller treats it as a normal BLOCKED.
   */
  private async bounce(agentId: string, task: string, turnId: string | null, line: string, labels: Record<string, string>): Promise<boolean> {
    if (labels["canvas.strict"] !== "on" || !this.o.canvas) return false;
    const askId = /^BLOCKED:\s*canvas ask\s+([\w-]+)/i.exec(line)?.[1];
    if (!askId) return false;
    this.load();
    const key = `${agentId}|${askId}`;
    if (this.bounced.has(key)) return false;
    const s = await this.o.canvas(agentId).catch(() => null);
    if (!s || s.openAsks.some((a) => a.id === askId)) return false;
    const why = rejectionText(s.lastRejection) || "agent-canvas has no refusal on record: the canvas has no open Ask with that id.";
    const message = [
      `## Canvas question not accepted · ${task}`,
      `You ended with "${line}", but your canvas has no open Ask "${askId}", so it was not put in front of the captain and nobody was woken.`,
      "agent-canvas said:",
      why,
      `Fix the canvas (rewrite the sections, do not append), confirm the write succeeded, then end your turn with BLOCKED: canvas ask ${askId} again. This reminder is sent once.`,
    ].join("\n");
    try {
      await this.o.ports.send(agentId, message);
    } catch (e) {
      this.append({ agentId, task, turnId, verdict: "BLOCKED", line, acted: false, result: "failed", note: `bounce not sent: ${(e as Error).message.slice(0, 160)}` });
      return false;
    }
    this.bounced.add(key);
    this.append({ agentId, task, turnId, verdict: "BLOCKED", line, acted: false, result: "bounced", note: `${askId} sent back to the crew; no wake` });
    return true;
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  /** Log the decision and, in notify mode, wake the first mate. Deduped on (agent, turn, verdict) across restarts. */
  private async decide(d: { agentId: string; task: string; turnId: string | null; verdict: Verdict; line: string; labels: Record<string, string>; parentId: string | null }): Promise<void> {
    const seen = this.load();
    if (seen.has(this.key(d.agentId, d.turnId, d.verdict, d.line))) return;
    const notify = d.labels["fm.notify"] === "plugin" && notifySwitchOn(this.root());
    const rec = { agentId: d.agentId, task: d.task, turnId: d.turnId, verdict: d.verdict, line: d.line };
    if (!notify) {
      this.append({ ...rec, acted: false, result: "shadow", note: d.labels["fm.notify"] === "plugin" ? "switch off (decisions.md notify: plugin)" : "no fm.notify=plugin label" });
      return;
    }
    const message = [
      `## Crew ${d.verdict} · ${d.task}`,
      d.verdict === "DONE" || d.verdict === "BLOCKED" ? d.line : `${d.verdict}: ${d.line}`,
      `agent ${d.agentId} · ${d.labels["fm.shape"] ?? "?"} · project ${d.labels["fm.project"] ?? "-"}${d.turnId ? ` · turn ${d.turnId}` : ""}`,
    ].join("\n");
    let lastErr = "";
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      try {
        const target = await this.target(d.parentId, d.labels["fm.project"]);
        if (!target) { this.append({ ...rec, acted: false, result: "no-target", note: "no live parent and no first-mate claim" }); return; }
        await this.o.ports.send(target, message);
        this.append({ ...rec, acted: true, result: "woke", note: target });
        return;
      } catch (e) {
        lastErr = (e as Error).message;
        if (attempt < SEND_ATTEMPTS) await new Promise((r) => setTimeout(r, this.o.retryDelayMs ?? 2000));
      }
    }
    this.append({ ...rec, acted: false, result: "failed", note: lastErr.slice(0, 200) });
  }

  private target(parentId: string | null, project: string | undefined): Promise<string | null> {
    return wakeTarget(this.o.ports, this.root(), parentId, project);
  }

  // ---------- startup sweep ----------

  /**
   * The same sweep without an SDK handle, for plugin start-up (a handle only arrives with the first hook or RPC). The CLI
   * shows no labels, so it asks per task: for every task `state/fleet.json` holds as active it lists agents carrying
   * `fm.task=<id>` + `fm.notify=plugin` (a label filter, so the labels are known) and peeks with `sweepInfo`. Only plugin-notified
   * agents are swept this way; the SDK sweep (first handle, then every 10 min) covers the rest and, via the log, never repeats it.
   */
  async sweepCli(): Promise<number> {
    const cli = this.o.ports.cli;
    if (!cli.sweepInfo || !this.root() || this.sweeping || this.stopped) return 0;
    this.sweeping = true;
    let n = 0;
    try {
      this.load();
      let tasks: { id?: string; project?: string; shape?: string; state?: string }[] = [];
      try { tasks = JSON.parse(readFileSync(join(this.root(), "state", "fleet.json"), "utf8"))?.tasks ?? []; } catch {}
      // the label filter below matches fm.task only; plugin-notified agents are those a second filter also lists
      const notified = new Set((await cli.listAgents({ label: "fm.notify=plugin" }).catch(() => [])).map((x) => x.id));
      for (const t of tasks) {
        if (!t.id || t.state !== "active") continue;
        const found = await cli.listAgents({ label: `fm.task=${t.id}` }).catch(() => []);
        for (const a of found) {
          if (a.status !== "idle") continue;
          const labels: Record<string, string> = { "fm.task": t.id, "fm.notify": "plugin", ...(t.project ? { "fm.project": t.project } : {}), ...(t.shape ? { "fm.shape": t.shape } : {}) };
          if (!notified.has(a.id)) continue;
          const info = await cli.sweepInfo(a.id).catch(() => null);
          if (!info?.finalLine || info.status !== "idle") continue;
          if (this.now() - (Date.parse(info.updatedAt ?? "") || 0) > SWEEP_WINDOW_MS) continue;
          const verdict = info.finalLine.startsWith("DONE:") ? "DONE" : "BLOCKED";
          const last = this.lastByAgent.get(a.id);
          if (last && last.verdict === verdict && last.line === info.finalLine) continue;
          await this.enqueue(async () => {
            await this.decide({ agentId: a.id, task: t.id!, turnId: null, verdict, line: info.finalLine!, labels, parentId: info.parentAgentId });
            n++;
          });
        }
      }
    } finally {
      this.sweeping = false;
    }
    if (n) this.o.log(`gate sweep (cli): ${n} missed finish(es) handled`);
    return n;
  }

  /**
   * Idle `fm.task` agents updated within the window whose final message is DONE:/BLOCKED: and that the log does not already
   * hold (same verdict and line as their latest entry). Covers turns that ended while the plugin was down. Needs the SDK
   * handle (the CLI shows no labels), so it runs when the first hook or RPC hands one over, and then every SWEEP_EVERY_MS.
   */
  async sweep(): Promise<number> {
    const sdk = this.o.ports.sdkPort();
    if (!sdk || !this.root() || this.sweeping || this.stopped) return 0;
    this.sweeping = true;
    let n = 0;
    try {
      this.load();
      const agents = await sdk.listAgents({ label: "fm.task" });
      for (const a of agents) {
        if (a.archived || a.status !== "idle") continue;
        const age = this.now() - (Date.parse(a.updatedAt ?? "") || 0);
        if (age > SWEEP_WINDOW_MS) continue;
        const items = await sdk.tailItems(a.id).catch(() => null);
        if (!items) continue;
        const m = messageVerdict(items);
        if (m.verdict === "NARRATION") continue;
        const last = this.lastByAgent.get(a.id);
        if (last && last.verdict === m.verdict && last.line === m.line) continue;
        await this.enqueue(async () => {
          // turnId is unknown for a missed turn; the sweep key is the line itself so a re-run is a no-op
          await this.decide({ agentId: a.id, task: a.labels["fm.task"], turnId: null, verdict: m.verdict, line: m.line, labels: a.labels, parentId: a.labels[PARENT_LABEL] ?? null });
          n++;
        });
      }
    } finally {
      this.sweeping = false;
    }
    if (n) this.o.log(`gate sweep: ${n} missed finish(es) handled`);
    return n;
  }
}
