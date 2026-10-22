# Fleet state format

The first mate's memory lives on disk under `state/`, not in the model's context. This is the whole reason a compaction or restart is a non-event: on any wake, re-read the waking task's entry; on any change, write it back through `bin/fleet`. Paseo knows an agent's `agentId` and live status, but it does not know the *intent* behind a task, its shape, or the captain's decisions — those live here and only here.

One file used to do two jobs — lookup index and narrative journal — and grew to ~135 KB. Now the live index stays small, narrative lives per task, and finished work leaves the hot path on its own. A routine wake reads at most ~2k tokens of state: the waking task's entry plus the live index, never the archive.

## Layout

```
state/
  fleet.json            # LIVE tasks only (small index)
  fleet-archive.jsonl   # one compact line per finished, ask-free task
  firstmate.json        # {"agentId","claimedAt"}: THE first mate of this checkout, written by bin/page claim
  decisions.md          # captain prefs, routing lanes, permission + merge policy
  secondmates.md        # phase 3: roster of subordinate first mates (only if any)
  afk-log.md            # phase 3: running log while the captain is AFK (only if any)
  tasks/
    <id>/
      brief.md          # captain's intent + firstmate spec (see writing-briefs skill)
      report.md         # scout tasks only: the harvested result
      log.md            # narrative journal for the task (append-only)
      asks/<n>.md       # optional long context for ask n (bin/fleet ask --context-file)
  projects/
    <project>/          # per-project page; written by the first mate and the page plugin
      project.json
      sections/*.md|html
      inbox.jsonl
      page.json
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
  "project": "kebab-slug   (optional; groups tasks onto a project page)",
  "title": "≤160 chars plain text (optional; display name)",
  "depends_on": ["other-task-id"],
  "blocked_on": "≤200 chars: what an outside party owes us (required while status=blocked, otherwise absent)",
  "status": "queued | parked | blocked | dispatched | running | needs-captain | done | failed",
  "branch": "feature/x   (ship only, once known)",
  "pr": "https://…        (ship only, once opened)",
  "lastEvent": "2026-09-18T12:00:00Z finished",
  "notes": "≤200 chars: what the next wake needs to know (overflow → log.md)",
  "askSeq": 2,
  "asks": [{"id": "a2", "text": "≤200 chars open question", "since": "2026-09-20", "context": "tasks/<id>/asks/2.md (optional)", "pendingSince": "set by bin/fleet pending (optional)"}],
  "preview": {"port": 4321, "pid": 12345}
}
```

Rules:

