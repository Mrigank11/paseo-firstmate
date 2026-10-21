First mate deck gives each project run by a paseo-firstmate first mate a live project page in Lavish. The page shows that project's tasks, what needs the captain, what is running, and the project's notes. Comments the captain makes on the page reach the first mate within about a second, and its replies come back in the page's conversation panel.

## How it works

The plugin reads the first mate's state (`state/fleet.json`, its archive, and `state/projects/<project>/`) and renders each project's page whenever that state changes or a crew agent's status changes. It owns the page's Lavish comment poll, saves each comment to `state/projects/<project>/inbox.jsonl`, and delivers it to the first mate through the Paseo SDK handle the plugin holds (steering it into the current turn when the first mate is busy). The `paseo` CLI is only a fallback for the cold start, before the first SDK handle exists. The plugin never writes the task list; the first mate stays its only writer, through `bin/fleet` and `bin/page`.

In the Paseo app it adds a "Needs you" sidebar row with a count of open questions, a Project page workspace panel, and a card in the first mate's chat for each batch of page comments.

## Setup

Run `bin/page install` in the paseo-firstmate checkout: it checks Node 22.18+, `jq` and `paseo`, installs the runtime dependencies here (`npm ci --omit=dev`, or `npm install --omit=dev` without a lockfile; `bin/page install --dev` adds the dev dependencies for typechecking), writes `<paseo home>/plugin-settings/firstmate-deck/deck.json` with this checkout as `firstmateRoot`, and installs (or reloads) the plugin. Plugins must be enabled on the daemon (Paseo Settings → Plugins). It also needs the `lavish-axi` CLI, which the plugin finds on the daemon's PATH, in the npx cache, or through `LAVISH_AXI_BIN`.

- `firstmateRoot` can also come from the daemon's `FIRSTMATE_ROOT` environment variable. `~` and symlinks are resolved; a root with no `state/` is reported in the app and the log instead of idling silently.
- Which agent is the first mate is an explicit fact, never a guess: the first mate runs `bin/page claim` in its own session (`bin/page start` does it too), which writes `state/firstmate.json`. The plugin delivers to that agent if it still exists; otherwise to the newest live agent labelled `firstmate=true` that fleet.json does not list as crew; otherwise it queues the comments and the page banner says "No first mate claimed this checkout".
- `lavishPort` and `lavishStateDir` default to Lavish's own defaults. The plugin writes the values it actually uses (and its `firstmateRoot`) into each project's `page.json`, and `bin/page` uses those, so the two always talk to the same Lavish.
- Each poll runs through a small wrapper whose source is embedded in the plugin and run with `node -e` (Paseo bundles the plugin, so there is no sibling file, and nothing is written to `/tmp`). It kills the poll when the plugin dies, so a crashed plugin cannot leave an orphan holding the Lavish listener. Its command line carries the marker argument `--firstmate-deck-poll-wrapper`, which is how a stale poll from an earlier run is recognised and cleaned up.
- A task's asks are addressed by their stable ids (`a1`, `a2`, ...) from `bin/fleet`: comment targets (`t-<task>#a2`), page element ids and option clicks all carry the id, so answering one ask never moves another. A click on an ask that is no longer open (or on an option it does not offer) is recorded as `stale`, relayed as "ignored", and never shown as a pick.
- If `fleet.json` is empty or malformed, the page keeps the last good view, shows "Task state could not be read (fleet.json): showing the last good view", and records `loadError` in `page.json`; `bin/page status` shows it and `bin/page heal` does not reload the plugin for it. A malformed line in `fleet-archive.jsonl` is skipped with a logged count.

## Limits

- If the plugin process is killed outright, Paseo does not restart it. `bin/page heal` reloads it, and the first mate's heartbeat runs that. Meanwhile the page itself shows "This page stopped updating" once the data it polls has not changed for 60 s. That is measured on the browser's own clock (each render carries a growing sequence number and the plugin re-renders at least every 20 s), so a phone whose clock disagrees with the daemon's neither raises a false alarm nor hides a real stall.
- Paseo's phone layout cannot open plugin workspace panels. The sidebar row and its screen work on phones.
- The chat card for page comments appears only after the plugin has seen at least one Paseo event since it started. Comment delivery does not depend on this.

## Read marks, ordering, stop

- The plugin serves a small CORS endpoint (`readMarksPort`, default 4398; `readMarksHost` is the tailnet fallback) for the page's "Done, unread" marks, stored in `state/projects/<p>/ui-state.json`. It never writes `fleet.json`.
- A task's optional `order` sorts it within its group; `provider` labels it when Paseo has no record of its agent; project.json `collapsedSections`, `sectionSubtitles` and `archiveLimit` shape long hand-written pages. `bin/page stop`/`start` pause and resume one page. See `docs/STATE.md`, "Read marks, ordering and long pages".
