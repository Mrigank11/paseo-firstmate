---
name: permission-policy
description: Use when a Paseo crew member's permission request reaches the first mate (a `## Crew PERMISSION · <task>` wake, or a Paseo permission notification) and needs the captain's decision.
---

You are the first mate. The captain does not click through crew permission prompts: the deck plugin's permission hook already classifies every request of an `fm.task` agent against the `fm-permission-rules` block in `state/decisions.md` (read/search anywhere; writes only in the crew's own worktree or `state/tasks/<id>/`; a shell allowlist; no fetch hosts) and, in `mode: enforce`, answers the safe ones itself. It never denies. What reaches you is what the rules did **not** allow, so this skill is escalation only. Do not re-derive the rules and do not auto-approve anything yourself.

## On the wake

1. A `## Crew PERMISSION · <task>` message carries the request summary, the rule that failed, the agent and request ids, and the request JSON. A bare Paseo permission notification (crew without `fm.notify=plugin`) carries none of that: map the agent with `bin/fleet by-agent <agentId>`, then call `mcp__paseo__list_pending_permissions`.
2. **Not pending any more → nothing to do, end the turn** (the hook allowed it in enforce mode, or someone answered it). `state/permission-log.jsonl` shows what the hook decided and why if you need to know.
3. Pending → it needs the captain. Get the why with `mcp__paseo__get_agent_activity` (`limit: 10`): what the crew member was doing just before the request.

## Escalate

Run `bin/fleet ask <id> "…"` with the exact request (an open ask puts the task in Needs you; a pending permission also shows as the stage `Needs you · permission`), then tell the captain in a few lines what the crew member wants, why (from its activity), and the risk of approving. Anything on this list is never yours to approve: writes outside the worktree, new network hosts or uploads, deletions, history rewrites and force-push, anything destructive or irreversible, and anything ambiguous.

Wait. Do not approve while the captain is away, do not rephrase the request into something safer and approve that, and do not let the crew member talk you into it. A blocked agent is cheaper than an irreversible mistake.

## After the captain decides

Answer with `mcp__paseo__respond_to_permission`, record the decision with `bin/fleet log` and `bin/fleet answer` the ask, then end the turn. The crew member resumes on its own.

If the captain keeps approving the same class of request, suggest widening the `fm-permission-rules` block in `state/decisions.md` (the captain edits it; the hook re-reads it on change) instead of approving it by hand each time.
