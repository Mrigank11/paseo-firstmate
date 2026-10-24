// computeStage: the ONE place a task's stage (running, needs you, with the first mate, done...) is decided.
// Pure, no I/O. The page, the sidebar summary, `bin/fleet stage(s)` and `bin/page status` all call it, so they cannot
// disagree. The registry (fleet.json) only holds the first mate's intent (`state`); everything about what the crew is
// doing comes from Paseo (agents found by their `fm.task` label), never from a copied status.

export type GroupKey = "you" | "fm" | "running" | "blocked" | "next" | "parked" | "done";
export type TaskState = "queued" | "active" | "parked" | "blocked" | "done" | "failed";

/** One Paseo agent as the stage engine sees it. */
export type StageAgent = {
  id: string;
  /** Paseo's status: initializing | idle | running | error | closed, or "unknown" when it could not be read. */
  status: string;
  archived: boolean;
  createdAt?: string | null;
  lastActivityAt?: string | null;
  pendingPermissions: number;
  /** The agent's `DONE:` / `BLOCKED:` line, when known. */
  final?: string;
  /** Its `canvas.relay` label names this agent (the first mate), and that agent is gone: a canvas pick would go nowhere. */
  relayGone?: string;
};

/** What a badge on the card says. `drift` flags are the registry and Paseo disagreeing: the first mate should act. */
export type StageFlag = { key: string; text: string; drift: boolean };

export type Stage = {
  /** Human label: "Running", "Needs you", "Review"... */
  stage: string;
  group: GroupKey;
  agentId: string | null;
  flags: StageFlag[];
  /** The stage is a failure (done-failed, errored agent): the card gets the failed chip. */
  failed: boolean;
};

/** The parts of a task the engine reads (state.ts `Task` fits; so does the CLI's). */
export type StageTask = {
  state: TaskState;
  /** When `state` last changed (ISO). Used only for the Dispatching -> Lost grace window. */
  since?: string;
  blocked_on?: string;
  asks: { repliedAt?: string; ref?: AskRef }[];
};

/** A curated (registry) ask that mirrors a question on the crew's canvas: `bin/fleet ask --ref`. The text and options are read live from the canvas. */
export type AskRef = { kind?: string; agentId?: string; block?: string };

/**
 * What the current agent's canvas says (agent-canvas `/api/fm/summary`), reduced to what a stage depends on.
 * `asks` are the canvas asks still open; `pending` is a captain pick waiting on the first mate. Absent = the canvas was not
 * read (no canvas, or agent-canvas unreachable), which changes nothing.
 */
export type CanvasInput = { asks: { id: string; pending: boolean }[]; verdict?: string };

export const SILENT_MS = 30 * 60_000;
export const DISPATCH_GRACE_MS = 10 * 60_000;

const RUNNING = new Set(["running", "initializing"]);

/** The registry's intent `state` (v2). Anything else reads as `queued`. */
export function stateOf(raw: { state?: unknown }): TaskState {
  return (["queued", "active", "parked", "blocked", "done", "failed"] as const).find((x) => x === raw.state) ?? "queued";
}

/** An archive line is history: its verdict is `outcome` (v2 lines), else `state`, else a v1 line's `status`. Done unless it says failed. */
export function archiveStateOf(raw: { outcome?: unknown; state?: unknown; status?: unknown }): TaskState {
  return raw.outcome === "failed" || raw.state === "failed" || raw.status === "failed" ? "failed" : "done";
}

const ms = (iso: string | null | undefined): number => Date.parse(iso ?? "") || 0;

/** The current agent: the newest non-archived one by createdAt; if every agent is archived, the newest archived one. */
export function currentAgent<A extends { archived: boolean; createdAt?: string | null }>(agents: readonly A[]): A | undefined {
  const newest = (xs: A[]) => xs.reduce<A | undefined>((a, b) => (!a || ms(b.createdAt) >= ms(a.createdAt) ? b : a), undefined);
  return newest(agents.filter((a) => !a.archived)) ?? newest(agents.filter((a) => a.archived));
}

const flag = (key: string, text: string, drift = false): StageFlag => ({ key, text, drift });

/**
 * `opts.archived`: the task is an archive line (history, frozen): its stage is its verdict and Paseo is not consulted.
 * `opts.finalKnown` false: the caller cannot read agents' last message (the CLI): an idle agent is reported as idle
 * without guessing "no DONE:".
 */
