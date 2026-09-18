# Captain decisions (template)

Copy to `decisions.md` (gitignored) and edit. The first mate reads this on every dispatch and permission call.

## Routing

Named lanes map a task's role to an exact launch config. The first mate infers each task's role, looks up its lane here, and materializes it into `create_agent`. A per-task captain override beats a lane; the default lane catches everything else so nothing is unrouted.

**Lanes** — `provider/model · mode · features`:

- `planning`    — `claude-work/claude-opus-4-8[1m]` · `bypassPermissions`
- `contributor` — `opencode/opencode-go/muse-spark-1.3-contributor` · `build` · `{ auto_accept: true }`

(A lane value may instead be `profile:<name>` to materialize a Paseo profile.)

**Lane assignment** (role → lane):

- first mate itself + secondmates → `planning`
- judgment work (architecture, ambiguous debugging, design, final review, a scout whose value is a judgment call) → `planning`
- everything else (most scouts, well-specified ships, fan-out, scraping, bulk edits) → `contributor`  ← **default**

**Per-task overrides** — e.g. "use the planning lane for this scout", or "always use planning for anything touching the sales-infra repo".

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
