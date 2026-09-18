---
name: dispatch-routing
description: Use when dispatching a scout or ship task to choose provider/model and spawn the crew agent.
---

# Dispatch routing

Resolve the launch configuration in this order, then spawn once and stop — supervision is the loop in `CLAUDE.md`, not here.

## 1. Resolution order

Check `state/decisions.md` first for a captain override naming a profile or provider/model; a captain override wins over everything below.

If no override, call `mcp__paseo__list_profiles` first and read every profile's `notes`; pick the profile whose notes best match the work, or one the captain named in the brief.

Fall back to `mcp__paseo__list_providers` (plus `mcp__paseo__list_models` for one provider) only when no profile fits; when you fall back, tell the captain plainly that no profile fit so they can add or fix one.

## 2. Cheap vs judgment split

Send cheap agentic work (search, scrape, bulk file reads, repetitive edits, fan-out research) to a cheap high-context contributor model, and keep judgment work (planning, architecture, ambiguous debugging, final review) on a high-reasoning model.

The concrete cheap launch is provider `opencode/opencode-go/muse-spark-1.3-contributor` (1M context, ~$0.10/$0.20 per Mtok) with `settings: { modeId: "build", features: { auto_accept: true } }` — OpenCode has no bypassPermissions mode, so `auto_accept: true` is what stops the agent stalling on an approval prompt nobody is watching.

```json
{
  "title": "Scout: auth flow",
  "provider": "opencode/opencode-go/muse-spark-1.3-contributor",
  "initialPrompt": "<brief>",
  "settings": { "modeId": "build", "features": { "auto_accept": true } }
}
```

## 3. Materializing a profile into create_agent

There is no `profile` param on `mcp__paseo__create_agent` — you materialize the chosen profile field-by-field: profile `provider`/`model` as `provider` (e.g. `claude/opus`), `modeId` → `settings.modeId`, `thinkingOptionId` → `settings.thinkingOptionId`, `featureValues` → `settings.features`.

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
