---
name: project-page
description: Use when the captain wants a live page for a project, when a "## Page comments · <project>" message arrives, or when a task that belongs to a project page changes state.
---

# Project page

A project page is a Lavish HTML page per project: Needs you, Running, Blocked, Next up, Parked and Done, plus hand-written sections (endpoints, flags, code changes, decisions, how it runs). The `firstmate-deck` Paseo plugin renders it from `state/fleet.json`, the archive and `state/projects/<project>/sections/`, owns its Lavish comment poll, and forwards comments to you. You never edit the page HTML and never poll it.

## Starting a page

`bin/page start <project> [--repo <path>] [--title "<title>"] [--page <path>]`

Run it from your own session. A page has its own first mate: for a new page `start` records you (`$PASEO_AGENT_ID`) in `state/projects/<project>/claim.json`, and the plugin delivers that page's comments to that agent and to nobody else, so two first-mate sessions can each run their own page. A page with no claim of its own falls back to the checkout-wide claim (`state/firstmate.json`, set by plain `bin/page claim`, which also labels you `firstmate=true`), so a checkout from before per-page claims keeps working untouched. If another live agent already holds an existing page (its own claim, or the checkout-wide fallback), `start` warns, naming it, and leaves the claim alone; only an explicit `bin/page claim <project>` takes that page over, and it touches no other page and no label. Crew agents (anyone `fleet.json` or its archive lists as a task's agent) can never claim: crew do not run `bin/page` at all. Then it scaffolds `state/projects/<project>/`, renders the page, opens it in Lavish and checks that the plugin is polling the page. On success it prints JSON with the URL; give the captain the URL in one line. That's the last thing the page needs from chat.

If it exits 3 it prints why (plugin not installed or not running, plugin pointed at another checkout, Lavish listener problem) and prints no URL. Don't hand out the page: tell the captain what the message says. The one-time setup is `bin/page install` (it also needs plugins enabled in Paseo Settings → Plugins). If you are in a new session that replaced an older first mate, run `bin/page claim <project>` once per page you now run: it moves that page's claim to you.

If it exits 2, the captain ended this page's session. Don't reopen it; run `bin/page start <project> --reopen` only when the captain asks.

## Keeping it current: everything goes through scripts

| When | Run |
|---|---|
| Dispatching a task for the project | `bin/fleet add <id> ... project=<project> title="<short title>"`. A task added with `depends_on=a,b` and no `project=` inherits the project of its first dependency that has one (and `bin/fleet depend` does the same for a task that has none), but say `project=` explicitly anyway |
| Planned but not dispatched yet | `state=queued`, then `state=parked` when the captain shelves it; `state=active` once dispatched |
| A task waits on an outside dependency (not the captain, not crew) | `bin/fleet set <id> state=blocked blocked_on="<what/who>"`: it lands in the Blocked group with a "Blocked on:" line; `state=active` (or any other) clears it. `parked` stays for what the captain paused |
| A task waits on another | `bin/fleet depend <id> <other-id>` |
| You need the captain's decision | `bin/fleet ask <id> "<BLUF question, ≤200 chars>" --context-file <md>` |
| A crew member finishes | `bin/fleet finish <id> [--branch <b>] [--card -]` (`--failed` for a failure). It refuses while the task has open asks unless the same command answers them (`--close-asks`, or `--answer a1`), sets the state, records the task's agents, writes `tasks/<id>/card.md` (from the card you pipe in with `--card -`: 3–6 lines of what changed, where to look, what's untested; with no card it makes one from the task's intent plus branch/PR), and for a project task appends the branch's commits (`git log --oneline <base>..<branch>`, `--base` defaults to `main`) to the project's code section, dated and without repeating commits. It needs `repo` in the project's `project.json` (`bin/page start --repo`). Write a card yourself only when you have more to say than the intent |
| The captain decides something | `bin/page note <project> decisions "<decision>"` |
| An endpoint, flag or run step changes | edit `state/projects/<project>/sections/<name>.md` (endpoints, flags and how it runs are hand-written) |