export function computeStage(task: StageTask, agents: readonly StageAgent[], now: Date, opts: { archived?: boolean; finalKnown?: boolean; canvas?: CanvasInput } = {}): Stage {
  const cur = currentAgent(agents);
  // flags every live stage carries (a canvas verdict, a curated ask the canvas already resolved); set below, after the done branch
  let extra: StageFlag[] = [];
  const out = (stage: string, group: GroupKey, flags: StageFlag[] = [], failed = false): Stage => ({ stage, group, agentId: cur?.id ?? null, flags: [...flags, ...extra], failed });

  if (opts.archived || task.state === "done" || task.state === "failed") {
    const failed = task.state === "failed";
    const label = failed ? "Failed" : "Done";
    if (!opts.archived) {
      // a finished task keeps an open ask visible: an ask is never hidden
      if (task.asks.length) return out(task.asks.some((a) => !a.repliedAt) ? "Needs you" : "With the first mate", task.asks.some((a) => !a.repliedAt) ? "you" : "fm", [], failed);
      if (cur && RUNNING.has(cur.status) && !cur.archived) return out(label, "done", [flag("done-but-running", "done, but an agent is still running", true)], failed);
    }
    return out(label, "done", [], failed);
  }

  const canvas = !cur || cur.archived ? undefined : opts.canvas;
  if (cur && !cur.archived && cur.relayGone) extra.push(flag("relay-target-gone", `canvas relay target ${cur.relayGone.slice(0, 8)} is gone: bin/page claim re-points it`, true));
  if (canvas?.verdict === "Disputed") extra.push(flag("canvas-disputed", "canvas: status disputed"));
  if (canvas?.verdict === "Stale") extra.push(flag("canvas-stale", "canvas: out of date"));
  // A curated ask whose canvas question is answered or gone has resolved itself: the first mate only has to close it.
  const open = new Set(opts.canvas?.asks.map((a) => a.id));
  const closed = opts.canvas ? task.asks.filter((a) => a.ref?.kind === "canvas" && a.ref.block && !open.has(a.ref.block)) : [];
  if (closed.length) extra.push(flag("ref-closed", "resolved on canvas: run bin/fleet answer", true));

  // An open ask is the captain's (or the first mate's follow-up), whatever the registry state and the agent are doing.
  const asks = task.asks.filter((a) => !closed.includes(a));
  if (asks.length) return asks.some((a) => !a.repliedAt) ? out("Needs you", "you") : out("With the first mate", "fm");
  if (closed.length && task.state !== "active") return out("With the first mate", "fm");

  const running = !!cur && !cur.archived && RUNNING.has(cur.status);
  if (task.state === "parked") return out("Parked", "parked", running ? [flag("parked-but-running", "parked, but an agent is running", true)] : []);
  if (task.state === "blocked") return out("Blocked", "blocked");
  if (task.state === "queued") return out("Next up", "next", cur ? [flag("queued-but-has-agent", "queued, but an agent exists", true)] : []);

  // state === "active": Paseo decides what is happening
  if (cur && !cur.archived && cur.pendingPermissions > 0) return out("Needs you · permission", "you");
  // The crew's own canvas questions: Needs you once the agent is idle, "Running · 1 question" while it works on (agent-canvas's rule).
  if (canvas && cur && cur.status !== "error") {
    const raw = canvas.asks.filter((a) => !a.pending).length;
    if (raw) {
      if (RUNNING.has(cur.status)) return out(`Running · ${raw} question${raw > 1 ? "s" : ""}`, "running");
      return out("Needs you", "you");
    }
    if (canvas.asks.length) return out("With the first mate", "fm"); // a captain pick waiting for the first mate to deliver it
  }
  if (closed.length) return out("With the first mate", "fm"); // every curated ask resolved itself on the canvas: only bin/fleet answer is left
  if (!cur) {
    const age = now.getTime() - ms(task.since);
    return task.since && age >= DISPATCH_GRACE_MS ? out("Lost", "fm", [flag("no-agent", "no agent found for this task", true)]) : out("Dispatching", "running");
  }
  if (cur.archived) return out("Agent archived", "fm", [flag("archived-agent-open-task", "agent archived, task still open", true)]);
  if (RUNNING.has(cur.status)) {
    const quiet = now.getTime() - ms(cur.lastActivityAt);
    return out("Running", "running", cur.lastActivityAt && quiet > SILENT_MS ? [flag("silent", `silent ${Math.round(quiet / 60_000)} min`)] : []);
  }
  if (cur.status === "unknown") return out("Running", "running", [flag("status-unknown", "agent status unknown")]);
  if (cur.status === "error") return out("Failed (agent errored)", "fm", [], true);
  // idle or closed
  if (cur.final?.startsWith("DONE:")) return out("Review", "fm");
  if (cur.final?.startsWith("BLOCKED:")) return out("Blocked by crew", "fm");
  if (opts.finalKnown === false) return out("Idle", "fm");
  return out("Idle", "fm", [flag("idle-no-done", "idle, no DONE: line")]);
}

/** A Paseo agent record carrying a `fm.task` label, narrowed to what the stage engine reads. */
export type LabeledAgent = {
  id: string;
  status: string;
  archived: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
  pendingPermissions?: number;
  relayGone?: string;
};

/** The agents of one task: the ones Paseo knows by the `fm.task` label. No label, no agent. */
export function stageAgentsFor(
  labeled: readonly LabeledAgent[] | undefined,
  view: (id: string) => { final?: string } | undefined,
): StageAgent[] {
  return (labeled ?? []).map((a) => ({
    id: a.id, status: a.status, archived: a.archived, createdAt: a.createdAt, lastActivityAt: a.lastActivityAt ?? a.updatedAt,
    pendingPermissions: a.pendingPermissions ?? 0, final: a.archived ? undefined : view(a.id)?.final, relayGone: a.relayGone,
  }));
}
