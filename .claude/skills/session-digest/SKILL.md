---
name: session-digest
description: Use when the captain asks for status, bearings, or what's in flight — answers /bearings with a one-screen read-only fleet digest.
---

# Session Digest (`/bearings`)

This skill emits a compact, scannable picture of the whole fleet on demand; it is strictly read-only and never mutates fleet state or any agent.

## Gather first

Run `bin/fleet stages --table` (every live task's computed stage and drift flags — already reconciled with Paseo) and `bin/fleet asks` (every open ask). The registry is your intent record; the stage is Paseo's truth, so there is nothing to reconcile by hand. For "Landed", read only the archive tail (`tail -20 state/fleet-archive.jsonl`), never the whole file.

Use `mcp__paseo__get_agent_status` (and `get_agent_activity` with `limit: 10`) only to confirm a single ambiguous task (e.g. a `Lost` or `Idle` stage); do not fan out to every task.

## Emit the digest, most-actionable first

Keep it to roughly one screen: terse lines, not paragraphs, no transcript, grouped by status in this order.

- **Open asks** — every line of `bin/fleet asks`, each with its task `id`, so the captain sees all pending decisions without scrolling. An ask outlives the step that raised it; nothing here is closed just because its task is done.
- **In flight** — tasks whose stage is Running / Dispatching / Review / Idle / Blocked by crew (from `bin/fleet stages`): `id`, shape, stage, age from `since`, and a few words on what each is doing.
- **Landed** — recently archived tasks from the archive tail, with PR link (`pr` / branch) where present.
- **Failed** — `failed` tasks (and `Failed (agent errored)` stages) with the one-line reason from the task's `log.md` or card.

## Flag drift explicitly — this is the point of the digest

Call out the flags `bin/fleet stages` raises, by `id`: `silent` (no activity for 30 min — a stuck candidate for stuck-crew-recovery), `Lost` / `no-agent` (no agent carries the task's label — relaunch or `finish --failed`), `Idle` / `idle-no-done` and the drift flags (`queued-but-has-agent`, `parked-but-running`, `done-but-running`, `archived-agent-open-task`); and **landed-but-open** — a non-terminal task whose `pr` is already merged (teardown candidate for `ship-delivery` §6), or a terminal task whose dedicated `kind: worktree` workspace is still live. The digest only reports these; it never archives.

## Close with one line

End with a single line stating what, if anything, needs the captain right now (e.g. `Captain needed: <ids + asks>` or `Captain needed: nothing — fleet is healthy.`).

This skill never fixes drift inline; when a dead task should be marked failed or a stalled one recovered, NAME that as a recommended next action instead.

```text
FLEET — 2 in flight · 1 needs captain · 1 landed · 1 failed
OPEN ASKS: t-auth — approve Auth0 vs Cognito call before build continues.
IN FLIGHT: t-api (ship, codex, 12m) — scaffolding REST endpoints; t-ui (ship, claude, 44m, STALE?) — no event for 44m, stuck candidate.
LANDED: t-schema (done) — merged, PR #42.
FAILED: t-seed (failed) — migration script errored, see notes.
DRIFT: t-ui stale; no dead agents.
Captain needed: decision on t-auth; confirm whether to recover t-ui.
```
