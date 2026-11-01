---
name: dispatch-routing
description: Use when dispatching a scout or ship task to choose provider/model and spawn the crew agent.
---

# Dispatch routing

Resolve the launch configuration in this order, then spawn once and stop — supervision is the loop in `CLAUDE.md`, not here.

## 1. Resolution order

Resolve every task's launch config in this precedence, stopping at the first that applies:

1. **Per-task captain override** — the captain named a lane, provider, or model for *this* task, in the ask or in `state/decisions.md`. Obey it.
2. **Routing lane** — classify the task's role (section 2), find its lane in the `## Routing` table of `state/decisions.md`, and materialize that lane's spec (section 3).
3. **Default lane** — if no role mapping matched, use the lane marked default in that table. Nothing is ever left unrouted.
4. **Fallback (only if `decisions.md` defines no lanes)** — match a Paseo profile via `mcp__paseo__list_profiles` by its `notes`, else pick from `mcp__paseo__list_providers` / `list_models`, and tell the captain you fell back because no lane or profile fit.

Re-read `decisions.md` every dispatch rather than trusting a remembered copy — the captain edits lanes there at any time.

## 2. Classifying a task's role

Lanes are keyed by role; you infer the role (the captain can always override):

- **planning / judgment** — you (the first mate), plus tasks that need real reasoning: architecture, ambiguous debugging, design, final review, or a scout whose value is a judgment call.
- **contributor / execution** — everything else: most scouts, well-specified ship implementations, fan-out research, scraping, bulk edits. This is the default lane.

**Lane × shape guard:** the planning lane runs *plan-only scouts* — a planning-lane agent reads and outputs a plan, never a ship, and never edits code. Implementation is always a *contributor-lane ship*, briefed from that plan. Escalate to a planning-lane scout only when planning genuinely exceeds your own model's reach; otherwise plan in-house and dispatch a cheap ship directly.

When a task sits on the line, prefer the cheaper contributor lane and note it in one line to the captain; escalate to planning only when the work visibly needs it. Never ask the captain per task which lane to use — the assignment table and the default exist so you do not have to.

The contributor lane is typically the cheap, high-context `opencode/opencode-go/muse-spark-1.3-contributor` (~$0.10/$0.20 per Mtok); OpenCode has no bypassPermissions mode, so `features: { auto_accept: true }` keeps it from stalling on an approval prompt nobody is watching. A concrete contributor launch:

```json
{
  "title": "Scout: auth flow",
  "provider": "opencode/opencode-go/muse-spark-1.3-contributor",
  "initialPrompt": "<brief>",
  "settings": { "modeId": "build", "features": { "auto_accept": true } }
}
```

## 3. Materializing a lane or profile into create_agent

