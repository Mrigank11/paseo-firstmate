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

## Launch check

The deck plugin enforces the profiles on every crew launch, in the daemon, whatever harness the launcher runs on (`plugin/firstmate-deck/server/profile-check.ts`). Paseo records no profile id on an agent, so a launch "uses" a profile when its settings equal the profile's.

| Rule | Behaviour |
| --- | --- |
| Checked | first session of an agent with `fm.task` or `paseo.parent-agent-id`; a `firstmate=true` agent without `fm.task` and agents with neither label are exempt |
| Match | any daemon profile whose id starts `fm-`: provider, model, thinking level, mode (when the profile sets one) and every option it declares. A profile must name a model: `create_agent` cannot launch one without |
| Daemon with no `fm-*` profiles | provider, model and thinking level against this checkout's `config/paseo-profiles.json` |
| Ships | refused when `fm-planning` is the only profile that matches |
| Refusal | the create call fails with `Launch refused: …` naming the settings to use; no agent is made; one line in `state/profile-log.jsonl` |
| Cannot tell | profiles unreadable or a fault in the check: the launch goes through, logged `unchecked` |
| Off switch | `profile-check: off` in `state/decisions.md` |

The daemon waits on the deck plugin for every session open, resumes included: if the plugin process hangs, Paseo's hook timeout fails the open. Reloading the plugin also makes Paseo reopen each idle agent's session before its next message, which ends background work running in that session.

Not covered: settings changed on a running agent, agents re-used for a new task, imported sessions, daemons that do not run the plugin, and whether `fm-contributor` really failed before an `fm-fallback` launch.

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