The page re-renders on its own within seconds of any of these writes. Every task that belongs on a page carries `project=<project>`, including follow-up tasks you dispatch because of a comment: a task without it is invisible on the page.

**Every question for the captain about this project is an ask on the page, never a chat question.** That includes "merge these branches?" and "which format?" at the end of a task. If a task is already done or archived, raise the ask on the task anyway before archiving it. `bin/fleet archive` refuses tasks with open asks, so the task stays visible until the captain answers.

**Use `--options` whenever an ask has a fixed set of answers** (A/B/C, yes/no): `bin/fleet ask <id> "<question>" --options "A index card|B live console|C status board"` (2 to 6 options, each ≤60 chars; combine with `--context-file`; `reask` keeps or replaces them). The page shows them as buttons under the question and the captain answers with one click, no typing.

**Asks are BLUF.** The ask text is the question the captain answers, readable on its own: "Ship without onboarding_path, or block staging on it?" **One explanation per card.** The crew's canvas is the long explanation when the task has one, live or snapshotted; you add only the question, the buttons and at most a short note. On a task with a canvas, `--context-file` is that note: at most 1,200 characters, no required headings, shown open under "First mate adds" (`bin/fleet ask` / `reask` snapshot the crew's canvas first, so a Needs-you card still shows it after the crew is archived, and refuse a longer file). Use it for what the canvas does not say: a re-verification, a link, an answer to a comment. Never restate the crew's numbers or paste a report. If the canvas is wrong or incomplete, the live crew fixes it; a longer answer is a new crew. When the crew already asked the same question on its canvas, link it with `--ref` instead of asking twice. Only a task that never had a canvas gets the full Context: then the file has the crew-canvas structure (`bin/fleet ask-template` prints it: BLUF, Issue, Impact, Context and components, Changes by component, Fix plan, Ask as `##` headings; `ask`/`reask` refuse a file without those headings in that order, for an `issue` task) and it opens under an expander. An old full Context on a task with a canvas still renders, folded.

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
2. Answer once per message, with `bin/page reply <project> "<reply>" [--task <id>]...` (`--task` limits it to the comments on those tasks; without it the reply answers every delivered comment in the project, and says which tasks that was) (or `-` to read Markdown from stdin). Say what you did, briefly, and give one line per comment when there are several. The reply first runs `bin/fleet answer` for each delivered option pick (once per ask), unless you name that ask in `--keep-open <task>#<askId>` (repeatable) to keep it open, then marks the delivered comments that were there when the reply started as answered. Comments that arrive while it is going out stay unanswered for your next reply.
3. A comment on an ask that asks for more information instead of answering ("show me options in detail") is not an answer. Keep the ask open, dispatch the work, and reply with `--followup <task>:<askId>` (repeat the flag for several asks): `bin/page reply <project> "<reply>" --followup pick-db:a1`. That marks the ask pending, so the page keeps it under "With the first mate". Without `--followup`, the ask goes back to Needs you as soon as you reply. A pick on the same ask is not applied while it is named in `--followup` or `--keep-open`. The follow-up task must carry `project=<project>`. Once the follow-up is ready, run `bin/fleet reask <id> <askId>` (optionally with sharper text: `bin/fleet reask <id> <askId> "<new text>"`) so it returns to Needs you; `reask` and `answer` clear the pending mark.
4. Chat stays quiet. Don't repeat the reply in chat.

A comment on an ask moves it to "With the first mate" the moment the captain sends it, with no action from you. Comments on a card's steps or body only show in the card's comment trail; they do not move an ask.

The captain's Lavish panel shows "Working" until your reply, so always reply, even if the reply is "noted, nothing to change".

## Canvas questions from the crew

Every crew member has a live canvas (`dispatch-routing` §3, `writing-briefs`). It asks the captain by putting an `<Ask>` on that canvas and ending its turn with `BLOCKED: canvas ask <id>`, so a wake with that first line is a canvas question. The deck already shows the question raw on the task card ("uncurated · from the crew"), with buttons.

