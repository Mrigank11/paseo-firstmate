# Isolated firstmate-v2 environment

`bin/isolated` runs a throwaway copy of the whole setup (own Paseo daemon, plugins, state, Lavish) so firstmate-v2 work can be built, tested and demoed without touching the live daemon (`~/.paseo`, 6767) or the main checkout's `state/`.

| What | Value (override with `ISO_*` env) |
|---|---|
| Paseo home | `/home/mrigank/projects/llm-exp/paseo-firstmate/.isolated/paseo-home` (`ISO_HOME`; base `ISO_BASE`: `~` is tmpfs in sandboxed sessions, `~/projects` is on disk; `.isolated/` is git-ignored) |
| State root (`FIRSTMATE_ROOT`) | `…/paseo-isolated/fm-root` (state in `…/state`); demo agents work in `…/paseo-isolated/work` |
| Daemon + web UI | `http://manjaro.tail2e75.ts.net:6782/` (tailnet `100.101.33.17:6782`) |
| agent-canvas | port 6791, installed from `/home/mrigank/projects/paseo-plugins/agent-canvas` |
| Lavish / read-marks | 4411 / 4412 (set in the plugin settings, so the live 4387 / 4398 are not shared) |
| Canvas settings | `canvasUrl` (127.0.0.1:6791) and `canvasDir` (the agent-canvas checkout) are written into the deck settings, so `bin/page canvas-snippet` / `canvas-answer` / `canvas-snapshot` find the isolated agent-canvas (relay key: `<home>/agent-canvas/relay.key`) |
| Plugin | `firstmate-deck` from the checkout you run `bin/isolated` in |

## Use

```
bin/isolated up         # start + install + seed (idempotent; from another worktree it re-points the plugin there)
bin/isolated up --no-lavish   # the same without opening a Lavish session (page files only, no comment polling)
bin/isolated status     # URLs, plugins, agents
bin/isolated down       # stop the daemon, keep everything
bin/isolated reset      # wipe home + state, up again
bin/isolated paseo ...  # paseo CLI with --home added;  bin/isolated fleet|page ...  # bin/fleet|bin/page on the isolated state
```

`up` seeds a `demo-app` project page with three sample tasks (done scout, queued ship, scout with an ask) and a stand-in first-mate agent that claims the page. Dispatch demo crew with `bin/isolated paseo run --no-wait --provider claude --model claude-sonnet-5-5 --label fm.task=… --label fm.project=… --label fm.shape=… …` (the MCP `create_agent` tool talks to the live daemon, so use the CLI here) and record it with `bin/isolated fleet add …`.

## Remote crews without a Mac

`bin/isolated fake-mac up` starts a second throwaway daemon (`$ISO_BASE/fake-mac-home`, tailnet port 6783, no plugins) and registers it as host `mac` of the isolated daemon. `bin/isolated fake-mac paseo run … --label fm.task=<id>` starts a crew on it; `bin/isolated fake-mac down` makes the host go offline. Its crews run on this same machine, so their canvas writes take the local path: the keyed tailnet path is only covered by agent-canvas tests.

## Rules

- Every `paseo` call carries `--home` (the script does it); never run bare `bin/page` / `bin/fleet` against this state without `bin/isolated`.
- The script refuses `~/.paseo`, `~/.paseo-canvas-demo`, ports 6767/6790 and the main checkout as state root.
- Memory is tight: keep demo agents tiny, no Chrome, `down` when done.
- `bin/fleet` takes its file from `FLEET_FILE` (not `FIRSTMATE_ROOT`); `bin/isolated` sets both.
- Plugin `npm test` needs the dev dependencies (`bin/page install --dev`); `bin/page install` installs runtime dependencies only.
