---
name: project-page
description: Use when the captain wants a live page for a project, when a "## Page comments · <project>" message arrives, or when a task that belongs to a project page changes state.
---

# Project page

A project page is a Lavish HTML page per project: Needs you, Running, Next up, Parked and Done, plus hand-written sections (endpoints, flags, code changes, decisions, how it runs). The `firstmate-deck` Paseo plugin renders it from `state/fleet.json`, the archive and `state/projects/<project>/sections/`, owns its Lavish comment poll, and forwards comments to you. You never edit the page HTML and never poll it.

## Starting a page

`bin/page start <project> [--repo <path>] [--title "<title>"] [--page <path>]`

Run it from your own session. If nobody live holds the claim it first runs `bin/page claim`, which records you (`$PASEO_AGENT_ID`) in `state/firstmate.json` as THE first mate of this checkout: the plugin delivers page comments to that agent and to nobody else. If another live agent already holds the claim, `start` warns, naming it, and leaves the claim alone; only an explicit `bin/page claim` takes it over. Crew agents (anyone `fleet.json` or its archive lists as a task's agent) can never claim: crew do not run `bin/page` at all. Then it scaffolds `state/projects/<project>/`, renders the page, opens it in Lavish and checks that the plugin is polling the page. On success it prints JSON with the URL; give the captain the URL in one line. That's the last thing the page needs from chat.

If it exits 3 it prints why (plugin not installed or not running, plugin pointed at another checkout, Lavish listener problem) and prints no URL. Don't hand out the page: tell the captain what the message says. The one-time setup is `bin/page install` (it also needs plugins enabled in Paseo Settings → Plugins). If you are in a new session that replaced an older first mate, run `bin/page claim` once: it moves the claim to you.

If it exits 2, the captain ended this page's session. Don't reopen it; run `bin/page start <project> --reopen` only when the captain asks.

## Keeping it current: everything goes through scripts

| When | Run |
|---|---|
| Dispatching a task for the project | `bin/fleet add <id> ... project=<project> title="<short title>"`. A task added with `depends_on=a,b` and no `project=` inherits the project of its first dependency that has one (and `bin/fleet depend` does the same for a task that has none), but say `project=` explicitly anyway |
| Planned but not dispatched yet | `status=queued`, then `status=parked` when the captain shelves it |
| A task waits on another | `bin/fleet depend <id> <other-id>` |
| You need the captain's decision | `bin/fleet ask <id> "<BLUF question, ≤200 chars>" --context-file <md>` |
| A crew member finishes | `bin/fleet finish <id> [--branch <b>] [--card -]` (`--failed` for a failure). It sets the status, writes `tasks/<id>/card.md` (from the card you pipe in with `--card -`: 3–6 lines of what changed, where to look, what's untested; with no card it makes one from the task's notes plus branch/PR), and for a project task appends the branch's commits (`git log --oneline <base>..<branch>`, `--base` defaults to `main`) to the project's code section, dated and without repeating commits. It needs `repo` in the project's `project.json` (`bin/page start --repo`). Write a card yourself only when you have more to say than the notes |
| The captain decides something | `bin/page note <project> decisions "<decision>"` |
| An endpoint, flag or run step changes | edit `state/projects/<project>/sections/<name>.md` (endpoints, flags and how it runs are hand-written) |

The page re-renders on its own within seconds of any of these writes. Every task that belongs on a page carries `project=<project>`, including follow-up tasks you dispatch because of a comment: a task without it is invisible on the page.

**Every question for the captain about this project is an ask on the page, never a chat question.** That includes "merge these branches?" and "which format?" at the end of a task. If a task is already done or archived, raise the ask on the task anyway before archiving it. `bin/fleet archive` refuses tasks with open asks, so the task stays visible until the captain answers.

**Use `--options` whenever an ask has a fixed set of answers** (A/B/C, yes/no): `bin/fleet ask <id> "<question>" --options "A index card|B live console|C status board"` (2 to 6 options, each ≤60 chars; combine with `--context-file`; `reask` keeps or replaces them). The page shows them as buttons under the question and the captain answers with one click, no typing.

**Asks are BLUF.** The ask text is the question the captain answers, readable on its own: "Ship without onboarding_path, or block staging on it?" The reasoning, options and evidence go in the context file, which opens under an expander.

## Answering page comments

A message starting `## Page comments · <project>` lists one line per comment:

`- [t-pick-db · "Choose the database" · ask a1: "Postgres or SQLite?"] (c-abc123) "<text>"`

The bracket says where the comment was made, then the task title and its open ask text(s), so you rarely need a lookup. The parenthesis is the comment id.

- `t-<task>` is the task card (body, steps, trail).
- `t-<task>#<askId>` (e.g. `t-pick-db#a2`) is that ask of the task: its text, its option buttons or its context expander.
- A section name (`endpoints`, `decisions`, ...) is that section of the page.
- `page` is the page itself (title, intro, anything outside a card or section).

`<askId>` is the ask's stable id from `bin/fleet` (`a1`, `a2`, ...): it never changes and is never reused for that task, so answering one ask does not move the others. Always address an ask by its id (`bin/fleet answer <task> a2`), never by position.

Delivery is at least once, so the same comment can arrive twice. De-dup by comment id; if you already acted on `c-abc123`, don't act again.

1. Act on each comment: steer crew, answer an ask (`bin/fleet answer <task> <askId>`), write a note, or dispatch.
   A line like `- [t-<task>#<askId> · ...] (c-...) picked option "<option>" for ask <askId> (...)` is an `ask-choice` click: it IS the answer. Act on the choice, then reply. **You do not run `bin/fleet answer` for it**: `bin/page reply` applies every delivered pick for you (see 2). Don't ask the captain to confirm it.
   A line saying `option click on an ask that is no longer open, ignored` is a stale click (the ask was already answered, or the option is not one it offers). It changes nothing and `reply` will not apply it; mention it in your reply only if it matters.
2. Answer once per message, with `bin/page reply <project> "<reply>"` (or `-` to read Markdown from stdin). Say what you did, briefly, and give one line per comment when there are several. The reply first runs `bin/fleet answer` for each delivered option pick (once per ask), unless you name that ask in `--keep-open <task>#<askId>` (repeatable) to keep it open, then marks the delivered comments that were there when the reply started as answered. Comments that arrive while it is going out stay unanswered for your next reply.
3. A comment on an ask that asks for more information instead of answering ("show me options in detail") is not an answer. Keep the ask open, dispatch the work, and reply with `--followup <task>:<askId>` (repeat the flag for several asks): `bin/page reply <project> "<reply>" --followup pick-db:a1`. That marks the ask pending, so the page keeps it under "With the first mate". Without `--followup`, the ask goes back to Needs you as soon as you reply. A pick on the same ask is not applied while it is named in `--followup` or `--keep-open`. The follow-up task must carry `project=<project>`. Once the follow-up is ready, run `bin/fleet reask <id> <askId>` (optionally with sharper text: `bin/fleet reask <id> <askId> "<new text>"`) so it returns to Needs you; `reask` and `answer` clear the pending mark.
4. Chat stays quiet. Don't repeat the reply in chat.

A comment on an ask moves it to "With the first mate" the moment the captain sends it, with no action from you. Comments on a card's steps or body only show in the card's comment trail; they do not move an ask.

The captain's Lavish panel shows "Working" until your reply, so always reply, even if the reply is "noted, nothing to change".

## When something's wrong

- `bin/page status` shows, per page: the Lavish session, the plugin's listener state, the banner on the page, when it last rendered, which checkout the plugin is configured for, undelivered comments and the plugin's health. A plugin root marked `NOT this checkout` means comments from this page go nowhere: run `bin/page install`.
- The page shows a red banner when comments can't reach you. "No first mate claimed this checkout" means run `bin/page claim`. Any other banner: run `bin/page status`, then tell the captain in chat if the plugin is down.
- If the captain's page shows "This page stopped updating", the plugin has stopped rendering: run `bin/page heal`.
- If the page shows "Task state could not be read (fleet.json): showing the last good view" (and `bin/page status` shows a state file problem), `fleet.json` is empty or malformed. That is a file problem, not a plugin problem: fix the file (never by hand-editing around `bin/fleet`; restore it), and the page recovers by itself. `bin/page heal` will not reload the plugin for it. `bin/page status` also warns about live tasks with no `project`, which no page shows: set it with `bin/fleet set <id> project=<project>`.
- `bin/page heal` reloads the plugin when it has failed, or is running but has not rendered an open page for two minutes (and not because of a state file problem). It needs no judgment, so put it in your heartbeat: whenever the heartbeat wakes you, run `bin/page heal` along with the `bin/fleet active` scan (see `docs/STATE.md`).
- The captain ended the page with Send & End: `bin/page start` refuses (exit 2). Run it with `--reopen` only when the captain asks.

## Never

- Run `lavish-axi poll` or `lavish-axi share` on a project page. The plugin owns the poll, and pages hold local creds.
- Hand-edit the page HTML, `inbox.jsonl` or `page.json`.
- Let a crew member run `bin/page` (it is refused as a first mate anyway), or point an ask at a position instead of its id.
- Put a cross-project or fleet view on a project page. `/bearings` is the fleet view.
