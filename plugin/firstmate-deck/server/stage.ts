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
  /** When its current/last turn started (ISO), from the `agent.turn_started` hook. Unlike `lastActivityAt` it does not move on a label change or a steer. */
  turnStartedAt?: string | null;
  /** The plugin already reminded this idle crew to hand back (`DONE:`/`BLOCKED:`) once. */
  nudged?: boolean;
  /** The label of the Paseo host it runs on; absent for an agent on this daemon. */
  host?: string;
  /** That host is offline: everything else here is the last known state, not a live one. */
  hostOffline?: HostOffline;
};

/** `permission`: a request was open when the host was last read. It cannot be answered (or known to still be open) until the host is back. */
export type HostOffline = { label: string; since: string; permission?: boolean };

/** Who owes the next move. `nobody` = nothing is owed (queued, parked, done). The group is derived from it: owner `firstmate` = group `fm`. */
export type Owner = "captain" | "firstmate" | "crew" | "outside" | "nobody";

/** What a badge on the card says. `drift` flags are the registry and Paseo disagreeing: the first mate should act. */
/** `since` (ms) is set on a flag whose text counts time ("silent 41 min"): the page writes the count itself from it, so the payload does not change as the minutes pass. */
export type StageFlag = { key: string; text: string; drift: boolean; since?: number };

export type Stage = {
  /** Human label: "Running", "Needs you", "Review"... */
  stage: string;
  group: GroupKey;
  agentId: string | null;
  flags: StageFlag[];
  /** The stage is a failure (done-failed, errored agent): the card gets the failed chip. */
  failed: boolean;
  /** Who owes the next move, and why this task is where it is (carries the facts that change it: the comment time, the final line). */
  owner: Owner;
  reason: string;
  /** What clears it, in the first mate's own commands. */
  clears: string;
  /** Identity of (stage, reason, agent): the enforcer counts its nudges per fingerprint, so a changed situation starts a new count. */
  fp: string;
};

/** The parts of a task the engine reads (state.ts `Task` fits; so does the CLI's). */
export type StageTask = {
  state: TaskState;
  /** When `state` last changed (ISO). Used only for the Dispatching -> Lost grace window. */
  since?: string;
  blocked_on?: string;
  asks: { id?: string; repliedAt?: string; ref?: AskRef; answeredAt?: string }[];
  /** An unanswered captain comment on the card body that no single ask can own (a card with 2+ asks). ISO time. */
  commentWaiting?: string;
  /** The task's branch is merged into its base branch (the plugin checks git). */
  merged?: boolean;
};

/** A curated (registry) ask that mirrors a question on the crew's canvas: `bin/fleet ask --ref`. The text and options are read live from the canvas. */
export type AskRef = { kind?: string; agentId?: string; block?: string };

/**
 * What the current agent's canvas says (agent-canvas `/api/fm/summary`), reduced to what a stage depends on.
 * `asks` are the canvas asks still open; `pending` is a captain pick waiting on the first mate. Absent = the canvas was not
 * read (no canvas, or agent-canvas unreachable), which changes nothing.
 */
export type CanvasInput = { asks: { id: string; pending: boolean }[]; verdict?: string };

const OWNER_OF: Record<GroupKey, Owner> = { you: "captain", fm: "firstmate", running: "crew", blocked: "outside", next: "nobody", parked: "nobody", done: "nobody" };

/** When the agent last began work: its turn start when the plugin saw it, else Paseo's last activity. */
export const activeSinceOf = (a: { turnStartedAt?: string | null; lastActivityAt?: string | null; updatedAt?: string | null } | undefined): string | null =>
  a?.turnStartedAt ?? a?.lastActivityAt ?? a?.updatedAt ?? null;

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

const flag = (key: string, text: string, drift = false, since?: number): StageFlag => ({ key, text, drift, ...(since ? { since } : {}) });

/**
 * `opts.archived`: the task is an archive line (history, frozen): its stage is its verdict and Paseo is not consulted.
 * `opts.finalKnown` false: the caller cannot read agents' last message (the CLI): an idle agent is reported as idle
 * without guessing "no DONE:".
 */
