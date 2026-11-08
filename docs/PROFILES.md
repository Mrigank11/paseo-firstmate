# Profiles: Paseo owns them

Paseo's daemon (`daemon.agentProfiles`) is the source of truth for which provider, model, mode or thinking level a lane runs. Edit a profile in Paseo (or with `paseo daemon config set`) and new dispatches follow at once. `config/paseo-profiles.json` is a seed for a fresh daemon and a git-tracked snapshot of the daemon's `fm-*` profiles. The lanes in `state/decisions.md` say only `profile:<name>`.

| Profile | Lane | Seed value |
| --- | --- | --- |
| `fm-planning` | planning | `claude/claude-opus-5-5` · `bypassPermissions` · thinking `medium` |
| `fm-contributor` | contributor (default) | `claude/claude-sonnet-5-5` · `bypassPermissions` · thinking `medium` |
| `fm-fallback` | fallback | same as contributor; the known-good relaunch target if `fm-contributor` cannot start |

## Switch a provider

1. Edit the profile in Paseo. Look valid mode, thinking and feature values up with `inspect_provider`; they differ per provider.
2. `bin/page profiles --check` now says the repo file is stale and names the fields. `bin/page profiles --pull` copies the daemon's `fm-*` profiles into `config/paseo-profiles.json` (it only reads the daemon). Review with `git diff` and commit.

Running agents are never touched, and the first mate's own session does not switch.

## Check

`bin/page profiles --check` (also the last line of `bin/page status`, and `/bearings` when not in sync) reads the daemon and compares it with the repo file and the lanes in `decisions.md`. A difference in a profile reads `STALE`: the repo file is behind, the daemon is right, and the fix printed is `--pull`. A profile missing from the daemon, or a lane pointing at an unknown profile or written as a raw spec, reads `DRIFT`. Exit 0 in sync, 1 drift, 2 cannot read. It never writes.

## Seed a daemon

`bin/page profiles --live --apply --yes` adds the repo profiles the daemon lacks (profiles made by hand are kept). It refuses to change a profile the daemon already has: that would drop a Paseo edit. Add `--overwrite` only when the repo file is the right one. Every live write saves `state/backup/agent-profiles-<ts>.json` and a copy of the whole config first, reads back, and prints the undo command.

## Roll back

`bin/page profiles --live --restore state/backup/agent-profiles-<ts>.json --yes`. Lanes: copy the dated `decisions.md` backup back.

## Safety

Plain `bin/page profiles [--apply]` needs an explicit `PASEO_HOME` and refuses the live home; only `--live --apply --yes` writes live. `--pull` writes only the repo file. Use `bin/isolated page profiles` for rehearsals.

## Back to the cheap OpenCode model

Edit `fm-contributor` in Paseo: provider `opencode`, model `opencode-go/muse-spark-1.3-contributor`, `modeId` `build`, `featureValues` `{ "auto_accept": true }`, no `thinkingOptionId` (needs OpenCode >= 2.0.10), then `--pull`.
