---
name: stuck-crew-recovery
description: Use when a crew member errors, goes silent past its lastEvent, or drifts from its brief.
---

# Stuck Crew Recovery

You are the first mate. A wake event errored, or the heartbeat found a task still `running` in the live index (`bin/fleet active`) with a stale `lastEvent`. Your job is to diagnose, fix or relaunch, record, and end the turn — not to do the crew member's work yourself. Every fleet write below goes through `bin/fleet` — never hand-edit `fleet.json`.

## 1. Diagnose first, then act

Call `mcp__paseo__get_agent_status` and `mcp__paseo__get_agent_activity` (pass `limit: 10`) for the suspect `agentId` before touching anything. Classify into exactly one of the four cases below and act accordingly.

- **needs-input / asked a question** — activity shows the crew member stopped to ask something framed as plain text (not a formal permission push). If the answer is inside the brief's boundaries in `state/tasks/<id>/brief.md`, answer it with `mcp__paseo__send_agent_prompt` (`{ agentId, prompt }`) and keep the task `running`. Otherwise `bin/fleet set <id> status=needs-captain` (plus `bin/fleet ask <id> "…"` for the question) and escalate to the captain.
- **silent stall** — status says running but activity shows no progress and `lastEvent` is stale. Nudge exactly once with `mcp__paseo__send_agent_prompt`, e.g. "status? are you blocked? reply with what you did last and what is next." `bin/fleet set <id> lastEvent=<now>`, keep status `running`, and end the turn. If it is still silent at the next heartbeat, treat it as dead and go to relaunch.
- **hard error / crashed** — status is error/closed or activity ends in a crash, exception, or unrecoverable tool failure. Decide relaunch (section 2) vs escalate: relaunch if the brief is still valid and attempt count is under the cap, otherwise `bin/fleet set <id> status=failed` (or `needs-captain`) and escalate.
- **wrong track** — the agent is active but drifting from `state/tasks/<id>/brief.md` (wrong files, wrong scope, reinventing). Steer with a short corrective `mcp__paseo__send_agent_prompt` quoting the brief constraint it violated, keep status `running`, note the steer with `bin/fleet log <id> "…"`.

## 2. Relaunch procedure

Relaunch only a dead or crashed member, never a healthy `running` one. Reuse the exact brief so the retry is comparable.

1. Stop the old member with `mcp__paseo__cancel_agent`, falling back to `mcp__paseo__kill_agent` if cancel does not terminate it.
2. Read the canonical brief at `state/tasks/<id>/brief.md` and spawn a replacement with `mcp__paseo__create_agent` in a fresh workspace matching the task's shape (a new `create_workspace` worktree for `ship`; no worktree for `scout`) — same instructions, no extra scope, no carried-over partial state.
3. Update the task via `bin/fleet`: set the new `agentId`, reset status to `running`, set `lastEvent` to now (`bin/fleet set <id> agentId=… status=running lastEvent=…`), and append with `bin/fleet log <id> "…"` that this is attempt N (e.g. "attempt 2 relaunch after silent stall, old agent <id>").
4. Increment the attempt counter (in the log line) so the cap in section 4 can be enforced.

## 3. Report once, don't re-escalate

Once you have told the captain a crew member is dead or blocked and set status to `needs-captain` or `failed`, that task is handled. Do not re-surface it on every heartbeat just because it is still in a terminal state.

## 4. Relaunch cap: two strikes, then human

After 2 failed attempts on the same task (initial run + 1 relaunch, or 2 relaunches — count whatever the task log records as attempts), stop relaunching. `bin/fleet set <id> status=needs-captain`, summarize both failures and what changed between attempts with `bin/fleet log`, escalate to the captain, and end the turn. A task that fails twice the same way needs a human, not another retry.

## 5. Always close out

Every invocation ends with a `bin/fleet set` + `log`: current `status`, fresh `lastEvent`, and a one-line log entry stating classification, action taken (nudged / steered / relaunched as attempt N / escalated), and next check. Then end the turn silently unless escalation requires a captain message.
