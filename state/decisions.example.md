# Captain decisions (template)

Copy to `decisions.md` (gitignored) and edit. The first mate reads this on every dispatch and permission call.

## Routing overrides

- (e.g. "always use claude/opus for anything touching the sales-infra repo")

## Permission policy

Default posture: auto-approve safe classes, escalate the rest.

- **Auto-approve:** read-only tools; writes confined to the crew member's own worktree; installing declared dependencies.
- **Escalate to captain:** anything outside the worktree; network calls to new hosts; deleting files; force-push; any destructive or irreversible action.

## Preferences

- (e.g. "digest me hourly when I'm AFK, not per-event")
