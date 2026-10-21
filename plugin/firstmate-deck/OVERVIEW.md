First mate deck gives each project run by a paseo-firstmate first mate a live project page in Lavish. The page shows that project's tasks, what needs the captain, what is running, and the project's notes. Comments the captain makes on the page reach the first mate within about a second, and its replies come back in the page's conversation panel.

## How it works

The plugin reads the first mate's state (`state/fleet.json`, its archive, and `state/projects/<project>/`) and renders each project's page whenever that state changes or a crew agent's status changes. It owns the page's Lavish comment poll, saves each comment to `state/projects/<project>/inbox.jsonl`, and delivers it to the first mate with `paseo send`, steering it into the current turn when the first mate is busy. The plugin never writes the task list; the first mate stays its only writer, through `bin/fleet` and `bin/page`.

In the Paseo app it adds a "Needs you" sidebar row with a count of open questions, a Project page workspace panel, and a card in the first mate's chat for each batch of page comments.

## Setup

- Requires Paseo 0.12, plugins enabled on the daemon, and the `lavish-axi` CLI (run through npx).
- Set `firstmateRoot` to the absolute path of the paseo-firstmate checkout, in the plugin's host settings (`<paseo home>/plugin-settings/firstmate-deck/deck.json`, as `{"version":1,"values":{"firstmateRoot":"..."}}`) or in the daemon's `FIRSTMATE_ROOT` environment variable.
- Label the first mate agent `firstmate=true`. Without a labelled agent, the plugin uses the agent whose working directory is the first-mate checkout and labels it, but an explicit label is safer when other agents share that directory.
- `lavishPort` and `lavishStateDir` default to Lavish's own defaults. Change them only if the first mate runs Lavish on another port or state directory.

## Limits

- If the plugin process is killed outright, Paseo does not restart it. `bin/page heal` reloads it, and the first mate's heartbeat should run that.
- Paseo's phone layout cannot open plugin workspace panels. The sidebar row and its screen work on phones.
- The chat card for page comments appears only after the plugin has seen at least one Paseo event since it started. Comment delivery does not depend on this.
