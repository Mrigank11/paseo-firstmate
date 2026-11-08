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
  decisions.md          # captain prefs, routing lanes, permission + merge policy; `notify: off` / `enforcer: off` switch the plugin's wake / enforcer off
  stages.json           # DERIVED, plugin-written: every live task's owner, reason, stage (what bin/fleet stage(s) print); never edited
  enforcer.json         # plugin-owned: reminder counts per item, stalled items, reminded crews; safe to delete
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
  "canvas_kind": "issue | plan | research | explainer | review (optional; absent = issue)",
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
- `bin/fleet ask <id> "<text>" --context-file <path>` copies the file to `tasks/<id>/asks/<n>.md` and stores it as the ask's `context`. `answer` removes the ask but leaves the file. **One explanation per card:** before it reads the file, `ask`/`reask` take `bin/page canvas-snapshot <id>` (best effort: no crew canvas, no snapshot; skipped when `FLEET_NO_SNAPSHOT` is set or the state dir is not `<root>/state`). When `tasks/<id>/canvas.final.html` exists the file is a short note: at most 1,200 characters, no required headings, stored with `"note": true` on the ask and shown open as "First mate adds"; a longer file is refused. Without a canvas the file is the full Context as before (seven headings for an `issue` task). In the card, a Needs-you or With-the-first-mate task whose crew is gone shows the snapshot as "Crew canvas" with its recap strip (as a Done card does), and a full Context folds whenever a canvas is on the card.
- **Never hand-edit `fleet.json`.** Every write goes through `bin/fleet` (`add`, `set`, `ask`, `reask`, `pending`, `answer`, `preview`, `clear-preview`, `archive`, `finish`, plus `depend`/`undepend`): it validates the state/shape enums and the 200-char caps, then writes atomically (temp file + rename). A refused write changes nothing. Reads are `get`, `by-agent`, `active`, `asks`, `project`, `stage`, `stages`. `bin/fleet` with no args prints usage.
- `asks` is the task's open questions for the captain. An ask outlives the step that raised it: closing a task never closes its asks. `bin/fleet archive` and `bin/fleet finish` both REFUSE to leave a task with open asks.
- `bin/fleet answer` first appends the ask (id, text, `since`, context path, options, `answeredAt`) to `state/tasks/<id>/asks.jsonl`, so a finished card keeps showing it with its context file; `fleet.json` stays small. The Done group sorts by `since`, newest first (an explicit `order` still pins ahead), and a done card also shows a pointer to `report.md`.
- A `done`/`failed` task with no open asks leaves the index: `bin/fleet archive <id>` appends it to `fleet-archive.jsonl` (adding `agents:[ids]` and `outcome: done|failed`) and removes it. Never delete a task any other way. Archive lines are history and stay append-only; old v1 lines (`status`, `agentId`, `notes`, `lastEvent`) are never rewritten and stay readable.

## The finish gate (`state/gate-log.jsonl`)

The deck plugin's `agent.turn_ended` hook (`plugin/firstmate-deck/server/gate.ts`) audits every turn of an agent carrying `fm.task`. Plugin-owned and append-only; the registry is never written. One JSON line per decision: `{at, agentId, task, turnId, verdict, line, acted, result, note}`.

- `verdict`: `DONE`/`BLOCKED` (first non-empty line of the final message starts with it), `NARRATION` (anything else; a later `DONE:` line is a `near-miss`, logged and ignored), `ERROR` (turn failed), `CANCELED`, `CLOSED`.
- `result`: `shadow` (logged only), `woke` (the `## Crew <VERDICT> · <task>` message was delivered; `note` = recipient), `deferred` (DONE/BLOCKED while the agent was still running; re-checked after 60 s and on the next turn end), `failed` (3 send attempts), `no-target`, `narration`, `near-miss`. `shadow` and `woke` dedupe on (agent, turn, verdict) across restarts.
- It wakes when the agent has `fm.notify=plugin` and `state/decisions.md` does not say `notify: off` (on by default; `off` or `shadow` puts it back to shadow, which only logs). Recipient: the project's owner (the project claim, else the checkout claim), and only if neither is live the agent's parent (`paseo.parent-agent-id`). The owner comes first because the parent label names whoever dispatched the crew, who may since have been replaced.
- Sweep: at plugin start-up (no SDK handle needed) a CLI pass covers plugin-notified agents of the registry's active tasks (`paseo ls --label fm.task=<id>` / `fm.notify=plugin`, `inspect`, `logs`; the final message is approximated from the log, last `DONE:`/`BLOCKED:` line of the trailing block). Once an SDK handle exists (first hook or RPC), and every 10 min, the exact pass runs over all idle `fm.task` agents updated in the last 6 h. Both skip what the log already holds, so a finish is never woken twice.
- Rollback: add the line `notify: off` (new dispatches use Paseo notifications again; agents already launched with `notifyOnFinish:false` stay plugin-only, so heartbeat `bin/fleet stages` still catches them).