- `id` is a stable kebab slug you assign at dispatch; it names the `tasks/<id>/` dir.
- `status` is *your* view of truth, updated on every wake. It is not Paseo's status — reconcile them when they disagree, trusting a fresh `get_agent_status` over a stale field.
- `queued` = planned, not yet dispatched; `parked` = the captain deliberately paused it; `blocked` = waiting on an outside dependency (a person, vendor or system that is neither the captain nor the crew, e.g. "Nemath: Trigger Prod API key"). None of the three counts as active: `bin/fleet active` lists only `dispatched`, `running`, `needs-captain`.
- `blocked` requires `blocked_on="<what/who>"` (≤200 chars) in the same `add`/`set`; `blocked_on` is refused on any other status and dropped automatically when the status moves off `blocked`. Status meanings in short: `needs-captain` = the captain's decision, `parked` = the captain paused it, `blocked` = an outside dependency, `running` = crew working.
- `project` is a kebab slug (`^[a-z0-9][a-z0-9-]*$`; empty/null = none) and `title` is plain text up to 160 chars; both are set via `add`/`set` and survive into the archive. `bin/fleet project <p>` prints every live task of a project (any status); `bin/fleet project <p> --archive [N]` prints the last N (default 30) archived lines; `bin/fleet active --project <p>` filters the active list.
- `depends_on` holds task ids, changed only with `bin/fleet depend <id> <dep-id>...` (appends, de-duplicates) and `bin/fleet undepend <id> <dep-id>`. Ids may refer to archived tasks, so they are not checked against the live index.
- Every ask has a **stable id** (`a1`, `a2`, ...), assigned by `bin/fleet ask` from the task's `askSeq` counter and never reused for that task, even after the ask is answered. `reask`, `pending` and `answer` take that id (`bin/fleet answer <id> a2`); a plain 1-based number still works but means "the ask at that position right now", so use ids whenever more than one ask is open. An ask written before ids existed gets `a<its index>` at the first `bin/fleet` write that touches its task. The project page, its comment targets (`t-<task>#a2`) and option clicks all use the id, so answering one ask never re-targets another.
- `bin/fleet pending <id> <ask>` sets `pendingSince` on the ask: the first mate's explicit "I am working on a follow-up", which keeps the ask under "With the first mate" on the project page (`bin/page reply ... --followup <id>:<ask>` calls it). `reask` and `answer` clear it. Without the mark, an ask the captain commented on is back in Needs you once the comment is answered.
- Every `bin/fleet` command that writes holds a lock for its whole read-modify-write (`flock` on `fleet.json.lock`, or an `mkdir` lock where `flock` is missing), so parallel calls cannot lose an update.
- `bin/fleet add <id> ... depends_on=a,b` sets dependencies at creation. A task with no `project=` inherits the project of its first dependency that has one (live or archived); `depend` does the same for a task that still has none.
- `bin/fleet finish <id> [--failed] [--card -|--card-file <f>] [--branch <b>] [--base main]` is what you run when a crew member finishes: it sets `done` (or `failed`), writes `tasks/<id>/card.md` from the given card (or, when there is none yet, from `notes` plus branch/PR), and, for a project task whose branch is known and whose `project.json` has a `repo`, appends `git log --oneline <base>..<branch>` to the project's `sections/code.md` (dated, no duplicate commits on a re-run).
- `bin/fleet ask <id> "<text>" --context-file <path>` copies the file to `tasks/<id>/asks/<n>.md` and stores it as the ask's `context`. `answer` removes the ask but leaves the file.
- **Never hand-edit `fleet.json`.** Every write goes through `bin/fleet` (`add`, `set`, `ask`, `reask`, `pending`, `answer`, `preview`, `clear-preview`, `archive`, `finish`, plus `depend`/`undepend`): it validates the status/shape enums and the 200-char caps, then writes atomically (temp file + rename). A refused write changes nothing. Reads are `get`, `by-agent`, `active`, `asks`, `project`. `bin/fleet` with no args prints usage.
- `notes` holds at most 200 chars. Anything longer is narrative — append it with `bin/fleet log <id> "…"` and keep one line in `notes`.
- `asks` is the task's open questions for the captain. An ask outlives the step that raised it: closing a task never closes its asks. `bin/fleet archive` REFUSES a task with open asks — answer (`ask`/`answer`) or explicitly drop each one first.
- `preview` records a crew dev/preview server from its final message (`preview: <port> <pid>`). Teardown kills that pid (after checking it is still the same process) and runs `clear-preview` before archiving.
- `bin/fleet answer` first appends the ask (id, text, `since`, context path, options, `answeredAt`) to `state/tasks/<id>/asks.jsonl`, so a finished card keeps showing it with its context file; `fleet.json` stays small. The Done group sorts by `lastEvent`, newest first (an explicit `order` still pins ahead), and a done card also shows its notes and a pointer to `report.md`.
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

Paseo pushes finish/error/permission events, so you do not poll. The one gap it cannot cover is a crew member that goes *silent* — stalled without finishing or erroring. Register a single low-frequency `create_heartbeat` (e.g. every 30 min) that wakes you to scan `bin/fleet active` for tasks whose `lastEvent` is old while `status` is still `running`, and hand those to `stuck-crew-recovery`. The same wake runs `bin/page heal`, which reloads the firstmate-deck plugin when it has failed or has stopped rendering an open project page (it needs no judgment, and it is how a dead page plugin gets noticed at all). Delete and recreate the heartbeat if its cadence needs to change (Paseo has no heartbeat-update tool).

## Read marks, ordering and long pages

- **Optional task fields** (`bin/fleet add`/`set`): `order` (a whole number; sorts the task within its group, tasks without one keep file order), `legacyId` (the id the task had on a hand-run page it came from) and `provider` (labels the task when Paseo has no record of its agent). `bin/fleet card <id> --file <f>` writes `tasks/<id>/card.md` for a live or archived task; `bin/fleet archive-update <id> k=v ...` appends an updated copy of an archived task (the newest line for an id wins).
- **Sections and layout**: `bin/page scaffold`, `section` (replace `sections/<name>.html` or `.md`) and `configure` (merge keys into `project.json`: `sectionTitles`, `sectionSubtitles`, `collapsedSections`, `archiveLimit`, ...) shape long hand-written pages. A `.html` section is shown as is.
- **Read marks** ("Done, unread", Mark read / Mark all read) are served by the plugin on `readMarksPort` (default 4398, 127.0.0.1 plus the `tailscale ip -4` address, else setting `readMarksHost`), per project in `state/projects/<p>/ui-state.json`, keyed by `t-<task>` plus the first 8 hex of the sha1 of `card.md`, so a changed card is unread again. `bin/page marks` merges marks in. The page shows everything unread, silently, if the endpoint is unreachable.
- **Task navigator**: the page's rail (a spine of stage badges when folded, a bar on phones) lists every task by stage and jumps to its card. It is built from the same task data as the cards, so it needs no state of its own; its fold state stays in the browser and is not written to `ui-state.json`.
- `bin/page stop <project>` sets `session: stopped`: the plugin kills that page's poll and stops rendering until `bin/page start <project>`.
