# Fleet state format

The first mate's memory lives on disk under `state/`, not in the model's context. This is the whole reason a compaction or restart is a non-event: on any wake, re-read the waking task's entry; on any change, write it back through `bin/fleet`. Paseo knows an agent's `agentId` and live status, but it does not know the *intent* behind a task, its shape, or the captain's decisions — those live here and only here.

One file used to do two jobs — lookup index and narrative journal — and grew to ~135 KB. Now the live index stays small, narrative lives per task, and finished work leaves the hot path on its own. A routine wake reads at most ~2k tokens of state: the waking task's entry plus the live index, never the archive.

## Layout

```
state/
  fleet.json            # LIVE tasks only (small index)
  fleet-archive.jsonl   # one compact line per finished, ask-free task
  decisions.md          # captain prefs, routing lanes, permission + merge policy
  secondmates.md        # phase 3: roster of subordinate first mates (only if any)
  afk-log.md            # phase 3: running log while the captain is AFK (only if any)
  tasks/
    <id>/
      brief.md          # captain's intent + firstmate spec (see writing-briefs skill)
      report.md         # scout tasks only: the harvested result
      log.md            # narrative journal for the task (append-only)
```

`state/` is gitignored — it is runtime state, not source. Durable *learnings* ("provider X keeps wedging on task type Y") do not belong here; graduate them to the captain's basic-memory instead.

## `fleet.json` — the live index

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
  "notes": "≤200 chars: what the next wake needs to know (overflow → log.md)",
  "asks": [{"text": "≤200 chars open question", "since": "2026-09-20"}],
  "preview": {"port": 4321, "pid": 12345}
}
```

Rules:

- `id` is a stable kebab slug you assign at dispatch; it names the `tasks/<id>/` dir.
- `status` is *your* view of truth, updated on every wake. It is not Paseo's status — reconcile them when they disagree, trusting a fresh `get_agent_status` over a stale field.
- **Never hand-edit `fleet.json`.** Every write goes through `bin/fleet` (`add`, `set`, `ask`, `answer`, `preview`, `clear-preview`, `archive`): it validates the status/shape enums and the 200-char caps, then writes atomically (temp file + rename). A refused write changes nothing. Reads are `get`, `by-agent`, `active`, `asks`. `bin/fleet` with no args prints usage.
- `notes` holds at most 200 chars. Anything longer is narrative — append it with `bin/fleet log <id> "…"` and keep one line in `notes`.
- `asks` is the task's open questions for the captain. An ask outlives the step that raised it: closing a task never closes its asks. `bin/fleet archive` REFUSES a task with open asks — answer (`ask`/`answer`) or explicitly drop each one first.
- `preview` records a crew dev/preview server from its final message (`preview: <port> <pid>`). Teardown kills that pid (after checking it is still the same process) and runs `clear-preview` before archiving.
- A `done`/`failed` task with no open asks leaves the index: `bin/fleet archive <id>` appends it to `fleet-archive.jsonl` and removes it. Never delete a task any other way.

## Reading on a wake (token budget)

- Map the event's `agentId` to its task with `bin/fleet by-agent <agentId>`, then read that ONE entry (`bin/fleet get <id>`) plus its brief. That is the whole state read for most wakes.
- Fleet-wide view only when needed: `bin/fleet active` (live id/status/agentId) and `bin/fleet asks` (every open ask).
- `/bearings` "Landed" reads the archive tail (`tail -20 state/fleet-archive.jsonl`), never the whole file.
- `get_agent_activity` always passes `limit: 10`; `list_agents` always filters by `statuses`/`sinceHours` for the current cwd.

## Reconstruction on restart

1. `bin/fleet active` for the live index.
2. `list_agents` (filtered to the current cwd) for ground truth; match by `agentId`.
3. For each active-in-file task: present → keep; absent → `set` it `failed`, tell the captain.
4. `bin/fleet asks` so open questions survive the restart.
5. Emit one supervision summary to the captain and go idle.

## Heartbeat safety net

Paseo pushes finish/error/permission events, so you do not poll. The one gap it cannot cover is a crew member that goes *silent* — stalled without finishing or erroring. Register a single low-frequency `create_heartbeat` (e.g. every 30 min) that wakes you to scan `bin/fleet active` for tasks whose `lastEvent` is old while `status` is still `running`, and hand those to `stuck-crew-recovery`. Delete and recreate the heartbeat if its cadence needs to change (Paseo has no heartbeat-update tool).