## The permission hook (`state/permission-log.jsonl`)

The deck plugin's `agent.permission_requested` hook (`plugin/firstmate-deck/server/permission.ts`, rules in `server/rules.ts`) classifies the permission requests of agents carrying `fm.task` against the ```` ```json fm-permission-rules ```` block in `state/decisions.md` (re-read when the file's mtime moves). Plugin-owned and append-only. One JSON line per request: `{at, agentId, task, requestId, kind, name, summary, decision, rule, mode, acted, result, note}`, deduped on (agent, request) across restarts.

- Rules: `read` (read/search anywhere), `writeWithin` (edit/write only inside `$WORKTREE`, the agent's cwd under the Paseo worktrees root, or `$ROOT/state/tasks/$TASK`; symlinks resolved), `shell.allow` regexes matched against each normalised part of the command (compound commands: every part; leading `NAME=value` stripped, `shell.envDeny` names escalate; `shell.wrappers` regexes such as `rtk`, `time`, `timeout N`, `env` stripped from the head; redirections must stay inside `writeWithin`; `$`, backticks, subshells, here-docs, `&`, comments and newlines escalate; `--output`/`--exec`/`--pre` flags refused; `shell.denyChars` is an optional extra), `fetchHosts` (exact hosts), `allowKinds` (`question`/`plan`/`mode` always need a person). Optional `worktreeRoots` overrides where a worktree may live (default `<paseo home>/worktrees` and `~/.paseo/worktrees`).
- `decision`: `would-allow` (shadow), `allow` (enforce; `result: responded`, or `respond-failed` with the request left pending), `escalate`. **It never denies.** A missing or unparsable block escalates everything, `mode` counts as shadow, and every project page shows a banner.
- `mode: shadow` (the default) only logs. `mode: enforce` answers allowed requests through `respondToPermission({behavior:"allow"})` (verified on Paseo 0.12.0).
- Escalation: for an agent with `fm.notify=plugin` and the wake not switched off (`notify: off` in decisions.md) the first mate is woken with `## Crew PERMISSION · <task>` (the request, the rule that failed, agent/request ids; same recipient rules as the gate, `result: woke`); otherwise `result: no-wake` and Paseo's own permission notification is the only wake.
- Rollback: `mode: shadow`.

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

- **Optional task fields** (`bin/fleet add`/`set`): `order` (a whole number; sorts a live task within its group and pins it ahead of the rest; tasks without one keep file order, except in Done and Parked, where they go newest first by `since` (Parked: the time it was parked). An archive line's `order` is ignored) and `legacyId` (the id the task had on a hand-run page it came from). `bin/fleet set <id> order=` (an empty value) removes `order`, `branch`, `pr`, `title` or `blocked_on` from the task (`blocked_on` only while the task is not blocked). `bin/fleet card <id> --file <f>` writes `tasks/<id>/card.md` for a live or archived task; `bin/fleet archive-update <id> k=v ...` appends an updated copy of an archived task (the newest line for an id wins).
- **Sections and layout**: `bin/page scaffold`, `section` (replace `sections/<name>.html` or `.md`) and `configure` (merge keys into `project.json`: `sectionTitles`, `sectionSubtitles`, `collapsedSections`, `archiveLimit`, ...) shape long hand-written pages. A `.html` section is shown as is.
- **Read marks** ("Done, unread", Mark read / Mark all read) are served by the plugin on `readMarksPort` (default 4398, 127.0.0.1 plus the `tailscale ip -4` address, else setting `readMarksHost`), per project in `state/projects/<p>/ui-state.json`, keyed by `t-<task>` plus the first 8 hex of the sha1 of `card.md`, so a changed card is unread again. `bin/page marks` merges marks in. The page shows everything unread, silently, if the endpoint is unreachable.
- **Seen state** (the tab's `*` and the "new" dots): `s: { at, keys }` in the same `ui-state.json`, keys `t-<task>` and `page` mapped to the 8-hex attention key the captain was shown; the newest `at` replaces the whole snapshot. Seeded at a page's first render.
- **Task navigator**: the page's rail (a spine of stage icons when folded, a bar on phones) lists every task by stage and jumps to its card. It is built from the same task data as the cards; it stores only view choices, as 0/1 flags among the open/closed flags in `ui-state.json`: `tn-exp` (unfolded), `tn-c-<stage>` (stage collapsed), `tn-focus` (focus view on) and `tn-sel:<card id>` (the focused task; switching sets the old one to 0).
- `bin/page stop <project>` sets `session: stopped`: the plugin kills that page's poll and stops rendering until `bin/page start <project>`.

## Computed stage

A task's stage is never stored. `computeStage()` (`plugin/firstmate-deck/server/stage.ts`) derives it live from the registry's intent (`state`), the task's open asks, and the Paseo agents carrying the label `fm.task=<task id>`. Every stage is a pair: an **owner** (who owes the next move: `captain`, `firstmate`, `crew`, `outside`, `nobody`) and a **reason** (the facts that make it so: the comment time, the crew's final line). The page group is the owner: Needs you = captain, With the first mate = `firstmate`, Running = crew, Blocked = outside, Next up / Parked / Done = nobody. Each stage also carries `clears` (the command or skill that ends it) and a fingerprint `fp` (stage + reason + agent) that changes whenever the situation does. The **current agent** is the newest non-archived one; if all are archived, the newest archived one. Rules run top to bottom, the first match wins:

| # | Condition | Stage | Owner |
|---|---|---|---|
| 1 | the current agent has a pending permission (any state; an open ask is flagged beside it) | Needs you · permission | captain |
| 2 | the task is in the archive | Done / Failed (frozen) | nobody |
| 3 | `state` done / failed | Done / Failed (an open ask keeps it in Needs you / With the first mate) | nobody |
| 4 | an open ask with no reply — unless its captain comment was answered and the crew has started a turn since (flag `ask-open-after-reply`: Running) | Needs you | captain |
| 5 | every open ask replied or pending | With the first mate | first mate |
| 6 | `parked` / `blocked` / `queued`, no agent running (agent existing → flag `queued-but-has-agent`) | Parked / Blocked / Next up | nobody / outside / nobody |
| 7 | the same states with an agent running: the agent decides, plus a drift flag (`parked-but-running`, `blocked-but-running`, `queued-but-has-agent`) | Running | crew |
| 8 | `active`, no agent, `since` < 10 min ago / ≥ 10 min | Dispatching / Lost (flag `no-agent`) | crew / first mate |
| 9 | `active`, agent archived | Agent archived (flag `archived-agent-open-task`) | first mate |
| 10 | `active`, agent running / initializing | Running (no activity > 30 min → flag `silent`) | crew |
| 11 | `active`, agent error | Failed (agent errored) | first mate |
| 12 | idle/closed, last message starts `DONE:` (flag `merged` when git shows its branch merged) / `BLOCKED:` | Review / Blocked by crew | first mate |
| 13 | idle, neither, and the crew's canvas says Waiting / Working | Waiting / Running | crew |
| 14 | idle, neither (flag `idle-no-done`) | Crew stopped · no hand-back; after the plugin's one reminder, or when the agent is closed: Idle | crew; then first mate |
| — | any live stage, the current agent's `canvas.relay` first mate no longer exists | (unchanged) + flag `relay-target-gone` | (unchanged) |
| — | a curated ask whose canvas question is answered or gone (flag `ref-closed`) | With the first mate, or Running while the crew runs | first mate / crew |
| — | a card with 2+ asks and an unanswered comment on its body | (unchanged) + flag `comment-waiting` (a card with one ask: the comment counts against it) | (unchanged) |

**First mate stalled.** The enforcer (below) can turn a With-the-first-mate task into **Needs you · first mate stalled** (owner captain; `reason` says why). It applies only while the task is still in the situation (`fp`) it was judged in.

"The crew worked since" (rules 4 and the canvas pick) is measured from the crew's last **turn start** (the `agent.turn_started` hook, in the plugin's memory), not Paseo's `updatedAt`, which also moves on a label change or a steer; without a turn start it falls back to the last activity.

### One evaluation: `state/stages.json`

The deck plugin is the only evaluator with all the inputs (registry, inbox comments, agents with their last messages, canvases, the owner first mate's status). On every render, tick and enforcement change it evaluates every live task with the same function the page uses and writes `state/stages.json`: `{version, writtenAt, pid, inputsMtimeMs, owners, rows}`, one row per task with `stage, group, owner, reason, clears, fp, owedSince, flags, agentId`. `owedSince` is when the current (owner, situation) took over; it survives a restart. `owners` maps each project (`""` = no project) to the first mate that owns it: the project claim, else the checkout claim, only while live.

`bin/fleet stage <id>` / `bin/fleet stages [--project p] [--table]` print that snapshot (each row has `source: "plugin"`) whenever it is fresh: written within 2 minutes and not older than `fleet.json` or any inbox. A write made a moment ago (`bin/fleet ask`, a comment) is waited for, up to 4 s (`STAGE_SNAPSHOT_WAIT_MS`), because the plugin re-evaluates within a second. Otherwise (plugin down, snapshot stale or missing a task) the CLI computes locally from the registry and Paseo's agent files (`source: "local"`, no comments, no last messages, so a finished crew reads Idle) and the table says **degraded**. `stages.json` is derived data: never edit it, safe to delete.

### The enforcer: if the first mate is idle, no task is with the first mate

`plugin/firstmate-deck/server/enforcer.ts`. After each snapshot, and on every turn end of an owner first mate (after a 60 s settle: it must still be idle), the plugin looks at the owner's tasks in the With-the-first-mate group and, for any it has not reminded about, sends the owner one digest per project:

```
## With you · <project>
You are idle, but these tasks are still with you. Clear each one (the "clears" line says how), then end your turn.
- <task> · <stage>
  why: <reason> (since <time>)
  clears: <command or skill>
```

Rules (the loop is bounded):
- An **item** is a task in one situation (`fp`). Each item gets **at most 2 reminders**, the second no sooner than 30 min after the first, and never while the owner is working or while a reminder's own turn is still running. A reminder that could not be delivered is not counted.
- When the turn a reminder started ends idle and the item is unchanged, that was the answer. After the **second**, the task is stalled: **Needs you · first mate stalled** on the page, in `stages.json` and in the sidebar count. It stays so until the situation changes (a new reply, a new final line, the first mate acting), which also resets the count.
- No live owner (no claim, or the claimed agent is gone): the task is stalled at once, with no message sent.
- An idle crew that ended without `DONE:`/`BLOCKED:` gets one reminder to hand back (stage **Crew stopped · no hand-back**, owner crew); if it stays silent the task reaches the first mate as Idle.
- State (counts, awaiting flags, stalled items, reminded crews) is in `state/enforcer.json`, plugin-owned and safe to delete, so a restart does not start over. The settle, gap and tick can be shortened through the daemon's environment (`FM_ENFORCER_SETTLE_MS`, `FM_ENFORCER_GAP_MS`, `FM_ENFORCER_TICK_MS`; the isolated demo does). Rollback: a line `enforcer: off` in `state/decisions.md`.
- What the first mate does with a digest line is in its skills: a reply or pick → `project-page`; a finished crew → `ship-delivery` / `scout-report`; BLOCKED, errored, archived or lost → `stuck-crew-recovery`.

**Canvas (Phase 5).** A crew member dispatched with the labels `canvas=on` and `canvas.relay=<first mate agent id>` has a live canvas in agent-canvas. The brief's `## Your canvas` section comes from `bin/page canvas-snippet <scout|ship>`; a captain's pick on a canvas ask reaches the first mate as `## Canvas answer · …` and goes to the crew only through `bin/page canvas-answer <task> <askId> <value>` (or `--decline "<why>"`). `bin/page claim` re-points `canvas.relay` on the open crews; when the relay agent is gone the task carries the drift flag `relay-target-gone`. Before a task's agent is archived, `bin/page canvas-snapshot <task>` writes `tasks/<id>/canvas.final.html` (+ `.tsx`): agent-canvas stops serving a canvas once its agent is archived. The canvas settings `canvasUrl` / `canvasDir` of the deck are stamped into `page.json`, which is how `bin/page` finds agent-canvas (`AGENT_CANVAS_URL`, `AGENT_CANVAS_DIR` and `AGENT_CANVAS_KEY_FILE` override; the relay key is `<paseo home>/agent-canvas/relay.key`).

**Needs-you structure.** A crew dispatched with `canvas.strict=on` (and `canvas.nudge=on`, agent-canvas's stale reminder) is held to one canvas shape before it may ask: BLUF → issue → impact → context and components → changes by component → fix plan → ask, then closed folds only, rewritten in place (the brief's canvas section, `canvas-cmd.ts`, carries the template; agent-canvas enforces it and answers a refused write with `"code":"needs_you_structure"`). The finish gate reads the label: a strict crew ending `BLOCKED: canvas ask <id>` with no such open question on its canvas is sent back once with agent-canvas's last refusal (`lastRejection` in `/api/fm/summary`), logged as `bounced` in `state/gate-log.jsonl`, not put in Needs you and no wake; the second time is an ordinary BLOCKED. In Needs you the task card shows that crew's whole canvas open, BLUF uncut, instead of the compact strip.

**Canvas kind.** The label `canvas.kind` (`issue|plan|research|explainer|review`; the task field `canvas_kind` mirrors it, set at `bin/fleet add`) says how much structure the crew's canvas has. Only `issue`, and a crew with no label, is held to the needs-you structure and the recap above; the other four kinds are free-form like a normal Lavish page: agent-canvas does no structure, recap, size or top-level-append check on them, `bin/page canvas-snippet <shape> --kind <k>` prints "free form" brief text (still asking for the recap), and `bin/fleet ask-template <id>` / the ask-context heading check apply the seven headings to issue tasks only. The deck's finish gate still bounces a `BLOCKED: canvas ask` with no open question on the canvas, for any kind.

**Recap strip.** The same strict crews must also put a top-level `<Markdown id="recap">` (`**You asked:** …` / `**I did:** …`, 500 characters) right after the BLUF on any canvas that asks or is `done`; agent-canvas refuses the write without it and exposes it as `recap` in `/api/fm/summary` (and leaves it out of the embedded card). The deck shows it as a strip at the top of cards in Needs you, With the first mate and Done (`recapStrip` in `render.ts`); a done card reads it from `canvas.final.tsx` (`bin/page canvas-snapshot` keeps it). When the captain commented on the task after the crew last wrote the canvas (summary `updatedAt`; the snapshot's mtime for a done card), the strip shows that comment and "Not acted on yet" instead of the old pair. No recap, no strip; Running, Next, Parked and Blocked cards never show it. The first mate's own asks follow the same headings: `bin/fleet ask-template` prints the context-file skeleton and `ask`/`reask` refuse a file without those headings in order.

A flag with `drift: true` means the registry and Paseo disagree and the first mate should act. A *running* agent never lands in Needs you unless an ask or a permission puts it there. On the local (degraded) CLI path the agent's last message is unknown, so a finished agent reads "Idle (final line unknown on CLI)" rather than a guessed "no DONE:". Agents are found by label only: with no `fm.task` label there is no agent (the v1 `agentId` hint is gone), so label every crew agent at `create_agent`.

## Migrating a v1 registry

`bin/migrate-fleet-v2 [--state <dir>] [--apply] [--no-daemon]` (dry run by default). It plans the labels for every agent in the registry and archive, transforms the tasks (`status` → `state`, notes/provider/agentId/workspaceId → the task log, preview → `preview.json`, draft asks for `needs-captain` tasks with none), and prints the v1-vs-v2 page group of every task. `--apply` takes backups into `state/backup/`, writes a canary label on one archived agent and aborts if it does not read back, writes all labels through the Paseo CLI (`$PASEO_HOME` picks the daemon), then writes `fleet.json` v2 atomically and logs `migrated v2` per task. Run `bin/page install` afterwards so the page plugin reads v2. Rollback: `cp state/backup/fleet.v1.<ts>.json state/fleet.json`, revert the code; labels are additive and harmless.
