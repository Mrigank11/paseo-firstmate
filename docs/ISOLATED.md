# Isolated firstmate-v2 environment

`bin/isolated` runs a throwaway copy of the whole setup (own Paseo daemon, plugins, state, Lavish) so firstmate-v2 work can be built, tested and demoed without touching the live daemon (`~/.paseo`, 6767) or the main checkout's `state/`.

| What | Value (override with `ISO_*` env) |
|---|---|
| Paseo home | `~/.paseo-fm-v2` |
| State root (`FIRSTMATE_ROOT`) | `~/.paseo-fm-v2-root` (state in `…/state`) |
| Daemon + web UI | `http://manjaro.tail2e75.ts.net:6782/` (tailnet `100.101.33.17:6782`) |
| agent-canvas | port 6791, installed from `/home/mrigank/projects/paseo-plugins/agent-canvas` |
| Lavish / read-marks | 4411 / 4412 (set in the plugin settings, so the live 4387 / 4398 are not shared) |
| Plugin | `firstmate-deck` from the checkout you run `bin/isolated` in |

## Use

```
bin/isolated up         # start + install + seed (idempotent; from another worktree it re-points the plugin there)
bin/isolated status     # URLs, plugins, agents
bin/isolated down       # stop the daemon, keep everything
bin/isolated reset      # wipe home + state, up again
bin/isolated paseo ...  # paseo CLI with --home added;  bin/isolated fleet|page ...  # bin/fleet|bin/page on the isolated state
```

`up` seeds a `demo-app` project page with three sample tasks (done scout, queued ship, scout with an ask) and a stand-in first-mate agent that claims the page. Dispatch demo crew with `bin/isolated paseo run --no-wait --provider claude --model claude-sonnet-5-5 --label fm.task=… --label fm.project=… --label fm.shape=… …` (the MCP `create_agent` tool talks to the live daemon, so use the CLI here) and record it with `bin/isolated fleet add …`.

## Rules

- Every `paseo` call carries `--home` (the script does it); never run bare `bin/page` / `bin/fleet` against this state without `bin/isolated`.
- The script refuses `~/.paseo`, `~/.paseo-canvas-demo`, ports 6767/6790 and the main checkout as state root.
- Memory is tight: keep demo agents tiny, no Chrome, `down` when done.
- `bin/fleet` takes its file from `FLEET_FILE` (not `FIRSTMATE_ROOT`); `bin/isolated` sets both.
- Plugin `npm test` needs the dev dependencies (`bin/page install --dev`); `bin/page install` installs runtime dependencies only.
