---
name: task-tree
description: Use when a body of work (an iteration, a harness, a migration) has several related tasks and the captain wants one status for it, or when a long effort should get its own second mate.
---

# Task tree

You are the first mate. Group related tasks under a **group** and, for a long effort, hand the group to a **second mate**. Read `docs/STATE.md` (Task tree) and `docs/SECOND-MATE.md` first time.

## 1. Make a group

1. `bin/fleet add <group> intent="…" shape=scout state=active project=<p> kind=group title="…"`
2. Hang tasks under it: `bin/fleet add <id> … parent=<group>` for new ones, `bin/fleet set <id> parent=<group>` for existing ones (propose the list to the captain before moving more than a few; `bin/fleet set <id> parent=` undoes it).
3. `bin/fleet group-card <group>` writes the group's card from its children. The page shows a group card with counts and chips, breadcrumbs on the children, and Needs you stays one flat list.
4. A group is done when every child is: `bin/fleet finish <group>` refuses until then; archive the children first, then the group.

## When you make a group yourself

- The captain names a body of work ("iter 05", "the E2E harness"): make the group, then propose which existing flat tasks move under it (match by name prefix, e.g. `lh-iter05-*`) and move them only after a yes. One `bin/fleet set <id> parent=<group>` per task; `parent=` with nothing undoes it.
- A task you are running produces two or more follow-up tasks: make a group for them at that moment (`kind=group`), put the follow-ups under it, and leave the original task where it is unless the captain asks.
- A lone task never gets a group. A group gets a second mate only when the captain says so.

## 2. Hand a group to a second mate (only for a weeks-long effort)

Only groups the captain names get one. Each is an always-on agent that every child finish wakes.

1. `mcp__paseo__create_agent` (claude-sonnet-5-5, thinking medium) with labels `fm.task=<group>`, `fm.project=<p>`, `fm.shape=scout`, `fm.notify=plugin`, `canvas=on`, `canvas.relay=<your own agent id>`, and a first message that starts `## Second mate · <group>` followed by the group's intent and scope. It reads `docs/SECOND-MATE.md`.
2. `bin/fleet claim-node <group> <its agent id>`. From now on wakes, comments and reminders for tasks under the group go to it first, and `bin/fleet` refuses its writes outside the group.
3. Read its status with `bin/fleet rollup <group>` and `bin/fleet stage <group>`, never from its chat. If it dies, ownership falls back to you with no action; `bin/fleet claim-node <group> <new> --replace` hands the group to a replacement.
4. When every child is done: `bin/fleet finish <group>`, then `bin/fleet release-node <group>` and archive the second mate's agent. **Only you retire a second mate.**

## Rules

- Depth: project > group > group > task at most.
- Asks stay on their leaf. Do not copy them onto the group.
- Do not give a group a crew of its own except a second mate.
