# Fleet state format

The first mate's memory lives on disk under `state/`, not in the model's context. This is the whole reason a compaction or restart is a non-event: on any wake, re-read the waking task's entry; on any change, write it back through `bin/fleet`. Paseo knows the agents and what they are doing right now; it does not know the *intent* behind a task, its shape, or the captain's decisions. The registry holds the intent and nothing about run state: **what a task is doing is computed from Paseo, never copied into `fleet.json`**.

One file used to do two jobs — lookup index and narrative journal — and grew to ~135 KB. Now the live index stays small, narrative lives per task, and finished work leaves the hot path on its own. A routine wake reads at most ~2k tokens of state: the waking task's entry plus the live index, never the archive.

## Layout

```
state/
  fleet.json            # LIVE tasks only (small index), version 2
  fleet-archive.jsonl   # one compact line per finished, ask-free task (history; append-only)
  backup/               # fleet.v1.<ts>.json + fleet-archive.<ts>.jsonl, written by bin/migrate-fleet-v2 --apply
  firstmate.json        # {"agentId","claimedAt"}: the checkout-wide first mate (fallback for pages with no claim.json), written by plain bin/page claim
  # projects/<project>/claim.json  {"agentId","claimedAt"}: that page's own first mate, written by bin/page claim <project> / start
  decisions.md          # captain prefs, routing lanes, permission + merge policy
  tasks/
    <id>/
      brief.md          # captain's intent + firstmate spec (see writing-briefs skill)
      report.md         # scout tasks only: the harvested result
      log.md            # narrative journal for the task (append-only); the only home of narrative
      card.md           # the Markdown card the page shows (bin/fleet card / finish)
      canvas.final.html # the crew's final canvas, kept by bin/page canvas-snapshot before its agent is archived (+ canvas.final.tsx, its source)
      preview.json      # {"port","pid"} of a crew preview server (bin/fleet preview): a kill handle, not status
      asks/<n>.md       # optional long context for ask n (bin/fleet ask --context-file)
  projects/
    <project>/          # per-project page; written by the first mate and the page plugin
      project.json
      sections/*.md|html
      inbox.jsonl
      page.json
```

`state/` is gitignored — it is runtime state, not source. Durable *learnings* ("provider X keeps wedging on task type Y") do not belong here; graduate them to the captain's basic-memory instead.

## Who owns what

| Fact | Owner | Where it lives |
|---|---|---|
| Intent, shape, project, title, the captain's decisions and open asks, `depends_on`, `branch`/`pr` | first mate | `state/fleet.json` (via `bin/fleet`) |
| Which agent works on a task, its status, activity, model, workspace, pending permissions | Paseo | the agent itself, found by its labels |
| Which task an agent serves | first mate writes, Paseo stores | agent labels `fm.task`, `fm.project`, `fm.shape` (set at `create_agent`; `update_agent` when an agent is re-tasked) |
| Stage (Running, Needs you, Review, Lost...) | computed | `computeStage()`, never stored: `bin/fleet stage <id>` / `stages` |
| Narrative, "what happened" | first mate | `tasks/<id>/log.md` |
| One-line summary of a finished task | first mate | `tasks/<id>/card.md` |
| Finished history | archive | `fleet-archive.jsonl` (`agents:[ids]`, `outcome`) |

Labels: `fm.task` is the task id the agent is working on *now* (an agent reused for another task is re-labelled), `fm.project` the project slug (absent when none), `fm.shape` `scout|ship`. The `fm.*` namespace is reserved for firstmate; the legacy `task`/`shape` labels are left alone and ignored.

## `fleet.json` (v2) — the live index

One object, `{ "version": 2, "tasks": [...] }`. A file without `"version": 2` is a v1 registry: `bin/fleet` still reads it but refuses every write ("run `bin/migrate-fleet-v2`"), and the page plugin shows a banner instead of tasks. Each task:

```json
{
  "id": "kebab-slug",
  "intent": "one line: what the captain actually wants",
  "shape": "scout | ship",
  "state": "queued | active | parked | blocked | done | failed",
  "since": "2026-10-23T09:12:00Z   (when state last changed; set by bin/fleet)",
  "project": "kebab-slug   (optional; groups tasks onto a project page)",
  "title": "≤160 chars plain text (optional; display name)",
  "depends_on": ["other-task-id"],
  "blocked_on": "≤200 chars: what an outside party owes us (required while state=blocked, otherwise absent)",
  "branch": "feature/x   (ship only, once known)",
  "pr": "https://…        (ship only, once opened)",
  "agents": ["…"],
  "askSeq": 2,
  "asks": [{"id": "a2", "text": "≤200 chars open question", "since": "2026-09-20", "context": "tasks/<id>/asks/2.md (optional)", "options": ["A", "B"], "pendingSince": "set by bin/fleet pending (optional)", "ref": null}]
}
```

