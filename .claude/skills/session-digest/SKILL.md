---
name: session-digest
description: Use when the captain asks for status, bearings, or what's in flight — answers /bearings with a one-screen read-only fleet digest.
---

# Session Digest (`/bearings`)

This skill emits a compact, scannable picture of the whole fleet on demand; it is strictly read-only and never mutates `state/fleet.json` or any agent.

## Gather first

Read `state/fleet.json` (fields: `id, intent, shape, provider, agentId, workspaceId, status, branch, pr, lastEvent, notes`; statuses: `dispatched, running, needs-captain, done, failed`), then call `mcp__paseo__list_agents` filtered to the current cwd (use `statuses` / `sinceHours` as needed) and reconcile the two — fleet.json is your intent record, `list_agents` is ground truth for whether an agent is still alive.

Use `mcp__paseo__get_agent_status` only to confirm a single ambiguous task (e.g. fleet says `running` but the agent is missing or looks idle); do not fan out to every task.

## Emit the digest, most-actionable first

Keep it to roughly one screen: terse lines, not paragraphs, no transcript, grouped by status in this order.

- **Needs captain** — every task with status `needs-captain`, each with its one-line ask and `id` so the captain can act without scrolling.
- **In flight** — `dispatched` / `running` tasks: `id`, shape, provider, age from `lastEvent`, and a few words on what each is doing.
- **Landed** — recently `done` tasks, with PR link (`pr` / branch) where present.
- **Failed** — `failed` tasks with the one-line reason from `notes` / `lastEvent`.

## Flag drift explicitly — this is the point of the digest

Call out both drift classes by `id`: tasks marked `dispatched`/`running` in fleet.json whose `lastEvent` is stale (stuck candidates for the stuck-crew-recovery skill), and tasks present in fleet.json but ABSENT from `list_agents` (dead — should be marked `failed`).

## Close with one line

End with a single line stating what, if anything, needs the captain right now (e.g. `Captain needed: <ids + asks>` or `Captain needed: nothing — fleet is healthy.`).

This skill never fixes drift inline; when a dead task should be marked failed or a stalled one recovered, NAME that as a recommended next action instead.

```text
FLEET — 2 in flight · 1 needs captain · 1 landed · 1 failed
NEEDS CAPTAIN: t-auth (needs-captain) — approve Auth0 vs Cognito call before build continues.
IN FLIGHT: t-api (ship, codex, 12m) — scaffolding REST endpoints; t-ui (ship, claude, 44m, STALE?) — no event for 44m, stuck candidate.
LANDED: t-schema (done) — merged, PR #42.
FAILED: t-seed (failed) — migration script errored, see notes.
DRIFT: t-ui stale; no dead agents.
Captain needed: decision on t-auth; confirm whether to recover t-ui.
```
