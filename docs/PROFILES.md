# Profiles: one place to switch provider

`config/paseo-profiles.json` is the only file that says which provider, model, mode or thinking level a lane runs. The lanes in `state/decisions.md` say only `profile:<name>`. The daemon (`daemon.agentProfiles`) holds a copy that `bin/page profiles` keeps in step.

| Profile | Lane | Today |
| --- | --- | --- |
| `fm-planning` | planning | `claude/claude-opus-5-5` · `bypassPermissions` · thinking `medium` |
| `fm-contributor` | contributor (default) | `claude/claude-sonnet-5-5` · `bypassPermissions` · thinking `medium` |
| `fm-fallback` | fallback | same as contributor today; the known-good relaunch target if `fm-contributor` cannot start |

## Switch a provider

1. Edit the profile in `config/paseo-profiles.json` (look valid mode, thinking and feature values up with `inspect_provider`; they differ per provider).
2. Dry run against the live daemon: `bin/page profiles --live`.
3. On the captain's word: `bin/page profiles --live --apply --yes`. It saves `state/backup/agent-profiles-<ts>.json` and a copy of the whole config, merges by id (profiles made by hand are kept), reloads, reads back, and prints the undo command.
4. `bin/page profiles --check` should say `in sync`.

New dispatches follow at once. Running agents are never touched, and the first mate's own session does not switch.

## Check for drift

`bin/page profiles --check` (also the last line of `bin/page status`, and `/bearings` when not in sync) compares the repo file with the daemon and the lanes in `decisions.md`. Exit 0 in sync, 1 drift (it names the profile and field), 2 cannot read. It never writes.

## Roll back

`bin/page profiles --live --restore state/backup/agent-profiles-<ts>.json --yes`. Lanes: copy the dated `decisions.md` backup back.

## Safety

Plain `bin/page profiles [--apply]` needs an explicit `PASEO_HOME` and refuses the live home; only `--live --apply --yes` writes live. Use `bin/isolated page profiles` for rehearsals.

## Back to the cheap OpenCode model

Edit `fm-contributor`: provider `opencode`, model `opencode-go/muse-spark-1.3-contributor`, `modeId` `build`, `featureValues` `{ "auto_accept": true }`, drop `thinkingOptionId` (needs OpenCode >= 2.0.10), then apply and check.
