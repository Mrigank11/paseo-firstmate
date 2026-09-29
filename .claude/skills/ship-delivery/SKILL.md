---
name: ship-delivery
description: Use when a ship task finishes to confirm its PR, merge it under authority, and tear down the worktree — or when the captain says its work already landed.
---

# Ship Delivery

This skill handles a ship task's delivery lifecycle after the crew member finishes: confirm the PR, decide whether to merge, merge, tear down.

Trigger: a ship-task finish event for a task tracked in `state/fleet.json` (fields: `id`, `shape`, `agentId`, `workspaceId`, `status`, `branch`, `pr`, `lastEvent`, `notes`) — **or the captain saying a task's work already landed** ("merged", "I merged PR #n"), which enters directly at §6. Policy lives in `state/decisions.md`. The first mate never edits project code; running `gh` to inspect or merge a PR is orchestration, not a code edit.

## 1. Confirm the branch and PR exist

Read `mcp__paseo__get_agent_activity` for the crew member's `agentId` (plus its own final report, if any) to find the branch name and PR URL.

Record `branch` and `pr` into `state/fleet.json` for that task before doing anything else.

If no PR was opened, nudge the crew member exactly once with `mcp__paseo__send_agent_prompt`:

```json
{ "agentId": "<crew-agent-id>", "prompt": "No PR found for ship task <id>. Push your branch and open a PR, then reply with the PR URL." }
```

If there is still no PR after the nudge, set `status: needs-captain` in `fleet.json`, note it in `lastEvent`/`notes`, and escalate to the captain.

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

Merge only when the PR is open and all required checks pass. If checks are red, pending without a green signal, or missing, do NOT merge unless the captain has explicitly allowed this specific red merge with a stated reason. Otherwise set `status: needs-captain` and escalate with the check output.

## 4. Merge

Use the repo's merge style (default `--squash`; follow `CONTRIBUTING` or repo convention if it specifies `--merge` or `--rebase`):

```bash
gh pr merge <url> --squash
```

Record the merge in `fleet.json` `notes` for the task: merge commit SHA or URL plus UTC timestamp.

## 5. Delivery modes

Read the project mode from `state/decisions.md`; default is `direct-PR`.

- `direct-PR` — crew opens a PR; first mate merges under the authority in section 2.
- `local-only` — no PR; crew commits to a branch and the first mate leaves it for the captain. Do not merge or close local-only work unless `decisions.md` explicitly says so.
- `gated` — a named validation command must pass before merge. Run it, or confirm from agent activity that the crew ran it green, before merging. A failed gate blocks the merge like a red check.

## 6. Teardown — whenever the work has landed, whoever landed it

Teardown is keyed to the work **landing**, not to *you* merging it. Run this section after your own merge in §4 (including when the captain said "merge"), or when the captain says a task's PR is merged/landed ("merged", "I merged PR #n"). The captain's word is itself the trigger — never just acknowledge it.

1. Verify the landing yourself: `gh pr view <pr> --json state` must return `MERGED` (or, for local-only repos with no PR, the branch is merged into its base), and record it in `notes` (SHA/URL, UTC time, who merged).
2. If the workspace is dedicated to this task — `kind: worktree` in `list_workspaces` **and** listed by exactly this one task in `fleet.json` — call `mcp__paseo__archive_workspace`:

```json
{ "workspaceId": "<crew-workspace-id>" }
```

   Never archive a `local_checkout` (a repo's standing checkout, even if only one task lists it) or a workspace another task also lists; leave it and note why. If the crew agent is somehow still live, close it too (`mcp__paseo__archive_agent`).
3. Set the task `status: done` in `fleet.json` and record the teardown in `notes`.
4. If the landed repo is **paseo-firstmate itself** (the checkout you run from), run `git -C /home/mrigank/projects/llm-exp/paseo-firstmate pull --ff-only` so the merged rules are live in your next turn; if the fast-forward fails, tell the captain.

REFUSE teardown while there is unlanded work: unmerged commits, an open PR, or a dirty worktree. Surface the unlanded state to the captain instead of archiving.

## 7. Finish

Always persist `state/fleet.json` (and `state/decisions.md` if policy changed) before ending. Unless the task is `needs-captain`, end the turn without further escalation.
