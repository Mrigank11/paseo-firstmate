---
name: afk-mode
description: Use when the captain says /afk to enter batched-digest mode, or /ahoy or /resume to exit it.
---

# AFK Mode (Phase 3)

AFK mode batches first-mate-to-captain messages into periodic digests so an away captain is not pinged per event. The work continues silently; only the notification timing changes.

## Entering AFK

The captain enters with `/afk`, optionally with a cadence (default every 30 min, e.g. cron `*/30 * * * *`). On entry, append to `state/decisions.md`: `afk: true`, the chosen digest cadence, and the start time.

Then create one heartbeat with `mcp__paseo__create_heartbeat` (`{ prompt, cron, timezone?, name?, maxRuns?, expiresIn? }`) at that cadence whose prompt instructs the first mate to emit the batched AFK digest (section below) and then reset the running log. There is no heartbeat-update tool; to change cadence later, delete and recreate with `mcp__paseo__delete_heartbeat` followed by `mcp__paseo__create_heartbeat`.

## While AFK — work silently, log don't ping

Do NOT message the captain per event while `afk: true`. Keep doing the normal first-mate loop silently: harvest crew finishes, handle crew permission prompts under the permission-policy skill, run stuck-crew-recovery, and dispatch queued tasks.

Accumulate everything the captain would otherwise have heard into a running log — either a dedicated section in `state/decisions.md` or `state/afk-log.md` — not into captain messages. Log landings, dispatches, failures, and needs-captain items with just enough context to write the next digest.

## The ONE exception — immediate escalation

Break silence mid-AFK only when something BOTH blocks all further progress AND only the captain can resolve (e.g. every in-flight task is now blocked on a decision only they can make, or a destructive action is the only way forward).

A single blocked task while others still proceed does NOT qualify — log it in the running log and keep working. When in doubt, log it; the next digest will carry it.

## The digest (fires on each heartbeat)

On each heartbeat tick, send the captain one compact message summarizing only what changed since the last digest, grouped as: landed/merged, dispatched, needs-captain (each with the explicit ask), failed. Then clear the running log so the next window starts empty.

Keep it scannable — short bullets with file or task refs — never a transcript of crew chatter. If nothing happened since the last digest, say so in one line and skip the sections.

## Exiting AFK

The captain exits with `/ahoy` or `/resume`. On exit: set `afk: false` in `state/decisions.md`, stop the heartbeat with `mcp__paseo__delete_heartbeat`, deliver one final catch-up digest in the same format as above, and resume normal per-event messaging.

## Permissions do not widen in AFK

AFK changes WHEN the captain hears about escalations, never WHAT you approve. Apply the permission-policy skill exactly as normal: approve only what it authorizes, and escalate the rest — into the running log, or immediately if it meets the exception above.