`state` is the first mate's *intent / verdict*, never run state:

- `queued` — planned, not dispatched. `active` — dispatched; Paseo says what is happening. `parked` — the captain paused it. `blocked` — an outside party (neither the captain nor the crew) owes us something; requires `blocked_on`. `done` / `failed` — the first mate's verdict after harvest; the task waits in the index until its asks are answered, then `archive`.
- `since` is when `state` last changed (`add` stamps it, and `set state=…` stamps it on a real change). It is used only for the Dispatching → Lost grace window.
- `agents` is written by `finish` (the agents that carried `fm.task=<id>`) so `archive` can keep them; a migrated task keeps its old `agentId` there.
- `ask.ref` is reserved for Phase 5 (`{"kind":"canvas","agentId","block"}`, `bin/fleet ask --ref`).
- **Removed in v2, refused with a pointer** (`bin/fleet set/add`): `status` (use `state`; running / needs-captain are computed, and a question for the captain is an ask), `agentId` and `workspaceId` and `provider` (Paseo's: label `fm.task`, the agent's own record), `lastEvent` (Paseo's `updatedAt`), `notes` (narrative → `log`, summary → `card`), `preview` (→ `tasks/<id>/preview.json`).

Rules:

- `id` is a stable kebab slug you assign at dispatch; it names the `tasks/<id>/` dir and is the agent's `fm.task` label.
- `bin/fleet active` lists tasks with `state=active` (`{id, state, since, project}`); it says nothing about what the agent is doing — `bin/fleet stages` does.
- `blocked` requires `blocked_on="<what/who>"` (≤200 chars) in the same `add`/`set`; `blocked_on` is refused on any other state and dropped automatically when the state moves off `blocked`.
- `project` is a kebab slug (`^[a-z0-9][a-z0-9-]*$`; empty/null = none) and `title` is plain text up to 160 chars; both are set via `add`/`set` and survive into the archive. `bin/fleet project <p>` prints every live task of a project (any state); `bin/fleet project <p> --archive [N]` prints the last N (default 30) archived lines; `bin/fleet active --project <p>` filters the active list.
- `depends_on` holds task ids, changed only with `bin/fleet depend <id> <dep-id>...` (appends, de-duplicates) and `bin/fleet undepend <id> <dep-id>`. Ids may refer to archived tasks, so they are not checked against the live index.
- Every ask has a **stable id** (`a1`, `a2`, ...), assigned by `bin/fleet ask` from the task's `askSeq` counter and never reused for that task, even after the ask is answered. `reask`, `pending` and `answer` take that id (`bin/fleet answer <id> a2`); a plain 1-based number still works but means "the ask at that position right now", so use ids whenever more than one ask is open. The project page, its comment targets (`t-<task>#a2`) and option clicks all use the id, so answering one ask never re-targets another.
- `bin/fleet pending <id> <ask>` sets `pendingSince` on the ask: the first mate's explicit "I am working on a follow-up", which keeps the ask under "With the first mate" on the project page (`bin/page reply ... --followup <id>:<ask>` calls it). `reask` and `answer` clear it.
- Every `bin/fleet` command that writes holds a lock for its whole read-modify-write (`flock` on `fleet.json.lock`, or an `mkdir` lock where `flock` is missing), so parallel calls cannot lose an update.
- `bin/fleet add <id> intent=… shape=… state=… [depends_on=a,b]` creates a task. A task with no `project=` inherits the project of its first dependency that has one (live or archived); `depend` does the same for a task that still has none.
- `bin/fleet finish <id> [--failed] [--card -|--card-file <f>] [--branch <b>] [--base main] [--close-asks | --answer <ask>...]` is what you run when a crew member finishes. It **refuses a task with open asks** unless the same command answers them (`--close-asks` answers all, `--answer a1` one, repeatable), so a finished task never leaves an answered question open. It then sets `done` (or `failed`), records the task's agents, writes `tasks/<id>/card.md` from the given card (or, when there is none yet, from the `intent` plus branch/PR) and, for a project task whose branch is known and whose `project.json` has a `repo`, appends `git log --oneline <base>..<branch>` to the project's `sections/code.md` (dated, no duplicate commits on a re-run).
- `bin/fleet ask <id> "<text>" --context-file <path>` copies the file to `tasks/<id>/asks/<n>.md` and stores it as the ask's `context`. `answer` removes the ask but leaves the file.
- **Never hand-edit `fleet.json`.** Every write goes through `bin/fleet` (`add`, `set`, `ask`, `reask`, `pending`, `answer`, `preview`, `clear-preview`, `archive`, `finish`, plus `depend`/`undepend`): it validates the state/shape enums and the 200-char caps, then writes atomically (temp file + rename). A refused write changes nothing. Reads are `get`, `by-agent`, `active`, `asks`, `project`, `stage`, `stages`. `bin/fleet` with no args prints usage.
- `asks` is the task's open questions for the captain. An ask outlives the step that raised it: closing a task never closes its asks. `bin/fleet archive` and `bin/fleet finish` both REFUSE to leave a task with open asks.
- `bin/fleet answer` first appends the ask (id, text, `since`, context path, options, `answeredAt`) to `state/tasks/<id>/asks.jsonl`, so a finished card keeps showing it with its context file; `fleet.json` stays small. The Done group sorts by `since`, newest first (an explicit `order` still pins ahead), and a done card also shows a pointer to `report.md`.
- A `done`/`failed` task with no open asks leaves the index: `bin/fleet archive <id>` appends it to `fleet-archive.jsonl` (adding `agents:[ids]` and `outcome: done|failed`) and removes it. Never delete a task any other way. Archive lines are history and stay append-only; old v1 lines (`status`, `agentId`, `notes`, `lastEvent`) are never rewritten and stay readable.

## Reading on a wake (token budget)

- Map the event's `agentId` to its task with `bin/fleet by-agent <agentId>` (reads the agent's `fm.task` label, then the archive), then read that ONE entry (`bin/fleet get <id>`) plus its brief. That is the whole state read for most wakes.
- Fleet-wide view only when needed: `bin/fleet stages` (every live task's computed stage, drift flags included) and `bin/fleet asks` (every open ask).
- `/bearings` "Landed" reads the archive tail (`tail -20 state/fleet-archive.jsonl`), never the whole file.
- `get_agent_activity` always passes `limit: 10`; `list_agents` always filters by `statuses`/`sinceHours` for the current cwd.

## Reconstruction on restart

1. `bin/fleet stages --table`: every live task, its computed stage and its flags. Nothing to reconcile by hand — the stage already comes from Paseo.
2. Act on flags: `Lost` / `no-agent` (no agent carries the task's label: relaunch with the same `fm.task`, or `finish --failed`), `Review` (a finished agent: harvest), `Idle` / `idle-no-done` (a mid-task stop: read it), `archived-agent-open-task`, and the drift flags (`queued-but-has-agent`, `parked-but-running`, `done-but-running`).
3. `bin/fleet asks` so open questions survive the restart.
4. Emit one supervision summary to the captain and go idle.

## Heartbeat safety net

Paseo pushes finish/error/permission events, so you do not poll. The one gap it cannot cover is a crew member that goes *silent* — stalled without finishing or erroring. Register a single low-frequency `create_heartbeat` (e.g. every 30 min) that wakes you to run `bin/fleet stages` and hand the tasks flagged `silent` (no agent activity for 30 min), `Lost` or `Idle` to `stuck-crew-recovery`. The same wake runs `bin/page heal`, which reloads the firstmate-deck plugin when it has failed or has stopped rendering an open project page (it needs no judgment, and it is how a dead page plugin gets noticed at all). Delete and recreate the heartbeat if its cadence needs to change (Paseo has no heartbeat-update tool).

## Read marks, ordering and long pages

- **Optional task fields** (`bin/fleet add`/`set`): `order` (a whole number; sorts the task within its group, tasks without one keep file order) and `legacyId` (the id the task had on a hand-run page it came from). `bin/fleet card <id> --file <f>` writes `tasks/<id>/card.md` for a live or archived task; `bin/fleet archive-update <id> k=v ...` appends an updated copy of an archived task (the newest line for an id wins).
- **Sections and layout**: `bin/page scaffold`, `section` (replace `sections/<name>.html` or `.md`) and `configure` (merge keys into `project.json`: `sectionTitles`, `sectionSubtitles`, `collapsedSections`, `archiveLimit`, ...) shape long hand-written pages. A `.html` section is shown as is.
- **Read marks** ("Done, unread", Mark read / Mark all read) are served by the plugin on `readMarksPort` (default 4398, 127.0.0.1 plus the `tailscale ip -4` address, else setting `readMarksHost`), per project in `state/projects/<p>/ui-state.json`, keyed by `t-<task>` plus the first 8 hex of the sha1 of `card.md`, so a changed card is unread again. `bin/page marks` merges marks in. The page shows everything unread, silently, if the endpoint is unreachable.
- **Task navigator**: the page's rail (a spine of stage icons when folded, a bar on phones) lists every task by stage and jumps to its card. It is built from the same task data as the cards; it stores only view choices, as 0/1 flags among the open/closed flags in `ui-state.json`: `tn-exp` (unfolded), `tn-c-<stage>` (stage collapsed), `tn-focus` (focus view on) and `tn-sel:<card id>` (the focused task; switching sets the old one to 0).
- `bin/page stop <project>` sets `session: stopped`: the plugin kills that page's poll and stops rendering until `bin/page start <project>`.

## Computed stage

A task's stage is never stored. `computeStage()` (`plugin/firstmate-deck/server/stage.ts`) derives it live from three inputs: the registry's intent (`state`), the task's open asks, and the Paseo agents carrying the label `fm.task=<task id>`. The page, the sidebar summary, `bin/fleet stage <id>` / `bin/fleet stages [--project p] [--table]` and the DRIFT column of `bin/page status` all call it, so they cannot disagree. The **current agent** is the newest non-archived one; if all are archived, the newest archived one. Rules run top to bottom, the first match wins:

| # | Condition | Stage | Page group |
|---|---|---|---|
| 1 | the task is in the archive | Done / Failed (frozen) | Done |
| 2 | `state` done / failed | Done / Failed (an open ask keeps it in Needs you / With the first mate) | Done |
| 3 | an open ask with no reply (any state) | Needs you | Needs you |
| 4 | every open ask replied or pending | With the first mate | With the first mate |
| 5 | `parked` (an agent still running → flag `parked-but-running`) | Parked | Parked |
| 6 | `blocked` | Blocked (shows `blocked_on`) | Blocked |
| 7 | `queued` (an agent exists → flag `queued-but-has-agent`) | Next up | Next up |
| 8 | `active`, the current agent has a pending permission | Needs you · permission | Needs you |
| 9 | `active`, no agent, `since` < 10 min ago | Dispatching | Running |
| 10 | `active`, no agent, ≥ 10 min | Lost (flag `no-agent`) | With the first mate |
| 11 | `active`, agent archived | Agent archived (flag `archived-agent-open-task`) | With the first mate |
| 12 | `active`, agent running / initializing | Running (no activity > 30 min → flag `silent`) | Running |
| 13 | `active`, agent error | Failed (agent errored) | With the first mate |
| 14 | `active`, agent idle/closed, its last message starts `DONE:` | Review | With the first mate |
| 15 | same, starts `BLOCKED:` | Blocked by crew | With the first mate |
| 16 | same, neither (flag `idle-no-done`) | Idle | With the first mate |
| — | any live stage, the current agent's `canvas.relay` first mate no longer exists | (unchanged) + flag `relay-target-gone` | (unchanged) |

**Canvas (Phase 5).** A crew member dispatched with the labels `canvas=on` and `canvas.relay=<first mate agent id>` has a live canvas in agent-canvas. The brief's `## Your canvas` section comes from `bin/page canvas-snippet <scout|ship>`; a captain's pick on a canvas ask reaches the first mate as `## Canvas answer · …` and goes to the crew only through `bin/page canvas-answer <task> <askId> <value>` (or `--decline "<why>"`). `bin/page claim` re-points `canvas.relay` on the open crews; when the relay agent is gone the task carries the drift flag `relay-target-gone`. Before a task's agent is archived, `bin/page canvas-snapshot <task>` writes `tasks/<id>/canvas.final.html` (+ `.tsx`): agent-canvas stops serving a canvas once its agent is archived. The canvas settings `canvasUrl` / `canvasDir` of the deck are stamped into `page.json`, which is how `bin/page` finds agent-canvas (`AGENT_CANVAS_URL`, `AGENT_CANVAS_DIR` and `AGENT_CANVAS_KEY_FILE` override; the relay key is `<paseo home>/agent-canvas/relay.key`).

A flag with `drift: true` means the registry and Paseo disagree and the first mate should act. A *running* agent never lands in Needs you unless an ask or a permission puts it there. On the CLI path the agent's last message is unknown, so a finished agent reads "Idle (final line unknown on CLI)" rather than a guessed "no DONE:". Agents are found by label only: with no `fm.task` label there is no agent (the v1 `agentId` hint is gone), so label every crew agent at `create_agent`.

## Migrating a v1 registry

`bin/migrate-fleet-v2 [--state <dir>] [--apply] [--no-daemon]` (dry run by default). It plans the labels for every agent in the registry and archive, transforms the tasks (`status` → `state`, notes/provider/agentId/workspaceId → the task log, preview → `preview.json`, draft asks for `needs-captain` tasks with none), and prints the v1-vs-v2 page group of every task. `--apply` takes backups into `state/backup/`, writes a canary label on one archived agent and aborts if it does not read back, writes all labels through the Paseo CLI (`$PASEO_HOME` picks the daemon), then writes `fleet.json` v2 atomically and logs `migrated v2` per task. Run `bin/page install` afterwards so the page plugin reads v2. Rollback: `cp state/backup/fleet.v1.<ts>.json state/fleet.json`, revert the code; labels are additive and harmless.