1. **Curate it** (optional but better): `bin/fleet ask <task> "<BLUF question>" --options "a|b" --ref '{"kind":"canvas","agentId":"<crew agent>","block":"<ask id>"}'`. The curated ask replaces the raw one on the card. The registry stores only the `ref`: text and options are read live from the canvas. When the canvas ask is answered, the card shows "resolved on canvas" and `bin/fleet stages` reports `ref-closed`: run `bin/fleet answer` then.
2. **A pick comes to you** two ways: as a page option click (`## Page comments · …`, target `t-<task>#c-<askId>` for a raw ask), or from the canvas itself in Paseo as `## Canvas answer · <task> · ask <id>: <value> (<label>)`. Either way the crew has been told nothing yet: the pick waits for you.
3. **Guardrail check** (your judgement, guided by `state/decisions.md` and the task's brief): is the pick inside the brief's scope, and read-only on external systems and not production? Then deliver it: `bin/page canvas-answer <task> <askId> <value>`. agent-canvas marks the Ask answered and sends the crew the answer. If it is not safe or in scope, refuse and ask the captain to confirm: `bin/page canvas-answer <task> <askId> --decline "<why>"` closes the Ask with your note and tells the crew why, and `bin/page reply` tells the captain what you need.
4. Close the curated ask, if there is one (`bin/fleet answer <task> <askId>`; `bin/page reply` does it for a page pick). A second pick on the same ask is harmless: agent-canvas reports "already pending".

`bin/page claim` re-points every open crew's `canvas.relay` to you. If a crew's relay agent is gone and nobody re-claimed, the card carries the `relay-target-gone` flag: run `bin/page claim <project>` from the first mate's own session.

## When something's wrong

- `bin/page status` shows, per page: the Lavish session, the plugin's listener state, the banner on the page, when it last rendered, which checkout the plugin is configured for, undelivered comments and the plugin's health. A plugin root marked `NOT this checkout` means comments from this page go nowhere: run `bin/page install`.
- The page shows a red banner when comments can't reach you. "No first mate claimed this checkout" means this page has no usable claim and no checkout-wide one: run `bin/page claim <project>`. `bin/page status` shows each page's claimant (`<agent> (checkout)` when it falls back). Any other banner: run `bin/page status`, then tell the captain in chat if the plugin is down.
- If the captain's page shows "This page stopped updating", the plugin has stopped rendering: run `bin/page heal`.
- If the page shows "Task state could not be read (fleet.json): showing the last good view" (and `bin/page status` shows a state file problem), `fleet.json` is empty or malformed. That is a file problem, not a plugin problem: fix the file (never by hand-editing around `bin/fleet`; restore it), and the page recovers by itself. `bin/page heal` will not reload the plugin for it. `bin/page status` also warns about live tasks with no `project`, which no page shows: set it with `bin/fleet set <id> project=<project>`.
- `bin/page heal` reloads the plugin when it has failed, or is running but has not rendered an open page for two minutes (and not because of a state file problem). It needs no judgment, so put it in your heartbeat: whenever the heartbeat wakes you, run `bin/page heal` along with the `bin/fleet active` scan (see `docs/STATE.md`).
- The captain ended the page with Send & End: `bin/page start` refuses (exit 2). Run it with `--reopen` only when the captain asks.

## Never

- Run `lavish-axi poll` or `lavish-axi share` on a project page. The plugin owns the poll, and pages hold local creds.
- Hand-edit the page HTML, `inbox.jsonl` or `page.json`.
- Let a crew member run `bin/page` (it is refused as a first mate anyway), or point an ask at a position instead of its id.
- Put a cross-project or fleet view on a project page. `/bearings` is the fleet view.

## Pausing a page

- `bin/page stop <project>` pauses a page (no poll, no render); `bin/page start <project>` resumes it. Done tasks with a `card.md` show under "Done, unread"; `bin/fleet card <id> --file <f>` writes a card.