export function computeStage(task: StageTask, agents: readonly StageAgent[], now: Date, opts: { archived?: boolean; finalKnown?: boolean; canvas?: CanvasInput } = {}): Stage {
  const cur = currentAgent(agents);
  // flags every live stage carries (a canvas verdict, a curated ask the canvas already resolved); set below, after the done branch
  let extra: StageFlag[] = [];
  const out = (stage: string, group: GroupKey, why: string, clears = "", flags: StageFlag[] = [], failed = false): Stage => ({
    stage, group, agentId: cur?.id ?? null, flags: [...flags, ...extra], failed, owner: OWNER_OF[group], reason: why, clears, fp: `${stage}|${why}|${cur?.id ?? ""}`,
  });
  const live = !opts.archived && !!cur && !cur.archived;
  // The crew's host is offline: its status is unknown. It is never read as closed, errored, idle or silent.
  const away = live ? cur!.hostOffline : undefined;

  // A pending permission is the captain's whatever the registry says and whatever else is open (an open ask is flagged beside it).
  if (live && !away && cur!.pendingPermissions > 0) {
    const open = task.asks.length ? [flag("ask-open", "an ask is also open")] : [];
    return out("Needs you · permission", "you", `crew ${cur!.id.slice(0, 8)} waits for a permission answer`, "answer the permission request in Paseo", open);
  }

  if (opts.archived || task.state === "done" || task.state === "failed") {
    const failed = task.state === "failed";
    const label = failed ? "Failed" : "Done";
    if (!opts.archived) {
      // a finished task keeps an open ask visible: an ask is never hidden
      if (task.asks.length) {
        const open = task.asks.some((a) => !a.repliedAt);
        return out(open ? "Needs you" : "With the first mate", open ? "you" : "fm", open ? "an ask on a finished task is open" : "the captain replied to an ask on a finished task", open ? "the captain answers it" : "bin/page reply, then bin/fleet answer", [], failed);
      }
      if (cur && !cur.hostOffline && RUNNING.has(cur.status) && !cur.archived) return out(label, "done", "finished", "", [flag("done-but-running", "done, but an agent is still running", true)], failed);
    }
    return out(label, "done", "finished", "", [], failed);
  }

  const canvas = !cur || cur.archived ? undefined : opts.canvas;
  if (cur && !cur.archived && cur.relayGone) extra.push(flag("relay-target-gone", `canvas relay target ${cur.relayGone.slice(0, 8)} is gone: bin/page claim re-points it`, true));
  if (away) extra.push(flag("host-offline", `${away.label} offline since ${away.since}`));
  if (away?.permission) extra.push(flag("permission-was-waiting", "was waiting for a permission"));
  if (!away && canvas?.verdict === "Disputed") extra.push(flag("canvas-disputed", "canvas: status disputed"));
  if (!away && canvas?.verdict === "Stale") extra.push(flag("canvas-stale", "canvas: out of date"));
  if (task.commentWaiting) extra.push(flag("comment-waiting", "a comment on this card is waiting for the first mate"));
  // A curated ask whose canvas question is answered or gone has resolved itself: the first mate only has to close it.
  const open = new Set(opts.canvas?.asks.map((a) => a.id));
  const closed = opts.canvas ? task.asks.filter((a) => a.ref?.kind === "canvas" && a.ref.block && !open.has(a.ref.block)) : [];
  if (closed.length) extra.push(flag("ref-closed", "resolved on canvas: run bin/fleet answer", true));
  const running = !!cur && !cur.archived && !away && RUNNING.has(cur.status);
  const ids = (xs: { id?: string }[]) => xs.map((a) => a.id ?? "ask").join(", ");

  // An open ask is the captain's (or the first mate's follow-up), whatever the registry state and the agent are doing.
  const asks = task.asks.filter((a) => !closed.includes(a));
  if (asks.length) {
    const unanswered = asks.filter((a) => !a.repliedAt);
    if (unanswered.length) {
      // The first mate answered the captain's comment (bin/page reply) and put the crew back to work, but the ask is still open
      // in the registry: the work is running, and the first mate only has to `bin/fleet answer` or `reask` it.
      const turn = ms(activeSinceOf(cur));
      if (running && unanswered.every((a) => a.answeredAt && ms(a.answeredAt) <= turn)) {
        return out("Running", "running", `crew is working again after the captain's reply; ask ${ids(unanswered)} is still open`, "bin/fleet answer or reask", [flag("ask-open-after-reply", `ask ${ids(unanswered)} still open after the reply: bin/fleet answer or reask`, true)]);
      }
      return out("Needs you", "you", `ask ${ids(unanswered)} waits for the captain`, "the captain answers on the page");
    }
    const a = asks.reduce((x, y) => (ms(y.repliedAt) >= ms(x.repliedAt) ? y : x));
    return out("With the first mate", "fm", `ask ${a.id ?? "ask"}: the captain replied or a follow-up is promised (${a.repliedAt})`, "bin/page reply <project> --task <id>, then bin/fleet answer or reask");
  }
  if (closed.length && task.state !== "active") return out("With the first mate", "fm", `ask ${ids(closed)} was resolved on the canvas`, "bin/fleet answer");

  // Registry intent that a running agent contradicts: the agent is what is happening (flagged so the first mate fixes the registry).
  if (task.state === "parked" && !running) return out("Parked", "parked", "parked by the first mate");
  // A crew's open canvas question beats a "blocked" note: the move is the captain's, so the card must land in Needs you.
  const crewQuestion = !!canvas && !!cur && cur.status !== "error" && canvas.asks.some((a) => !a.pending);
  if (task.state === "blocked" && !running && !crewQuestion) return out("Blocked", "blocked", `blocked on ${task.blocked_on ?? "something outside"}`);
  if (task.state === "queued" && !running) return out("Next up", "next", "queued", "", cur ? [flag("queued-but-has-agent", "queued, but an agent exists", true)] : []);
  if (running && task.state === "parked") extra.push(flag("parked-but-running", "parked, but an agent is running", true));
  if (running && task.state === "blocked") extra.push(flag("blocked-but-running", "blocked, but an agent is running", true));
  if (running && task.state === "queued") extra.push(flag("queued-but-has-agent", "queued, but an agent is running", true));

  // From here Paseo decides what is happening
  // The crew's own canvas questions: Needs you once the agent is idle, "Running · 1 question" while it works on (agent-canvas's rule).
  if (canvas && cur && cur.status !== "error") {
    const raw = canvas.asks.filter((a) => !a.pending).length;
    if (raw) {
      if (running) return out(`Running · ${raw} question${raw > 1 ? "s" : ""}`, "running", `crew is working with ${raw} open canvas question${raw > 1 ? "s" : ""}`);
      return out("Needs you", "you", `crew canvas question${raw > 1 ? "s" : ""} wait for the captain`, "the captain answers on the canvas");
    }
    // a captain pick waiting for the first mate to deliver it
    if (canvas.asks.length) return out("With the first mate", "fm", "a canvas pick is waiting for the first mate to deliver it", "bin/page canvas-answer <task> <ask> <option>");
  }
  // every curated ask resolved itself on the canvas and nothing runs: only bin/fleet answer is left
  if (closed.length && !running) return out("With the first mate", "fm", `ask ${ids(closed)} was resolved on the canvas`, "bin/fleet answer");
  if (!cur) {
    const age = now.getTime() - ms(task.since);
    return task.since && age >= DISPATCH_GRACE_MS
      ? out("Lost", "fm", "no agent carries this task's label", "re-dispatch it, or bin/fleet set state=...", [flag("no-agent", "no agent found for this task", true)])
      : out("Dispatching", "running", "waiting for the crew agent to appear");
  }
  if (cur.archived) return out("Agent archived", "fm", "the task's agent is archived while the task is still open", "bin/fleet finish, or re-dispatch", [flag("archived-agent-open-task", "agent archived, task still open", true)]);
  if (away) return out(`Unknown · ${away.label} offline`, "running", `unknown · ${away.label} offline since ${away.since}`);
  if (RUNNING.has(cur.status)) {
    const quiet = now.getTime() - ms(cur.lastActivityAt);
    return out("Running", "running", "crew is working", "", cur.lastActivityAt && quiet > SILENT_MS ? [flag("silent", `silent ${Math.round(quiet / 60_000)} min`, false, ms(cur.lastActivityAt))] : []);
  }
  if (cur.status === "unknown") return out("Running", "running", "crew status unknown", "", [flag("status-unknown", "agent status unknown")]);
  if (cur.status === "error") return out("Failed (agent errored)", "fm", "the crew agent errored", "stuck-crew-recovery", [], true);
  // idle or closed. A crew that ended its turn while its own background jobs or sub-agents run (its canvas verdict is Waiting, or
  // Working before Paseo's idle lands) has not handed anything back: it is not "with the first mate". A DONE:/BLOCKED: line is a hand-back.
  const handedBack = !!cur.final && /^(DONE|BLOCKED):/.test(cur.final);
  if (canvas && !handedBack && cur.status === "idle") {
    if (canvas.verdict === "Waiting") return out("Waiting", "running", "crew is idle while its background work runs");
    if (canvas.verdict === "Working") return out("Running", "running", "crew canvas says it is working");
  }
  if (cur.final?.startsWith("DONE:")) return out("Review", "fm", `crew ended: ${cur.final.slice(0, 120)}`, "ship-delivery or scout-report", task.merged ? [flag("merged", "branch merged: run ship-delivery", true)] : []);
  if (cur.final?.startsWith("BLOCKED:")) return out("Blocked by crew", "fm", `crew ended: ${cur.final.slice(0, 120)}`, "stuck-crew-recovery");
  if (opts.finalKnown === false) return out("Idle", "fm", "crew is idle (its last message is not readable here)", "stuck-crew-recovery");
  // No hand-back: the crew owes one, not the first mate. The plugin reminds it once; a crew that stays silent then reaches the first mate.
  if (cur.status === "idle" && !cur.nudged) return out("Crew stopped · no hand-back", "running", "crew ended its turn without DONE:/BLOCKED:; the plugin reminds it once", "", [flag("idle-no-done", "idle, no DONE: line")]);
  return out("Idle", "fm", cur.nudged ? "crew stayed silent after a reminder to hand back" : "crew is closed with no hand-back", "stuck-crew-recovery", [flag("idle-no-done", "idle, no DONE: line")]);
}

