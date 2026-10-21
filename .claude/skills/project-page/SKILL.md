---
name: project-page
description: Use when the captain wants a live page for a project, when a "## Page comments · <project>" message arrives, or when a task that belongs to a project page changes state.
---

# Project page

A project page is a Lavish HTML page per project: Needs you, Running, Next up, Parked and Done, plus hand-written sections (endpoints, flags, code changes, decisions, how it runs). The `firstmate-deck` Paseo plugin renders it from `state/fleet.json`, the archive and `state/projects/<project>/sections/`, owns its Lavish comment poll, and forwards comments to you. You never edit the page HTML and never poll it.

## Starting a page

`bin/page start <project> [--repo <path>] [--title "<title>"] [--page <path>]`

Run it from your own session. It first runs `bin/page claim`, which records you (`$PASEO_AGENT_ID`) in `state/firstmate.json` as THE first mate of this checkout: the plugin delivers page comments to that agent and to nobody else. Then it scaffolds `state/projects/<project>/`, renders the page, opens it in Lavish and checks that the plugin is polling the page. On success it prints JSON with the URL; give the captain the URL in one line. That's the last thing the page needs from chat.

If it exits 3 it prints why (plugin not installed or not running, plugin pointed at another checkout, Lavish listener problem) and prints no URL. Don't hand out the page: tell the captain what the message says. The one-time setup is `bin/page install` (it also needs plugins enabled in Paseo Settings → Plugins). If you are in a new session that replaced an older first mate, run `bin/page claim` once: it moves the claim to you.

If it exits 2, the captain ended this page's session. Don't reopen it; run `bin/page start <project> --reopen` only when the captain asks.

## Keeping it current: everything goes through scripts

| When | Run |
|---|---|
| Dispatching a task for the project | `bin/fleet add <id> ... project=<project> title="<short title>"` |
| Planned but not dispatched yet | `status=queued`, then `status=parked` when the captain shelves it |
| A task waits on another | `bin/fleet depend <id> <other-id>` |
| You need the captain's decision | `bin/fleet ask <id> "<BLUF question, ≤200 chars>" --context-file <md>` |
| A crew member finishes | write `state/tasks/<id>/card.md` (3–6 lines: what changed, where to look, what's untested), then the usual `bin/fleet set` |
| A crew member reports commits on a project branch | `bin/page note <project> code "<hash> <one line>"`, once per commit, from the crew member's report (`git log` on the branch in its worktree) |
| The captain decides something | `bin/page note <project> decisions "<decision>"` |
| An endpoint, flag or run step changes | edit `state/projects/<project>/sections/<name>.md` (endpoints, flags and how it runs are hand-written) |

The page re-renders on its own within seconds of any of these writes. Every task that belongs on a page carries `project=<project>`, including follow-up tasks you dispatch because of a comment: a task without it is invisible on the page.

**Every question for the captain about this project is an ask on the page, never a chat question.** That includes "merge these branches?" and "which format?" at the end of a task. If a task is already done or archived, raise the ask on the task anyway before archiving it. `bin/fleet archive` refuses tasks with open asks, so the task stays visible until the captain answers.

**Use `--options` whenever an ask has a fixed set of answers** (A/B/C, yes/no): `bin/fleet ask <id> "<question>" --options "A index card|B live console|C status board"` (2 to 6 options, each ≤60 chars; combine with `--context-file`; `reask` keeps or replaces them). The page shows them as buttons under the question and the captain answers with one click, no typing.

**Asks are BLUF.** The ask text is the question the captain answers, readable on its own: "Ship without onboarding_path, or block staging on it?" The reasoning, options and evidence go in the context file, which opens under an expander.

## Answering page comments

A message starting `## Page comments · <project>` lists one line per comment:

`- [t-pick-db · "Choose the database" · ask 1: "Postgres or SQLite?"] (c-abc123) "<text>"`

The bracket says where the comment was made, then the task title and its open ask text(s), so you rarely need a lookup. The parenthesis is the comment id.

- `t-<task>` is the task card (body, steps, trail).
- `t-<task>#a<n>` is ask `n` of that task: its text, its option buttons or its context expander.
- A section name (`endpoints`, `decisions`, ...) is that section of the page.
- `page` is the page itself (title, intro, anything outside a card or section).

Delivery is at least once, so the same comment can arrive twice. De-dup by comment id; if you already acted on `c-abc123`, don't act again.

1. Act on each comment: steer crew, answer an ask (`bin/fleet answer`), write a note, or dispatch.
   A line like `- [t-<task>#a<n> · ...] (c-...) picked option "<option>" for ask <n> (...)` (with `Apply with: bin/fleet answer <task> <n>`) is an `ask-choice` click: it IS the answer. Run `bin/fleet answer <task> <n>`, act on the choice, then reply. Don't ask the captain to confirm it.
2. Answer once per message, with `bin/page reply <project> "<reply>"` (or `-` to read Markdown from stdin). Say what you did, briefly, and give one line per comment when there are several. One reply marks EVERY delivered comment on the page answered, including any that were steered into your turn after you started composing it, so address them all or say which you are leaving.
3. A comment on an ask that asks for more information instead of answering ("show me options in detail") is not an answer. Keep the ask open, dispatch the work, and reply with `--followup <task>:<n>` (repeat the flag for several asks): `bin/page reply <project> "<reply>" --followup pick-db:1`. That marks the ask pending, so the page keeps it under "With the first mate". Without `--followup`, the ask goes back to Needs you as soon as you reply. The follow-up task must carry `project=<project>`. Once the follow-up is ready, run `bin/fleet reask <id> <n>` (optionally with sharper text: `bin/fleet reask <id> <n> "<new text>"`) so it returns to Needs you; `reask` and `answer` clear the pending mark.
4. Chat stays quiet. Don't repeat the reply in chat.

A comment on an ask moves it to "With the first mate" the moment the captain sends it, with no action from you. Comments on a card's steps or body only show in the card's comment trail; they do not move an ask.

The captain's Lavish panel shows "Working" until your reply, so always reply, even if the reply is "noted, nothing to change".

## When something's wrong

- `bin/page status` shows, per page: the Lavish session, the plugin's listener state, the banner on the page, when it last rendered, which checkout the plugin is configured for, undelivered comments and the plugin's health. A plugin root marked `NOT this checkout` means comments from this page go nowhere: run `bin/page install`.
- The page shows a red banner when comments can't reach you. "No first mate claimed this checkout" means run `bin/page claim`. Any other banner: run `bin/page status`, then tell the captain in chat if the plugin is down.
- If the captain's page shows "This page stopped updating", the plugin has stopped rendering: run `bin/page heal`.
- `bin/page heal` reloads the plugin when it has failed, or is running but has not rendered an open page for two minutes. It needs no judgment, so put it in your heartbeat: whenever the heartbeat wakes you, run `bin/page heal` along with the `bin/fleet active` scan (see `docs/STATE.md`).
- The captain ended the page with Send & End: `bin/page start` refuses (exit 2). Run it with `--reopen` only when the captain asks.

## Never

- Run `lavish-axi poll` or `lavish-axi share` on a project page. The plugin owns the poll, and pages hold local creds.
- Hand-edit the page HTML, `inbox.jsonl` or `page.json`.
- Put a cross-project or fleet view on a project page. `/bearings` is the fleet view.
