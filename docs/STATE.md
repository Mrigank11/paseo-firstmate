# Fleet state format

The first mate's memory lives on disk under `state/`, not in the model's context. This is the whole reason a compaction or restart is a non-event: on any wake, re-read these files; on any change, write them back. Paseo knows an agent's `agentId` and live status, but it does not know the *intent* behind a task, its shape, or the captain's decisions — those live here and only here.

## Layout

```
state/
  fleet.json          # registry of every task, active and recently done
  decisions.md        # captain prefs, routing lanes, permission + merge policy
  secondmates.md      # phase 3: roster of subordinate first mates (only if any)
  afk-log.md          # phase 3: running log while the captain is AFK (only if any)
  tasks/
    <id>/
      brief.md        # captain's intent + firstmate spec (see writing-briefs skill)
      report.md       # scout tasks only: the harvested result
```

`state/` is gitignored — it is runtime state, not source. Durable *learnings* ("provider X keeps wedging on task type Y") do not belong here; graduate them to the captain's basic-memory instead.

## `fleet.json`

One object, `{ "tasks": [...] }`. Each task:

```json
{
  "id": "kebab-slug",
  "intent": "one line: what the captain actually wants",
  "shape": "scout | ship",
  "provider": "claude/opus",
  "agentId": "…",
  "workspaceId": "…",
  "status": "dispatched | running | needs-captain | done | failed",
  "branch": "feature/x   (ship only, once known)",
  "pr": "https://…        (ship only, once opened)",
  "lastEvent": "2026-09-18T12:00:00Z finished",
  "notes": "anything the next wake needs to know"
}
```

Rules:
- `id` is a stable kebab slug you assign at dispatch; it names the `tasks/<id>/` dir.
- `status` is *your* view of truth, updated on every wake. It is not Paseo's status — reconcile them when they disagree, trusting a fresh `get_agent_status` over a stale field.
- Never delete a task on completion; set `status: done`. Prune to an archive only when `fleet.json` gets noisy.
- On session start, reconcile: `list_agents(includeArchived, cwd)` recovers live agents; anything in `fleet.json` marked active but absent from Paseo is dead — mark it `failed` and surface it.

## Reconstruction on restart

1. Read `fleet.json`.
2. `list_agents` for the current cwd; match by `agentId`.
3. For each active-in-file task: present → keep; absent → mark `failed`, tell the captain.
3b. Run the workspace GC sweep (same rule as the heartbeat's): `list_workspaces`, archive each dedicated workspace whose task is terminal and clean, flag the rest.
4. Re-read any `needs-captain` briefs so you can answer follow-ups.
5. Emit one supervision summary to the captain and go idle.

## Heartbeat safety net

Paseo pushes finish/error/permission events, so you do not poll. The one gap it cannot cover is a crew member that goes *silent* — stalled without finishing or erroring. Register a single low-frequency `create_heartbeat` (e.g. every 30 min) that wakes you to scan `fleet.json` for tasks whose `lastEvent` is old while `status` is still `running`, and hand those to `stuck-crew-recovery`. Delete and recreate the heartbeat if its cadence needs to change (Paseo has no heartbeat-update tool).

The same heartbeat also runs a **workspace garbage-collection sweep**: call `mcp__paseo__list_workspaces` and, for each live workspace owned by exactly one `fleet.json` task (a **dedicated** workspace — a shared checkout listed by ≥2 tasks, or the first mate's own checkout, is never a candidate) whose task is **terminal** (`done`/`failed`), archive it with `mcp__paseo__archive_workspace` when it holds no unlanded work (no open PR, no unmerged commits, clean tree); if it does hold unlanded work, flag it to the captain instead of archiving. If the crew agent of an archived workspace is somehow still live, close it too (`mcp__paseo__archive_agent` / `cancel_agent`). Workspaces that map to no task in this fleet (other projects) are out of scope. This reclaims any worktree a per-task teardown (`ship-delivery` §6, `scout-report`) missed.
