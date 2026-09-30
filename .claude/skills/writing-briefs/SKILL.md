---
name: writing-briefs
description: Use when dispatching a Paseo crew member, before spawning, to write its task brief.
---

# Writing briefs

This skill fires at dispatch time, before any Paseo agent is spawned: it defines the brief every crew member gets.

The brief is saved to `state/tasks/<id>/brief.md`, and that file's content becomes the crew member's `initialPrompt` verbatim — disk and prompt never diverge, so the on-disk brief is the source of truth.

## Captain's intent

Capture the captain's ask faithfully: quote their actual words where it matters, then add explicit boundaries stating what is in scope, what is out of scope, what must NOT be touched, and the definition of done.

This section preserves intent so the first mate can answer follow-ups, defend scope against drift, and resume correctly after a context compaction or restart.

## Firstmate spec

State scope and constraints ONLY, never a solution: the first mate says WHAT outcome is wanted plus the guardrails, and leaves HOW to the crew member — that judgment is the whole reason a capable model was hired.

Always name the task shape (`scout` vs `ship`), the target repo and paths to read, the deliverable location, and hard constraints (don't touch X, follow the repo's AGENTS.md/CLAUDE.md conventions, run the repo's own tests).

Deliverable paths must be absolute, rooted at the first mate's own checkout — never relative. A relative `state/tasks/<id>/report.md` lands in whatever repo the crew member happens to be standing in. Write the full path (e.g. `/home/mrigank/projects/llm-exp/paseo-firstmate/state/tasks/<id>/report.md`).

A `scout` is investigation/research, report-only: it is READ-ONLY on project code, never edits it, and must produce the absolute-path `report.md` deliverable named above.

A **planning** task is a scout in the `planning` lane: its brief says explicitly *produce a plan/design as the report; do not implement, do not edit code, do not spawn sub-agents.* A contributor `ship` that implements a plan cites the plan's `report.md` path in its brief.

A `ship` is a code change in its own worktree: it opens a branch and PR, then stops — delivery (merge under authority, then teardown) is handled per the `ship-delivery` skill.

## Base SHA

Record the base SHA from the dispatch-time refresh (`dispatch-routing`) in the Firstmate spec: "You are on `<sha>` (`<baseBranch>`, fetched just now, includes …)." If the base checkout was dirty and could not be fast-forwarded, say so here instead. The crew member reports the SHA it actually worked on in its `DONE:` line, so a stale audit is visible from its SHA.

## Final message contract

End every brief with this footer verbatim (fill the brackets):

> Your final message must be ≤ 5 lines and its first line must be `DONE: <absolute deliverable path or PR URL> @ <base SHA you worked on>` or `BLOCKED: <the exact question you need answered>`. Anything else is read as mid-task narration and acted on as nothing.

A Paseo finish event marks the end of a *turn*, not the *task* — crew end turns while waiting on background work. The first line is the only completion signal the first mate checks, so the `DONE:`/`BLOCKED:` prefix is what gets the report harvested or the question escalated.

## Anti-pattern: over-specifying the solution

Do not write a step list, name functions or files to create, or dictate the implementation: outcome plus boundaries lets the crew member adapt to what it finds, while a prescribed solution goes stale on first contact with the repo.

Keep intent verbatim for durability: after a restart or compaction the brief on disk is the only reliable record of what the captain actually wanted, not the first mate's memory of the conversation.

## Examples

Scout brief:

```markdown
## Captain's intent

Captain asked: "why is checkout latency spiking on weekends?" In scope: checkout API path in `services/checkout/`. Out of scope: payment provider internals. Do NOT touch any project code. Done = report with likely causes ranked plus supporting evidence.

## Firstmate spec

Shape: scout (READ-ONLY on project code). Read `services/checkout/` and its AGENTS.md. Follow repo conventions for reading only. You are on `<sha>` (`main`, fetched just now). Deliverable: `/home/mrigank/projects/llm-exp/paseo-firstmate/state/tasks/T-12/report.md` with findings, evidence, and suggested next steps. Do not open a PR.

Your final message must be ≤ 5 lines and its first line must be `DONE: <absolute deliverable path or PR URL> @ <base SHA you worked on>` or `BLOCKED: <the exact question you need answered>`. Anything else is read as mid-task narration and acted on as nothing.
```

Ship brief:

```markdown
## Captain's intent

Captain asked: "add exponential backoff to the checkout retry loop." In scope: retry logic in `services/checkout/retry.ts`. Out of scope: changing retry limits or alerting. Do NOT touch `services/billing/`. Done = PR with tests passing.

## Firstmate spec

Shape: ship in your own worktree. Read `services/checkout/retry.ts` and its AGENTS.md/CLAUDE.md, then implement the outcome above. You are on `<sha>` (`main`, fetched just now). Constraints: keep the public API stable, add/extend tests, run the repo's own test suite. Deliverable: open a branch and PR, then stop — the captain merges.

Your final message must be ≤ 5 lines and its first line must be `DONE: <absolute deliverable path or PR URL> @ <base SHA you worked on>` or `BLOCKED: <the exact question you need answered>`. Anything else is read as mid-task narration and acted on as nothing.
```
