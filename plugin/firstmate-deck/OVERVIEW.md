First mate deck gives each project run by a paseo-firstmate first mate a live project page in Lavish. The page shows that project's tasks, what needs the captain, what is running, and the project's notes. Comments the captain makes on the page reach the first mate within about a second, and its replies come back in the page's conversation panel.

## How it works

The plugin reads the first mate's state (`state/fleet.json`, its archive, and `state/projects/<project>/`) and renders each project's page whenever that state changes or a crew agent's status changes. It owns the page's Lavish comment poll, saves each comment to `state/projects/<project>/inbox.jsonl`, and delivers it to the first mate with `paseo send`, steering it into the current turn when the first mate is busy. The plugin never writes the task list; the first mate stays its only writer, through `bin/fleet` and `bin/page`.

In the Paseo app it adds a "Needs you" sidebar row with a count of open questions, a Project page workspace panel, and a card in the first mate's chat for each batch of page comments.

## Setup

Run `bin/page install` in the paseo-firstmate checkout: it checks Node 22.18+, `jq` and `paseo`, runs `npm install` here, writes `<paseo home>/plugin-settings/firstmate-deck/deck.json` with this checkout as `firstmateRoot`, and installs (or reloads) the plugin. Plugins must be enabled on the daemon (Paseo Settings → Plugins). It also needs the `lavish-axi` CLI, which the plugin finds on the daemon's PATH, in the npx cache, or through `LAVISH_AXI_BIN`.

- `firstmateRoot` can also come from the daemon's `FIRSTMATE_ROOT` environment variable. `~` and symlinks are resolved; a root with no `state/` is reported in the app and the log instead of idling silently.
- Which agent is the first mate is an explicit fact, never a guess: the first mate runs `bin/page claim` in its own session (`bin/page start` does it too), which writes `state/firstmate.json`. The plugin delivers to that agent if it still exists; otherwise to the newest live agent labelled `firstmate=true` that fleet.json does not list as crew; otherwise it queues the comments and the page banner says "No first mate claimed this checkout".
- `lavishPort` and `lavishStateDir` default to Lavish's own defaults. The plugin writes the values it actually uses (and its `firstmateRoot`) into each project's `page.json`, and `bin/page` uses those, so the two always talk to the same Lavish.
- Each poll runs through `server/poll-wrapper.mjs`, which kills the poll when the plugin dies, so a crashed plugin cannot leave an orphan holding the Lavish listener.

## Limits

- If the plugin process is killed outright, Paseo does not restart it. `bin/page heal` reloads it, and the first mate's heartbeat runs that. Meanwhile the page itself shows "This page stopped updating" once its data is more than 60 s old by the browser's clock (so the captain's browser and the daemon host should agree on the time to within a few seconds).
- Paseo's phone layout cannot open plugin workspace panels. The sidebar row and its screen work on phones.
- The chat card for page comments appears only after the plugin has seen at least one Paseo event since it started. Comment delivery does not depend on this.
