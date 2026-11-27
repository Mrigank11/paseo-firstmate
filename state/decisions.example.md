# Captain decisions (template)

Copy to `decisions.md` (gitignored) and edit. The first mate reads this on every dispatch and permission call.

## Routing

Named lanes map a task's role to an exact launch config. The first mate infers each task's role, looks up its lane here, and materializes it into `create_agent`. A per-task captain override beats a lane; the default lane catches everything else so nothing is unrouted.

**Lanes** — each lane is a Paseo agent profile. The profile file `config/paseo-profiles.json` is the only place a provider, model, mode or thinking level is written; lanes name the profile and nothing else. Check with `bin/page profiles --check`; sync the daemon with `bin/page profiles --live --apply --yes` on the captain's word (`docs/PROFILES.md`).

- `planning`    — `profile:fm-planning`
- `contributor` — `profile:fm-contributor`  (the default)
- `fallback`    — `profile:fm-fallback`, used for a `contributor` task when `fm-contributor` cannot start

The first mate reads the profile with `list_profiles` and copies its fields into `create_agent`. The deck plugin refuses a crew launch that matches no `fm-*` profile, so a model override needs its own `fm-<name>` profile in Paseo (`docs/PROFILES.md`, "Launch check"); add the line `profile-check: off` to switch that check off.

**Lane assignment** (role → lane):

- first mate itself → `planning`
- judgment work (architecture, ambiguous debugging, design, final review, a scout whose value is a judgment call) → `planning`
- everything else (most scouts, well-specified ships, fan-out, scraping, bulk edits) → `contributor`  ← **default**

**Per-task overrides** — e.g. "use the planning lane for this scout", or "always use planning for anything touching the sales-infra repo".

## Notifications

- The crew-finish wake is **on by default**: new crew are launched with `fm.notify=plugin` + `notifyOnFinish: false` and the deck plugin wakes the first mate (the project's claimed owner, not Paseo's parent label) with `## Crew <VERDICT> · <task>` on a real `DONE:`/`BLOCKED:`. To turn it off (the gate goes back to shadow mode, logging only), add the line `notify: off`; crew launched without the label keep Paseo's own notification either way.

## Permission policy

The deck plugin's permission hook classifies crew permission requests against the block below (read/search anywhere; writes only in the crew's own worktree or its `state/tasks/<id>/`; the shell allowlist; no fetch hosts). Everything else is escalated: the first mate is woken with `## Crew PERMISSION · <task>` and the request stays pending for the captain. The hook never denies.

- `mode: shadow` only logs to `state/permission-log.jsonl` (`would-allow` / `escalate`). Flip to `enforce` once the log agrees with what you would have clicked; `shadow` is the rollback.
- If this block is missing or does not parse, every request escalates and every project page shows a banner.
- Shell commands are normalised before matching: split into `&& || ; |` parts (**every** part must be allowed), leading `NAME=value` assignments stripped (names matching `envDeny` escalate), then the `wrappers` regexes stripped from the head (`rtk ls`, `timeout 5 ls`, `env -i ls` are matched as `ls`; a new wrapper is one more line here). Redirections to files must land inside `writeWithin`. Anything the reader cannot parse with certainty (`$(…)`, backticks, `$VAR`, subshells, here-docs, background `&`, comments, newlines) escalates. A wrapper never makes a command safe: `rtk sh -c …` is `sh -c …`, which is not on the allowlist.

```json fm-permission-rules
{
  "mode": "shadow",
  "allowKinds": ["tool"],
  "read": true,
  "writeWithin": ["$WORKTREE", "$ROOT/state/tasks/$TASK"],
  "shell": {
    "allow": [
        "^git (status|log|diff|show)( |$)",
        "^(ls|cat|head|tail|wc|rg|grep)( |$)",
        "^(npm|pnpm) (test|run [\\w:-]+|ci|install)$",
        "^node --test ",
        "^npx tsc --noEmit$"
      ],
    "wrappers": [
        "^rtk ",
        "^time ",
        "^command ",
        "^nohup ",
        "^nice( -n -?\\d+)? ",
        "^timeout( -[-\\w=]+)* \\d+[smhd]? ",
        "^env( -i)? "
      ],
    "envDeny": "^(PATH|LD_\\w*|DYLD_\\w*|NODE_\\w*|GIT_\\w*|BASH_ENV|ENV|IFS|SHELL|PAGER|EDITOR|VISUAL|PYTHON\\w*|RUBY\\w*|PERL\\w*|HOME)$"
  },
  "fetchHosts": []
}
```

- **Always escalate to the captain** (not expressible as a rule): deleting files, force-push, any destructive or irreversible action.

## Delivery & merge

- **Delivery mode** per project (default `direct-PR`): `direct-PR` | `local-only` | `gated`.
- **Merge posture** (default off): set `auto-merge: green-only` to let the first mate merge a PR once all required checks pass; otherwise every merge waits for your explicit word. A red PR never auto-merges.
- (e.g. "the sales-infra repo is `gated` on `nix flake check`")

## Preferences

- (e.g. "always scout before shipping in the payments repo")
