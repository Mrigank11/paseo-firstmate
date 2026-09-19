---
name: scout-report
description: Use when framing, dispatching, or harvesting a scout task that investigates and writes a report.md without touching code.
---

# Scout Report

This skill covers `scout` tasks: read-only investigation, research, audit, or planning that ends in a report and nothing else.

## Framing a scout

The brief structure comes from the writing-briefs skill; this skill supplies the scout-specific content that must go in every scout brief.

State explicitly in the brief that the crew member is READ-ONLY on project code: it may read repos, follow imports, search the web, and run non-mutating analysis (read, grep, list, test in dry-run or no-write modes), but it must NOT edit files, commit, create branches, open a PR, or run any mutating command.

Require a single deliverable: findings written to `state/tasks/<id>/report.md`, using the exact task id in the path, and nothing else persisted outside that dir.

## What a good report.md contains

Require BLUF first: a one-line answer or recommendation at the very top, so the captain can act without reading further.

Then evidence and reasoning: what was checked, what was found, and why it supports the BLUF — findings, not a narrative of what the agent did.

Then concrete next steps or options with tradeoffs: what to do with the finding, including at least one alternative and its cost.

Then sources: file paths inspected, commands run (read-only), and URLs consulted, so any claim can be spot-checked.

## Harvesting on finish

When a scout finishes, read `state/tasks/<id>/report.md` yourself before saying anything to the captain.

Mark the task `done` in `state/fleet.json` only after you have confirmed the report exists and contains a BLUF plus evidence.

Reply to the captain with a ONE-LINE digest (the BLUF, or your corrected version of it) plus a pointer to the full report path — never paste the whole report into the conversation.

## Tear down a dedicated workspace

Most scouts inherit a **shared** read-only checkout (e.g. the campaigns local checkout) and you must NEVER archive it — other tasks reuse it. But a scout given its **own** workspace for isolation (a throwaway worktree, or a fresh `isolation: local` scratch per `dispatch-routing` §4 — self-referential and planning scouts are the usual case) owns that workspace alone. Once you have marked such a task `done`/`failed`, archive it with `mcp__paseo__archive_workspace` (`{ workspaceId }`) and record it in `notes`, exactly as `ship-delivery` §6 does for ships.

The test is **ownership, not shape**: archive a `workspaceId` that only this one task lists in `fleet.json`; never archive one that any other task also lists (a shared checkout). REFUSE teardown if the workspace holds unlanded work (a dirty tree or unpushed commits) — surface it to the captain instead of archiving.

## Verify before trust

Scout crew members often run on cheap/fast models whose output can be plausible but wrong, so treat every load-bearing factual claim (a file exists, an API behaves a certain way, a doc says X) as unverified until spot-checked.

Before the captain acts, confirm the 1–3 claims the recommendation hinges on: check the file exists, skim the cited source, or re-run the read-only check yourself.

Flag anything you could not confirm as unverified in the digest, e.g. `Unverified: agent claims X in <path>, I did not confirm`.

## Scouts never ship

A scout never produces a PR and never mutates a repo; if its finding implies a code change, frame that as a proposed NEW `ship` task for the captain to approve, with scope and rationale, and stop there.

A **planning** scout is this pattern's engine: its report *is* a design/plan, and a follow-on `ship` task in the contributor lane implements it — the plan-only scout itself still never touches code.

Never let a scout roll into implementation on its own initiative, even for a trivial fix — the task shape boundary is absolute.

## Fanning out multiple scouts

When a question splits into independent sub-questions, dispatch one scout per sub-question, each with its own task id and its own `state/tasks/<id>/report.md`, then synthesize the reports yourself.

Give each brief an explicit non-overlap clause naming the sibling scopes it must NOT cover, so two scouts do not duplicate work or contradict each other silently.