/** The enforcer's verdict on an item the first mate ignored: it now needs the captain. `fp` stays the underlying one, so the item keeps its identity. */
export function applyStalled(s: Stage, why: string): Stage {
  if (s.group !== "fm") return s;
  return {
    ...s, stage: "Needs you · first mate stalled", group: "you", owner: "captain", reason: `first mate stalled: ${why}`, clears: "re-prompt the first mate, or handle it yourself",
    flags: [...s.flags, { key: "first-mate-stalled", text: "first mate stalled: it did not act on this", drift: true }],
  };
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
  turnStartedAt?: string | null;
  nudged?: boolean;
  host?: string;
  hostOffline?: HostOffline;
};

/** The agents of one task: the ones Paseo knows by the `fm.task` label. No label, no agent. */
export function stageAgentsFor(
  labeled: readonly LabeledAgent[] | undefined,
  view: (id: string) => { final?: string } | undefined,
): StageAgent[] {
  return (labeled ?? []).map((a) => ({
    id: a.id, status: a.status, archived: a.archived, createdAt: a.createdAt, lastActivityAt: a.lastActivityAt ?? a.updatedAt,
    pendingPermissions: a.pendingPermissions ?? 0, final: a.archived ? undefined : view(a.id)?.final, relayGone: a.relayGone, turnStartedAt: a.turnStartedAt, nudged: a.nudged, host: a.host, hostOffline: a.hostOffline,
  }));
}
