---
name: session-digest
description: Use when the captain asks for status, bearings, or what's in flight — answers /bearings with a one-screen read-only fleet digest.
---

# Session Digest (`/bearings`)

This skill emits a compact, scannable picture of the whole fleet on demand; it is strictly read-only and never mutates fleet state or any agent.

## Gather first

Run `bin/fleet active` (live id/status/agentId) and `bin/fleet asks` (every open ask), then call `mcp__paseo__list_agents` filtered to the current cwd (always pass `statuses` / `sinceHours`) and reconcile — the live index is your intent record, `list_agents` is ground truth for whether an agent is still alive. For "Landed", read only the archive tail (`tail -20 state/fleet-archive.jsonl`), never the whole file.

Use `mcp__paseo__get_agent_status` (and `get_agent_activity` with `limit: 10`) only to confirm a single ambiguous task (e.g. fleet says `running` but the agent is missing or looks idle); do not fan out to every task.

## Emit the digest, most-actionable first

Keep it to roughly one screen: terse lines, not paragraphs, no transcript, grouped by status in this order.

- **Open asks** — every line of `bin/fleet asks`, each with its task `id`, so the captain sees all pending decisions without scrolling. An ask outlives the step that raised it; nothing here is closed just because its task is done.
- **In flight** — `dispatched` / `running` tasks: `id`, shape, provider, age from `lastEvent`, and a few words on what each is doing.
- **Landed** — recently archived tasks from the archive tail, with PR link (`pr` / branch) where present.
- **Failed** — `failed` tasks with the one-line reason from `notes` / `lastEvent`.

## Flag drift explicitly — this is the point of the digest

Call out these drift classes by `id`: tasks marked `dispatched`/`running` in the live index whose `lastEvent` is stale (stuck candidates for the stuck-crew-recovery skill); tasks present in the index but ABSENT from `list_agents` (dead — should be marked `failed` via `bin/fleet set`); and **landed-but-open** — a non-terminal task whose `pr` is already merged (teardown candidate for `ship-delivery` §6), or a terminal task whose dedicated `kind: worktree` workspace is still live. The digest only reports these; it never archives.

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
