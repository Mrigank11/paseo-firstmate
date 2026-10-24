# Captain decisions (template)

Copy to `decisions.md` (gitignored) and edit. The first mate reads this on every dispatch and permission call.

## Routing

Named lanes map a task's role to an exact launch config. The first mate infers each task's role, looks up its lane here, and materializes it into `create_agent`. A per-task captain override beats a lane; the default lane catches everything else so nothing is unrouted.

**Lanes** — each lane is a Paseo agent profile (source: `config/paseo-profiles.json`; install with `bin/page profiles --apply`, which needs an explicit `PASEO_HOME`):

- `planning`    — `profile:fm-planning` (`claude-work/claude-opus-5-5` · `bypassPermissions` · thinking `medium`)
- `contributor` — `profile:fm-contributor` (`opencode/opencode-go/muse-spark-1.3-contributor` · `build` · `{ auto_accept: true }`)
- fallback      — `profile:fm-fallback` (`claude-work/claude-sonnet-5-5` · `bypassPermissions` · thinking `medium`), used for a `contributor` task when `fm-contributor` cannot start (e.g. the OpenCode install is too old for the model)

The first mate reads the profile with `list_profiles` and copies its fields into `create_agent`. A lane value may also be a raw `provider/model · mode · features` spec.

**Lane assignment** (role → lane):

- first mate itself → `planning`
- judgment work (architecture, ambiguous debugging, design, final review, a scout whose value is a judgment call) → `planning`
- everything else (most scouts, well-specified ships, fan-out, scraping, bulk edits) → `contributor`  ← **default**

**Per-task overrides** — e.g. "use the planning lane for this scout", or "always use planning for anything touching the sales-infra repo".

## Notifications

- `notify: plugin` — **off by default** (delete or change the line to turn it off). When on, new crew are launched with `fm.notify=plugin` + `notifyOnFinish: false` and the deck plugin wakes the first mate with `## Crew <VERDICT> · <task>`. Leave it off until `state/gate-log.jsonl` (shadow mode) agrees with the Paseo notifications over several finishes.

## Permission policy

The deck plugin's permission hook classifies crew permission requests against the block below (read/search anywhere; writes only in the crew's own worktree or its `state/tasks/<id>/`; the shell allowlist; no fetch hosts). Everything else is escalated: the first mate is woken with `## Crew PERMISSION · <task>` and the request stays pending for the captain. The hook never denies.

- `mode: shadow` only logs to `state/permission-log.jsonl` (`would-allow` / `escalate`). Flip to `enforce` once the log agrees with what you would have clicked; `shadow` is the rollback.
- If this block is missing or does not parse, every request escalates and every project page shows a banner.

```json fm-permission-rules
{
  "mode": "shadow",
  "allowKinds": ["tool"],
  "read": true,
  "writeWithin": ["$WORKTREE", "$ROOT/state/tasks/$TASK"],
  "shell": {
    "allow": [
      "^git (status|log|diff|show)( |$)",
      "^(ls|cat|head|tail|wc|rg|grep) ",
      "^(npm|pnpm) (test|run [\\w:-]+|ci|install)$",
      "^node --test ",
      "^npx tsc --noEmit$"
    ],
    "denyChars": ";&|><`$()"
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
