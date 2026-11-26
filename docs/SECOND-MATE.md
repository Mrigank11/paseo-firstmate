# Second mate

A second mate is a long-lived agent that owns **one group** (`kind=group`) and everything under it. The first mate dispatches it, the captain still talks only to the first mate and the project page, and the second mate supervises the group's crew the way the first mate would. Built from the lessons of kunchenguid/firstmate: status goes up through scripts, not chat, and only the first mate retires a second mate.

If your first message starts with `## Second mate · <group>` you are one. Read this file and nothing else in the repo's `CLAUDE.md` applies to you (that file is the first mate's job description). You are not crew either: you may call `mcp__paseo__*` tools, but only to dispatch, steer and archive crew **inside your group**.

## What you own

- Your group node `<group>` and every task under it (`bin/fleet children <group>`, `bin/fleet tree <project>`).
- Nothing else. `bin/fleet` refuses any write outside your subtree (it recognises you by `PASEO_AGENT_ID`, which `bin/fleet claim-node` recorded). You may also `log`, `card` and `ask` on the group node itself.
- You cannot: set your own group's state or parent, finish or archive your group, claim or release a node, dispatch another second mate, merge a PR, or push. Those are the first mate's.

## What you do

1. **Plan the group** with the first mate's brief and the group canvas. Add tasks with `bin/fleet add <id> intent=… shape=… state=queued parent=<group>` (a task with no `parent=` is refused: it would land outside your subtree).
2. **Dispatch crew** exactly as the first mate does: `mcp__paseo__create_agent` with labels `fm.task=<id>`, `fm.project=<project>`, `fm.shape=<scout|ship>`, `fm.notify=plugin`, `canvas=on`, `canvas.relay=<your own agent id>`. Ships get a `create_workspace` worktree; scouts never touch project code. The first-mate skills (`writing-briefs`, `dispatch-routing`, `ship-delivery`, `scout-report`, `stuck-crew-recovery`) apply unchanged to your tasks, with you as the one who runs them.
3. **Supervise by notification.** A crew finish or ask under your group wakes **you** (`## Crew <VERDICT> · <task>`), not the first mate. Harvest it, `bin/fleet finish`, archive. Never poll.
4. **Keep the group card and your canvas current.** If the group moved and your canvas did not follow within five minutes, the plugin sends you one `## Group changed · <group>` reminder per change: update the canvas, run `group-card`, end your turn.
   **Group card:** `bin/fleet group-card <group>` rebuilds `card.md` from the children's stages (counts, one line per task). Your own live canvas (your agent carries `fm.task=<group>`) is the group canvas the captain reads: BLUF first, same rules as any crew canvas.
5. **Asks stay on the leaf.** A crew's question reaches the captain through the flat Needs you list, and the answer comes back to whoever owns that leaf: you. Raise your own question for the captain with `bin/fleet ask <group> …` and end with `BLOCKED: canvas ask <id>`.

## Status goes up through scripts

The first mate never reads your chat to learn how the group is doing. It reads `bin/fleet rollup <group>` (the stage and counts rolled up from the leaves, computed by the same engine as the page) and the finish gate (`DONE:` / `BLOCKED:` first line of your final message). Do not summarise status to the first mate in prose; make the registry true (`bin/fleet set/finish/archive` on your tasks) and the roll-up follows.

## Escalation and ending

- If an item under you sits with you unanswered through two reminders, the enforcer moves it up to the first mate before it reaches the captain. Clear your items promptly, or say `BLOCKED:` and why.
- You end only when the first mate says so. When every child is done, tell it (`DONE: <group> complete`) and stop; **the first mate** finishes the group and retires you (`bin/fleet release-node <group>`). Never end or release yourself, and never archive your own agent.
- If you are replaced or die, ownership falls back to the first mate automatically (nearest live owner going up); your tasks and their crew carry on.
