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

- **planning / judgment** — you (the first mate) and any secondmate, plus tasks that need real reasoning: architecture, ambiguous debugging, design, final review, or a scout whose value is a judgment call.
- **contributor / execution** — everything else: most scouts, well-specified ship implementations, fan-out research, scraping, bulk edits. This is the default lane.

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

A lane's raw spec maps straight onto the call: `provider/model` → `provider` (e.g. `claude-work/claude-opus-4-8[1m]`), its mode → `settings.modeId`, its features → `settings.features`. A Paseo profile — a lane value of `profile:<name>`, or the section-1 fallback — materializes the same way: there is no `profile` param on `mcp__paseo__create_agent`, so map profile `provider`/`model` → `provider`, `modeId` → `settings.modeId`, `thinkingOptionId` → `settings.thinkingOptionId`, `featureValues` → `settings.features`.

Given a profile `{ "provider": "claude/opus", "modeId": "build", "thinkingOptionId": "think-hard", "featureValues": { "auto_accept": true } }`, the call becomes:

```json
{
  "title": "Ship: add retry to sync worker",
  "provider": "claude/opus",
  "workspaceId": "<worktree-id>",
  "initialPrompt": "<brief>",
  "notifyOnFinish": true,
  "settings": { "modeId": "build", "thinkingOptionId": "think-hard", "features": { "auto_accept": true } },
  "labels": { "task": "<id>", "shape": "ship" }
}
```

Required fields on `mcp__paseo__create_agent` are `title`, `provider`, `initialPrompt`; `workspaceId` selects the workspace (below), `notifyOnFinish` stays true unless the captain says otherwise.

## 4. Workspace choice by shape

A `ship` task gets its own worktree: call `mcp__paseo__create_workspace` with required `isolation: "worktree"`, `mode: "branch-off"` plus `branchName`/`baseBranch`, then pass the returned `workspaceId` to `create_agent`.

```json
{ "isolation": "worktree", "mode": "branch-off", "branchName": "crew/<task-id>-<slug>", "baseBranch": "main" }
```

A `scout` task never touches project code and gets no worktree: omit `workspaceId` so it inherits the first mate's read-only workspace, or create a fresh `isolation: "local"` workspace for scratch output; never give a scout a project write path.

## 5. After spawning

Record `{ id, agentId, workspaceId, provider, shape, status: "dispatched" }` into `state/fleet.json`, then end the turn — do not follow the agent, poll it, or start reviewing output in this turn.

## 6. Never guess IDs

Never guess a model or feature ID — set only feature IDs returned by `mcp__paseo__inspect_provider` (required `provider`), and if a value is rejected re-read `mcp__paseo__list_models` / `inspect_provider` and retry with a listed value rather than inventing a close match.
