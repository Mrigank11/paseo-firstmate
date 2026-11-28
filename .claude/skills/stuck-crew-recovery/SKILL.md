---
name: stuck-crew-recovery
description: Use when a crew member errors, goes silent, or drifts from its brief.
---

# Stuck Crew Recovery

You are the first mate. A wake event errored, or the heartbeat's `bin/fleet stages` flagged a task (`silent`, `Lost`, `Idle`, `Failed (agent errored)`). Your job is to diagnose, fix or relaunch, record, and end the turn — not to do the crew member's work yourself. Every fleet write below goes through `bin/fleet` — never hand-edit `fleet.json`.

## 1. Diagnose first, then act

Call `mcp__paseo__get_agent_status` and `mcp__paseo__get_agent_activity` (pass `limit: 10`) for the suspect `agentId` before touching anything. Classify into exactly one of the four cases below and act accordingly.

- **needs-input / asked a question** — activity shows the crew member stopped to ask something framed as plain text (not a formal permission push). If the answer is inside the brief's boundaries in `state/tasks/<id>/brief.md`, answer it with `mcp__paseo__send_agent_prompt` (`{ agentId, prompt }`) and leave the task `active`. Otherwise `bin/fleet ask <id> "…"` with the question (an open ask is what puts the task in Needs you) and escalate to the captain.
- **silent stall** — status says running but activity shows no progress (the stage carries the `silent` flag). Nudge exactly once with `mcp__paseo__send_agent_prompt`, e.g. "status? are you blocked? reply with what you did last and what is next." Log the nudge with `bin/fleet log` and end the turn. If it is still silent at the next heartbeat, treat it as dead and go to relaunch.
- **hard error / crashed** — status is error/closed or activity ends in a crash, exception, or unrecoverable tool failure. Decide relaunch (section 2) vs escalate: relaunch if the brief is still valid and attempt count is under the cap, otherwise `bin/fleet finish <id> --failed` (answering any open asks with it), or raise an ask, and escalate.
- **wrong track** — the agent is active but drifting from `state/tasks/<id>/brief.md` (wrong files, wrong scope, reinventing). Steer with a short corrective `mcp__paseo__send_agent_prompt` quoting the brief constraint it violated, note the steer with `bin/fleet log <id> "…"`.

## 2. Relaunch procedure

Relaunch only a dead or crashed member, never a healthy `running` one. Reuse the exact brief so the retry is comparable.

1. Stop the old member with `mcp__paseo__cancel_agent`, falling back to `mcp__paseo__kill_agent` if cancel does not terminate it. A member on another host is out of reach of both: `paseo stop` as in `docs/STATE.md`, "Acting on a crew there"; if its host is offline it cannot be stopped, so do not launch a replacement that would work beside it without asking the captain.
2. Read the canonical brief at `state/tasks/<id>/brief.md` and spawn a replacement with `mcp__paseo__create_agent` in a fresh workspace matching the task's shape (a new `create_workspace` worktree for `ship`; no worktree for `scout`) — same instructions, no extra scope, no carried-over partial state. Stamp the same labels as the original dispatch (`fm.task`, `fm.project`, `fm.shape`, and `canvas` / `canvas.relay` / `canvas.kind` when it had them; see `dispatch-routing` §3), and put the `## Your canvas` section (`bin/page canvas-snippet`) in the brief again. Before you archive the old agent, `bin/page canvas-snapshot <id>` keeps what it had shown: the label is what makes the replacement the task's current agent — there is no `agentId` to record.
3. Keep the task `state=active` (the registry needs no write for a relaunch) and append with `bin/fleet log <id> "…"` that this is attempt N (e.g. "attempt 2 relaunch after silent stall, old agent <id>").
4. Increment the attempt counter (in the log line) so the cap in section 4 can be enforced.

## 3. Report once, don't re-escalate

Once you have told the captain a crew member is dead or blocked and raised an ask or finished the task as failed, that task is handled. Do not re-surface it on every heartbeat just because it is still in that state.

## 4. Relaunch cap: two strikes, then human

After 2 failed attempts on the same task (initial run + 1 relaunch, or 2 relaunches — count whatever the task log records as attempts), stop relaunching. raise `bin/fleet ask <id> "…"`, summarize both failures and what changed between attempts with `bin/fleet log`, escalate to the captain, and end the turn. A task that fails twice the same way needs a human, not another retry.

## 5. Always close out

Every invocation ends with a `bin/fleet log` entry (and a `bin/fleet` write if the state or an ask changed): a one-line entry stating classification, action taken (nudged / steered / relaunched as attempt N / escalated), and next check. Then end the turn silently unless escalation requires a captain message.
