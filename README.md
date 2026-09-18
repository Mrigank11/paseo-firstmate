# paseo-firstmate

A firstmate-style orchestrator agent, rebuilt natively on Paseo.

[firstmate](https://github.com/kunchenguid/firstmate) turns one coding-agent CLI into a "first mate" that spawns and supervises a crew of other agents in tmux panes and git worktrees — ~110 bash scripts plus an 83KB prompt, most of it there only because the underlying agents are dumb processes in a pane. Paseo already provides spawn, message, status, permission, and worktree isolation as first-class API. So this is not a port: it keeps firstmate's *judgment* (the captain/crew contract, the "orchestrator never edits projects" invariant, scout vs ship task shapes, small-always-loaded-prompt discipline) and throws away all of its mechanism, driving everything through `mcp__paseo__*` instead.

## What it is

A launch bundle, not a service — a Claude session (`claude/opus`) that holds the Paseo MCP tools plus:

- `CLAUDE.md` — the captain contract, loaded every turn. Small on purpose.
- `.claude/skills/*` — triggered skills that carry the detail (routing, briefs, permissions, recovery, scout reports).
- `state/` — disk-backed fleet state so restarts and context compaction are non-events.

It runs identically whether you open it as a Claude Code project or spawn it as a Paseo agent — a Paseo agent *is* a Claude session with the Paseo MCP wired in.

## How it works

You (the **captain**) talk to it. It writes a **brief**, routes the task to a provider, spawns a **crew** member as an isolated Paseo subagent, then ends its turn. Paseo wakes it when a crew member finishes, errors, or needs permission — it never polls. It updates `state/fleet.json` and reports back to you.

See `CLAUDE.md` for the contract and `docs/STATE.md` for the state format.

## Status

All three phases are built.

- **Phase 1** — spawn + supervise crew, scout/ship shapes, permission auto-handling. Skills: `dispatch-routing`, `writing-briefs`, `permission-policy`, `stuck-crew-recovery`, `scout-report`.
- **Phase 2** — PR/merge authority under a two-source rule (captain's word or a standing green-only posture), delivery modes (`direct-PR` / `local-only` / `gated`), worktree teardown. Skill: `ship-delivery`.
- **Phase 3** — `/bearings` fleet digest, `/afk`+`/ahoy` batched away-mode, and subordinate "secondmate" sub-fleets. Skills: `session-digest`, `afk-mode`, `secondmates`.

Validated end-to-end: a real `claude-sonnet-5` Paseo agent, cold-started from `CLAUDE.md`, correctly delegates a scout to a crew member and drives the fleet through `mcp__paseo__*` — no MCP wiring needed beyond running it as a Paseo agent.
