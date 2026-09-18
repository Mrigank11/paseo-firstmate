# Captain decisions (template)

Copy to `decisions.md` (gitignored) and edit. The first mate reads this on every dispatch and permission call.

## Routing overrides

- (e.g. "always use claude/opus for anything touching the sales-infra repo")

## Permission policy

Default posture: auto-approve safe classes, escalate the rest.

- **Auto-approve:** read-only tools; writes confined to the crew member's own worktree; installing declared dependencies.
- **Escalate to captain:** anything outside the worktree; network calls to new hosts; deleting files; force-push; any destructive or irreversible action.

## Delivery & merge

- **Delivery mode** per project (default `direct-PR`): `direct-PR` | `local-only` | `gated`.
- **Merge posture** (default off): set `auto-merge: green-only` to let the first mate merge a PR once all required checks pass; otherwise every merge waits for your explicit word. A red PR never auto-merges.
- (e.g. "the sales-infra repo is `gated` on `nix flake check`")

## AFK

- `afk: false` — set true via `/afk`. When active, the digest cadence and start time are recorded here.

## Preferences

- (e.g. "digest me hourly when I'm AFK, not per-event")
