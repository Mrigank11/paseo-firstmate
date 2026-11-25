---
name: scout-report
description: Use when framing, dispatching, or harvesting a scout task that investigates and delivers its findings as a complete canvas without touching code.
---

# Scout Report

This skill covers `scout` tasks: read-only investigation, research, audit, or planning that ends in a report and nothing else.

## Framing a scout

The brief structure comes from the writing-briefs skill; this skill supplies the scout-specific content that must go in every scout brief.

State explicitly in the brief that the crew member is READ-ONLY on project code: it may read repos, follow imports, search the web, and run non-mutating analysis (read, grep, list, test in dry-run or no-write modes), but it must NOT edit files, commit, create branches, open a PR, or run any mutating command.

Require a single deliverable: the crew's canvas. It holds the whole result (BLUF, evidence, recommendation with options, a "Not verified" list; long evidence in closed folds) and is complete in itself: the captain opens no file. Tell the crew not to write a `report.md` and never to point the canvas at a file. Nothing else is persisted outside `state/tasks/<id>/`.

## What a good canvas contains

Require BLUF first: a one-line answer or recommendation at the very top, so the captain can act without reading further.

Then evidence and reasoning: what was checked, what was found, and why it supports the BLUF — findings, not a narrative of what the agent did.

Then concrete next steps or options with tradeoffs: what to do with the finding, including at least one alternative and its cost.

Then sources: file paths inspected, commands run (read-only), and URLs consulted, in a closed fold, so any claim can be spot-checked.

## Harvesting on finish

When a scout finishes, read its canvas yourself before saying anything to the captain: the live one (`bin/page canvas-snapshot <id>` saves it and `state/tasks/<id>/canvas.final.tsx` is its plain-text source). If it is thin, or only points at something, send the crew back; do not fill it in from elsewhere.

The canvas is kept for you: `bin/fleet finish` saves it to `state/tasks/<id>/canvas.final.html` (+ `.tsx`) and refuses to finish if it cannot (`--no-canvas` for a task that never had one), and agent-canvas stops serving a canvas once its agent is archived. An ask you raise on the task snapshots it for you, and its `--context-file` is then only a short note: the canvas is the explanation (see `project-page`).

**Wiki line.** For a project with a `## Project wikis` entry in `state/decisions.md`, the crew's `DONE:` message must carry a second line `Wiki: <notes created or edited>` or `Wiki: no new facts: <reason>`, and the canvas lists the same notes. If the line is missing, or the reason is empty ("none", "n/a"), send the crew back once (`send_agent_prompt`) and do not finish the task until it is there. Check one listed note exists and holds the finding, and that a scout touched only its plan folder, never `today/` or `vision/`.

Mark the task done only after you have confirmed the canvas contains a BLUF plus evidence: `bin/fleet finish <id>`, record it with `bin/fleet log`, then `bin/fleet archive <id>` so the entry leaves the live index for `fleet-archive.jsonl`. `finish` and `archive` both refuse a task with open asks: answer each with the captain first, or close them in the same command (`bin/fleet finish <id> --close-asks`, or `--answer a1`) — never leave an answered question open.

Reply to the captain with a ONE-LINE digest (the BLUF, or your corrected version of it) pointing at the task's card — never paste the result into the conversation and never answer with a file path.

## Tear down a dedicated workspace

Most scouts inherit a **shared** read-only checkout (e.g. the campaigns local checkout) and you must NEVER archive it — other tasks reuse it. But a scout given its **own** workspace for isolation (a throwaway worktree, or a fresh `isolation: local` scratch per `dispatch-routing` §4 — self-referential and planning scouts are the usual case) owns that workspace alone. Once you have archived such a task (and taken the canvas snapshot above), stop its recorded preview the same way `ship-delivery` §6 does (`tasks/<id>/preview.json` holds `{port, pid}` — check, kill, `clear-preview` *before* archiving), then archive its workspace with `mcp__paseo__archive_workspace` (`{ workspaceId }`) and record it with `bin/fleet log`.

The test is **ownership, not shape**: archive the `workspaceId` of the task's current agent (`get_agent_status`; find the agent with `bin/fleet stage <id>`) when it is `kind: worktree` and no other live agent with a different `fm.task` label sits in it; never archive one another task's agent also uses (a shared checkout), and never a `local_checkout`. REFUSE teardown if the workspace holds unlanded work (a dirty tree or unpushed commits) — surface it to the captain instead of archiving.

## Verify before trust

Scout crew members often run on cheap/fast models whose output can be plausible but wrong, so treat every load-bearing factual claim (a file exists, an API behaves a certain way, a doc says X) as unverified until spot-checked.

Before the captain acts, confirm the 1–3 claims the recommendation hinges on: check the file exists, skim the cited source, or re-run the read-only check yourself.

Flag anything you could not confirm as unverified in the digest, e.g. `Unverified: agent claims X in <path>, I did not confirm`.

## Scouts never ship

A scout never produces a PR and never mutates a repo; if its finding implies a code change, frame that as a proposed NEW `ship` task for the captain to approve, with scope and rationale, and stop there.

A **planning** scout is this pattern's engine: its report *is* a design/plan, and a follow-on `ship` task in the contributor lane implements it — the plan-only scout itself still never touches code.

Never let a scout roll into implementation on its own initiative, even for a trivial fix — the task shape boundary is absolute.

## Fanning out multiple scouts

When a question splits into independent sub-questions, dispatch one scout per sub-question, each with its own task id and its own canvas, then synthesize from their saved canvases yourself.

Give each brief an explicit non-overlap clause naming the sibling scopes it must NOT cover, so two scouts do not duplicate work or contradict each other silently.
