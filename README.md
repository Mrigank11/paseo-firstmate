# ⚓ paseo-firstmate

> **Inspired by [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate).**
> This project keeps firstmate's *judgment* — the captain/crew contract, the "orchestrator never edits projects" invariant, scout-vs-ship task shapes, and the small-always-loaded-prompt discipline — and re-implements it natively on [Paseo](https://paseo.dev), where spawn, message, status, permission, and worktree isolation are first-class API instead of ~110 bash scripts plus an 83&nbsp;KB prompt driving tmux panes. It is not a port and not affiliated with the firstmate project; if you don't run Paseo, you almost certainly want the original.

**Talk to one agent. Ship with a crew.** You (the **captain**) talk to a single **first mate**. It writes a **brief** per task, dispatches **crew** members as isolated Paseo agents, supervises them to completion, and hands you finished PRs or investigation reports. It never does project work itself.

## How it works

```
            you (the captain)
                  │  chat: requests, decisions, "merge it"
                  ▼
 ┌─────────────────────────────────────┐
 │ first mate           (this repo)    │
 │ reads state/ + briefs, routes lanes │
 │ dispatches crew, supervises, tears  │
 │ down worktrees, reports back        │
 └──┬──────────────┬───────────────┬───┘
    ▼              ▼               ▼
 ┌────────┐   ┌────────┐      ┌────────┐
 │ scout  │   │ ship   │  ... │second- │
 │ report │   │ PR     │      │ mate   │  isolated Paseo agents
 └────────┘   └────────┘      └────────┘  (own worktree each for ships)
```

The loop is four moves — **dispatch, supervise, steer, report** — and after every move the first mate writes `state/fleet.json` and goes idle. Paseo wakes it when a crew member finishes, errors, or needs permission; it never polls. See [`CLAUDE.md`](CLAUDE.md) for the full contract.

## Two task shapes

- **`scout`** — investigation, research, audit, planning. Read-only on project code; delivers `state/tasks/<id>/report.md` and nothing else. Default when the ask is a question. When in doubt, scout — it can't damage a repo.
- **`ship`** — a code change. Gets its own `create_workspace` worktree, produces a branch/PR; the first mate confirms the PR, merges it under authority, and tears the worktree down. Default when the ask is a change.

Expensive agents plan, cheap agents implement: hard planning goes to a plan-only scout in the `planning` lane (which never edits code and never spawns crew); implementation is always a contributor-lane `ship` briefed from that plan.

## Quickstart

**Requirements:** a Paseo-capable Claude session (open this repo as a Claude Code project, or spawn it as a Paseo agent — a Paseo agent *is* a Claude session with the Paseo MCP wired in), plus the GitHub CLI (`gh auth login`) for PR/merge operations.

```bash
git clone <this-repo>
cd paseo-firstmate
cp state/decisions.example.md state/decisions.md   # gitignored runtime policy — edit to taste
# open the repo as a Claude Code project, or spawn it as a Paseo agent, then:
# > ahoy! scout the auth flow in my xyz repo, then ship a fix for the flaky login test
```

1. Copy `state/decisions.example.md` → `state/decisions.md` and set your **routing lanes** (`planning` vs `contributor`), permission posture, and merge authority.
2. Talk to the first mate. It writes `state/tasks/<id>/brief.md`, spawns the crew member, records it in `state/fleet.json`, and ends its turn.
3. Paseo wakes it on finish/error/permission — it harvests scout reports, confirms ship PRs, merges only under authority (your explicit word, or a standing `auto-merge: green-only` posture — red PRs never auto-merge), and tears down worktrees.

Try `/bearings` anytime for a one-screen fleet digest, `/afk` before stepping away for batched digests, `/ahoy` when you're back.

## Repo map

| Path | What it is |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | The captain contract — loaded every turn, small on purpose. Start here. |
| [`.claude/skills/`](.claude/skills/) | Triggered skills carrying the detail: `dispatch-routing`, `writing-briefs`, `permission-policy`, `stuck-crew-recovery`, `scout-report`, `ship-delivery`, `session-digest`, `afk-mode`, `secondmates`. Loaded on demand, never preloaded. |
| [`.claude/commands/`](.claude/commands/) | Slash commands: `/bearings`, `/afk`, `/ahoy`. |
| [`docs/STATE.md`](docs/STATE.md) | Fleet state format — `fleet.json`, task dirs, restart reconstruction, heartbeat safety net. |
| [`state/`](state/) | Disk-backed runtime state (gitignored — not source): `fleet.json`, `decisions.md`, `tasks/<id>/brief.md` + `report.md`. The `.example` files are the templates; your live copies stay local. |

## Configuration at a glance

Everything the captain can tune lives in `state/decisions.md` (from the example template): routing lanes mapping task roles to exact launch configs, the permission auto-approve/escalate boundary, per-project delivery modes (`direct-PR` / `local-only` / `gated`), the `auto-merge: green-only` posture, AFK cadence, and free-form preferences. The first mate re-reads it on every dispatch and permission wake — edits take effect immediately.

## Status

All three phases are built: (1) spawn + supervise crew, scout/ship shapes, permission auto-handling; (2) PR/merge authority under the two-source rule with delivery modes and worktree teardown; (3) `/bearings` digest, `/afk` + `/ahoy` away-mode, and subordinate secondmate sub-fleets. Validated end-to-end: a real Paseo agent cold-started from `CLAUDE.md` correctly delegates a scout and drives the fleet. Expect rough edges — this is an early open-source snapshot, and issues/PRs describing what broke (with your `fleet.json` task entry and brief) are the most useful contributions.

## License

No `LICENSE` file is committed yet — all rights reserved by default until the maintainer picks one.
