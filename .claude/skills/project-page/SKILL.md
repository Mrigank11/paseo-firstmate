---
name: project-page
description: Use when the captain wants a live page for a project, when a "## Page comments · <project>" message arrives, or when a task that belongs to a project page changes state.
---

# Project page

A project page is a Lavish HTML page per project: Needs you, Running, Next up, Parked and Done, plus hand-written sections (endpoints, flags, code changes, decisions, how it runs). The `firstmate-deck` Paseo plugin renders it from `state/fleet.json`, the archive and `state/projects/<project>/sections/`, owns its Lavish comment poll, and forwards comments to you. You never edit the page HTML and never poll it.

## Starting a page

`bin/page start <project> [--repo <path>] [--title "<title>"] [--page <path>]`

This is idempotent. It scaffolds `state/projects/<project>/`, renders the page, opens it in Lavish and prints JSON with the URL. Give the captain the URL in one line. That's the last thing the page needs from chat.

## Keeping it current: everything goes through scripts

| When | Run |
|---|---|
| Dispatching a task for the project | `bin/fleet add <id> ... project=<project> title="<short title>"` |
| Planned but not dispatched yet | `status=queued`, then `status=parked` when the captain shelves it |
| A task waits on another | `bin/fleet depend <id> <other-id>` |
| You need the captain's decision | `bin/fleet ask <id> "<BLUF question, ≤200 chars>" --context-file <md>` |
| A crew member finishes | write `state/tasks/<id>/card.md` (3–6 lines: what changed, where to look, what's untested), then the usual `bin/fleet set` |
| A local commit lands on a project branch | `bin/page note <project> code "<hash> <one line>"` |
| The captain decides something | `bin/page note <project> decisions "<decision>"` |
| An endpoint, flag or run step changes | edit `state/projects/<project>/sections/<name>.md` (endpoints, flags and how it runs are hand-written) |

The page re-renders on its own within seconds of any of these writes.

**Every question for the captain about this project is an ask on the page, never a chat question.** That includes "merge these branches?" and "which format?" at the end of a task. If a task is already done or archived, raise the ask on the task anyway before archiving it. `bin/fleet archive` refuses tasks with open asks, so the task stays visible until the captain answers.

**Asks are BLUF.** The ask text is the question the captain answers, readable on its own: "Ship without onboarding_path, or block staging on it?" The reasoning, options and evidence go in the context file, which opens under an expander.

## Answering page comments

A message starting `## Page comments · <project>` lists each comment with the card or section it was made on (`t-<taskId>` is a task card).

1. Act on each comment: steer crew, answer an ask (`bin/fleet answer`), write a note, or dispatch.
2. Answer once per message, with `bin/page reply <project> "<reply>"` (or `-` to read Markdown from stdin). Say what you did, briefly, and give one line per comment when there are several.
3. Chat stays quiet. Don't repeat the reply in chat.

The captain's Lavish panel shows "Working" until your reply, so always reply, even if the reply is "noted, nothing to change".

## When something's wrong

- `bin/page status` shows each page, its Lavish session, how many comments are undelivered, and the plugin's health.
- The page shows a red banner when comments can't reach you. Run `bin/page status`, and tell the captain in chat if the plugin is down.
- The captain ended the page with Send & End: don't reopen it. Run `bin/page start <project> --reopen` only when the captain asks.

## Never

- Run `lavish-axi poll` or `lavish-axi share` on a project page. The plugin owns the poll, and pages hold local creds.
- Hand-edit the page HTML, `inbox.jsonl` or `page.json`.
- Put a cross-project or fleet view on a project page. `/bearings` is the fleet view.
