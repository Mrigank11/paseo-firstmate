---
name: secondmates
description: Use when a large, separable sub-domain of work warrants its own subordinate first mate with its own crew and fleet.
---

# Secondmates

A secondmate is a subordinate first mate: another Claude session running this exact same paseo-firstmate contract, commanding its own crew and reporting up to you. Chain of command: captain -> first mate -> secondmate -> that secondmate's crew.

## When to appoint (and when not to)

Appoint a secondmate when a whole sub-domain of work — a full repo, programme, or initiative — would otherwise flood your own `state/fleet.json` and context budget with dozens of leaf tasks.

Do not appoint for a handful of tasks — that is just crew. One level of nesting is the norm; deeper nesting needs a real reason written down.

A planning-lane scout is **not** a secondmate: it plans once and exits, and never spawns its own crew. Ongoing sub-fleets are appointed secondmates only — a planning agent never self-orchestrates.

## Appointing

Spawn with `mcp__paseo__create_agent` a Claude session (a reasoning model, e.g. `claude/claude-opus-5` or `claude/claude-sonnet-5`) in its own paseo-firstmate workspace — a checkout whose own `state/` dir keeps its fleet isolated from yours — with title, provider, and initialPrompt, leaving `notifyOnFinish` true.

The initialPrompt must (a) establish it as a secondmate reporting to you, not to the captain directly, (b) hand it a scoped mandate with explicit boundaries (scope, repos, what it may and may not decide), and (c) tell it to send you digests, not raw per-event chatter.

## Registering

Record every secondmate in `state/secondmates.md`: id, mandate, workspaceId, agentId, date appointed. This is your roster; keep it current on appoint, re-scope, and wind-down.

## Supervising

Treat the secondmate like a crew member: rely on `notifyOnFinish`, check `mcp__paseo__get_agent_activity` when it goes quiet, and steer with `mcp__paseo__send_agent_prompt` (`{ agentId, prompt }`) for new directives or answers to its escalations.

Talk ONLY to the secondmate, never to its crew. You do not micromanage its fleet. It escalates to you what it cannot decide; you escalate to the captain what you cannot. Digests roll UP the chain, compacting at each level.

## Chain of authority

A secondmate inherits your permission policy and merge posture from `state/decisions.md` UNLESS you narrow them in its mandate; it may never widen them.

Merge authority and captain escalations still bottom out with the human captain. A secondmate never invents policy — unclear cases escalate up.

## Winding down

When the mandate is complete, collect the secondmate's final digest, archive it and its workspace, and update `state/secondmates.md` to mark it wound down with date and outcome.

## Caution

Nesting multiplies cost and latency and blurs accountability if overused; prefer flat crew until the work genuinely warrants a sub-fleet.