A lane is normally a Paseo profile (`profile:fm-planning`, `profile:fm-contributor`, `profile:fm-fallback`; the repo's `config/paseo-profiles.json` is their source, installed with `bin/page profiles --apply`). Call `mcp__paseo__list_profiles`, find the profile by `id`, and copy its fields: there is no `profile` param on `mcp__paseo__create_agent`, so the profile's `provider` + `model` → `provider` (`<provider>/<model>`, e.g. `claude/claude-opus-5-5`), `modeId` → `settings.modeId`, `thinkingOptionId` → `settings.thinkingOptionId`, `featureValues` → `settings.features`. `notes` says when to use it. A lane written as a raw spec (`provider/model · mode · features`) maps the same way. If `list_profiles` does not have the profile, fall back to the raw spec in `decisions.md`, or tell the captain the profiles are not installed.

**Contributor fallback.** If the `fm-contributor` agent cannot start (the provider errors on launch, e.g. OpenCode too old for `muse-spark-1.3-contributor`), relaunch once with `profile:fm-fallback` and say so in one line to the captain; do not retry the failing profile.

Given a profile `{ "provider": "claude", "model": "opus", "modeId": "build", "thinkingOptionId": "think-hard", "featureValues": { "auto_accept": true } }`, the call becomes:

```json
{
  "title": "Ship: add retry to sync worker",
  "provider": "claude/opus",
  "workspaceId": "<worktree-id>",
  "initialPrompt": "<brief>",
  "notifyOnFinish": false,
  "settings": { "modeId": "build", "thinkingOptionId": "think-hard", "features": { "auto_accept": true } },
  "labels": { "fm.task": "<id>", "fm.project": "<project>", "fm.shape": "ship", "canvas": "on", "canvas.relay": "<your own agent id>", "canvas.strict": "on", "canvas.nudge": "on", "fm.notify": "plugin" }
}
```

Stamp the labels on every `create_agent`: `fm.task` (the task id, the join key from an agent to its task), `fm.project` (the project page the task belongs to; omit it for a task with no project) and `fm.shape` (`scout` or `ship`). The legacy `task` / `shape` labels are no longer read by anything; old agents may still carry them, new ones don't need them. A crew agent with no `fm.task` label is invisible to the stage engine (the page shows its task as Dispatching, then Lost). Re-tasking an existing agent: `mcp__paseo__update_agent { labels: { "fm.task": "<new-id>" } }` (plus `fm.project` / `fm.shape` if they changed) before `send_agent_prompt`, so the label always names the agent's current task.

**Canvas labels.** Every firstmate crew member gets a live canvas, from its first step: stamp `"canvas": "on"` and `"canvas.relay": "<your own $PASEO_AGENT_ID>"` with the other labels. `canvas=on` is the per-agent switch (it beats agent-canvas's global one, so the captain's own agents stay untouched); `canvas.relay` makes a captain's pick on the canvas come to *you* first (a `## Canvas answer · …` message), not straight to the crew, so the guardrail check in `project-page` always runs. The agent only has the canvas recipe because its brief carries the `## Your canvas` section (`writing-briefs`): the two always go together. The exception is a one-shot chore (a quick lookup, a single command): label it `"canvas": "off"` instead, leave out `canvas.relay`, and leave the section out of its brief. Also stamp `"canvas.strict": "on"` and `"canvas.nudge": "on"` on every crew that has a canvas. `canvas.strict=on` makes agent-canvas refuse a crew's open question (and a `waiting`/`blocked` status) unless its canvas has the structure (BLUF → issue → impact → context and components → changes by component → fix plan → ask, then closed folds only) and refuse appends at the canvas root; the crew's brief teaches that shape. The deck's finish gate reads the same label: a strict crew that ends `BLOCKED: canvas ask <id>` while its canvas holds no such open question is sent back once with agent-canvas's error, is not put in Needs you and does not wake you; the second time it reaches you as a normal BLOCKED (`stuck-crew-recovery`). `canvas.nudge=on` turns on agent-canvas's single stale-canvas reminder. Leave both off for a `canvas=off` chore, or per crew when the captain asks for a looser canvas. Re-tasking (`update_agent`) keeps all of these labels, and tells the crew to `set` a fresh canvas (an old task's content would otherwise stay on it). A relaunch from `stuck-crew-recovery` copies them (all five canvas labels). When a new first mate takes over (`bin/page claim`), the claim re-points `canvas.relay` on the open crews itself; the page flags `relay-target-gone` for any it could not reach.

Required fields on `mcp__paseo__create_agent` are `title`, `provider`, `initialPrompt`; `workspaceId` selects the workspace (below), `notifyOnFinish` is false when the plugin wake is on (the default; see below) and true only when `decisions.md` says `notify: off`.

**Plugin-gated wake (on by default).** Stamp `"fm.notify": "plugin"` on every crew and set `notifyOnFinish: false`, unless `state/decisions.md` has the line `notify: off` (then never set `fm.notify` and leave `notifyOnFinish` true; the plugin still audits every crew turn in `state/gate-log.jsonl`). The deck plugin then wakes you, the project's claimed first mate, with `## Crew <VERDICT> · <task>` only on a real `DONE:`/`BLOCKED:` first line (a narration-only first finish no longer uses up the one Paseo notification). A crew launched without the label gets only Paseo's single notification, which a narration-only first finish can use up: that is how a later `DONE:` goes unheard, so never omit it.

## 4. Refresh the base before dispatch

Never branch a ship worktree, or point a scout at a checkout, off a stale base:

1. `git -C <repo> fetch origin <baseBranch>` (usually `main`).
2. If the local base checkout is clean (`git -C <repo> status --porcelain` empty), fast-forward it (`git -C <repo> merge --ff-only origin/<baseBranch>`).
3. If it is dirty, do not touch it — note that in the brief instead ("base checkout was dirty, could not fast-forward; you may be behind `origin/<baseBranch>`").
4. Record the resulting base SHA (`git -C <repo> rev-parse --short HEAD`) in the brief per `writing-briefs` ("You are on `<sha>`…").

## 5. Workspace choice by shape

A `ship` task gets its own worktree: call `mcp__paseo__create_workspace` with required `isolation: "worktree"`, `mode: "branch-off"` plus `branchName`/`baseBranch`, then pass the returned `workspaceId` to `create_agent`.

```json
{ "isolation": "worktree", "mode": "branch-off", "branchName": "crew/<task-id>-<slug>", "baseBranch": "main" }
```

A `scout` task never touches project code and gets no worktree: omit `workspaceId` so it inherits the first mate's read-only workspace, or create a fresh `isolation: "local"` workspace for scratch output; never give a scout a project write path.

## 6. After spawning

Record the task with `bin/fleet add <id> intent="…" shape=<scout|ship> state=active [project=<p>] [title="…"]` — nothing about the agent goes into the registry: its id, workspace and model are Paseo's, found through the `fm.task` label (`bin/fleet stage <id>` shows them). Then end the turn — do not follow the agent, poll it, or start reviewing output in this turn.

## 7. Never guess IDs

Never guess a model or feature ID — set only feature IDs returned by `mcp__paseo__inspect_provider` (required `provider`), and if a value is rejected re-read `mcp__paseo__list_models` / `inspect_provider` and retry with a listed value rather than inventing a close match.
