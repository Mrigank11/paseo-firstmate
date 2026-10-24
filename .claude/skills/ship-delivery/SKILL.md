---
name: ship-delivery
description: Use when a ship task finishes to confirm its PR, merge it under authority, and tear down the worktree — or when the captain says its work already landed.
---

# Ship Delivery

This skill handles a ship task's delivery lifecycle after the crew member finishes: confirm the PR, decide whether to merge, merge, tear down.

Trigger: a ship-task finish event for a task in the live index (`bin/fleet get <id>`; fields: `id`, `shape`, `state`, `since`, `branch`, `pr`, `asks`; the crew agent is found by its `fm.task` label — `bin/fleet stage <id>` prints its id — and its workspace is in `get_agent_status`) — **or the captain saying a task's work already landed** ("merged", "I merged PR #n"), which enters directly at §6. Policy lives in `state/decisions.md`. The first mate never edits project code; running `gh` to inspect or merge a PR is orchestration, not a code edit. Every fleet write below goes through `bin/fleet` — never hand-edit `fleet.json`.

## 1. Confirm the branch and PR exist

Read `mcp__paseo__get_agent_activity` for the crew member's agent (`bin/fleet stage <id>` → `agentId`; pass `limit: 10`; plus its own final report, if any) to find the branch name and PR URL. If the crew reported `preview: <port> <pid>` in its final message, record it now with `bin/fleet preview <id> <port> <pid>` (kept in `tasks/<id>/preview.json`).

Record `branch` and `pr` with `bin/fleet set <id> branch=… pr=…` before doing anything else.

If no PR was opened, nudge the crew member exactly once with `mcp__paseo__send_agent_prompt`:

```json
{ "agentId": "<crew-agent-id>", "prompt": "No PR found for ship task <id>. Push your branch and open a PR, then reply with the PR URL." }
```

If there is still no PR after the nudge, raise it with `bin/fleet ask <id> "No PR opened for <id>: …"`, log it with `bin/fleet log`, and escalate to the captain.

## 2. Merge authority (exactly two)

The first mate may merge ONLY under one of these authorities, never on its own initiative:

(a) The captain gave explicit approval for this specific PR, or (b) a standing auto-merge posture recorded in `state/decisions.md` permits automatically merging a GREEN PR.

A green-only posture NEVER authorizes merging a red PR. When in doubt about which authority applies, escalate.

## 3. Check green before merging

Verify checks on every PR before merging:

```bash
gh pr view <url> --json state,mergeStateStatus,statusCheckRollup
gh pr checks <url>
```

Merge only when the PR is open and all required checks pass. If checks are red, pending without a green signal, or missing, do NOT merge unless the captain has explicitly allowed this specific red merge with a stated reason. Otherwise run `bin/fleet set <id> status=needs-captain` and escalate with the check output.

## 4. Merge

Use the repo's merge style (default `--squash`; follow `CONTRIBUTING` or repo convention if it specifies `--merge` or `--rebase`):

```bash
gh pr merge <url> --squash
```

Record the merge with `bin/fleet log <id> "merged <SHA or URL>"` (it stamps UTC) and `bin/fleet set <id> pr=<url>` if the PR URL is not recorded yet.

## 5. Delivery modes

Read the project mode from `state/decisions.md`; default is `direct-PR`.

- `direct-PR` — crew opens a PR; first mate merges under the authority in section 2.
- `local-only` — no PR; crew commits to a branch and the first mate leaves it for the captain. Do not merge or close local-only work unless `decisions.md` explicitly says so.
- `gated` — a named validation command must pass before merge. Run it, or confirm from agent activity that the crew ran it green, before merging. A failed gate blocks the merge like a red check.

## 6. Teardown — whenever the work has landed, whoever landed it

Teardown is keyed to the work **landing**, not to *you* merging it. Run this section after your own merge in §4 (including when the captain said "merge"), or when the captain says a task's PR is merged/landed ("merged", "I merged PR #n"). The captain's word is itself the trigger — never just acknowledge it.

1. Verify the landing yourself: `gh pr view <pr> --json state` must return `MERGED` (or, for local-only repos with no PR, the branch is merged into its base), and record it with `bin/fleet log` (SHA/URL, who merged).
2. Stop the task's preview server if one is recorded (`tasks/<id>/preview.json` holds `{port, pid}`): check the pid is still that process (e.g. `/proc/<pid>/cmdline` mentions the port), `kill` it, then `bin/fleet clear-preview <id>`. Never kill a pid that fails the check — surface it instead.
3. If the workspace is dedicated to this task — `kind: worktree` in `list_workspaces` **and** no other live agent with a different `fm.task` label sits in it (the workspace is the crew agent's, from `get_agent_status`) — call `mcp__paseo__archive_workspace`:

```json
{ "workspaceId": "<crew-workspace-id>" }
```

   Never archive a `local_checkout` (a repo's standing checkout, even if only this task uses it) or a workspace another task's agent also uses; leave it and note why. If the crew agent is somehow still live, close it too (`mcp__paseo__archive_agent`).
4. Close the task out of the live index: `bin/fleet finish <id> --branch <b>` (it refuses open asks unless the same command answers them: `--close-asks` / `--answer a1`), record the teardown with `bin/fleet log`, then `bin/fleet archive <id>` — the entry moves to `fleet-archive.jsonl` together with the task's agents and outcome.
5. If the landed repo is **paseo-firstmate itself** (the checkout you run from), run `git -C /home/mrigank/projects/llm-exp/paseo-firstmate pull --ff-only` so the merged rules are live in your next turn; if the fast-forward fails, tell the captain.

REFUSE teardown while there is unlanded work: unmerged commits, an open PR, or a dirty worktree. Surface the unlanded state to the captain instead of archiving.

## 7. Finish

Always persist state (`bin/fleet` / `log`, and `state/decisions.md` if policy changed) before ending. Unless an ask is open for the captain, end the turn without further escalation.
