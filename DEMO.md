# Task tree demo (isolated)

Everything here runs on a separate Paseo daemon (home `.isolated/fm-task-tree-build/paseo-home`, port 6783), its own Lavish (4413) and its own state. The live `~/.paseo`, live plugin and Lavish 4387 are untouched.

- **Project page:** http://manjaro.tail2e75.ts.net:4413/session/cab3b6fcd6d25ca2
- Paseo web UI for the demo daemon: http://manjaro.tail2e75.ts.net:6783/
- Agents (3, all claude-sonnet-5-5): a stand-in first mate (claims the page), a second mate for Iter 05, one crew on PR 4.

## What to click

1. **Groups section (top).** "Iter 05 · Lite onboarding" is a group card: rolled-up stage (Needs you), "2 of 7 done", progress bar, one chip per child (orange = needs you, blue = running), the second mate's agent link, and a nested "E2E harness" group.
2. **Needs you stays flat.** Below Groups: PR 4 and Memory design (an ask with option buttons) sit in one Needs you list, each with a breadcrumb (`Demo app › Iter 05`). The group does not count them again in the tab count.
3. **Navigator (left rail).** A "Groups" section shows the tree with done/total, nested; the stage sections follow. Click any title to jump.
4. **Zoom into group.** Press it on the Iter 05 card: only Iter 05's cards stay; "Show all tasks" undoes it.
5. **Comments route to the nearest owner.** Comments on `PR 2` and on the group card went to the second mate (see its Paseo timeline: "Page comments"); a page-level comment went to the stand-in first mate.
6. **Wake routing.** The PR 4 crew's `DONE:` woke the second mate, not the first mate (`state/gate-log.jsonl` in the demo state, note = second mate's id), and the enforcer's `## With you` reminder went to it too.

7. **Fold.** The chevron beside a group in the tree, or Fold/Unfold on its card, hides its children (tree) or its bar, chips and tables (card). The group keeps its counts and an orange "N need you" marker; the asks stay in Needs you. Reload: the fold holds.

## Commands (demo state only)

```
export ISO_BASE=/home/mrigank/projects/llm-exp/paseo-firstmate/.isolated/fm-task-tree-build ISO_PORT=6783 ISO_LAVISH_PORT=4413 ISO_MARKS_PORT=4414 ISO_CANVAS_PORT=6792
unset PASEO_AGENT_ID PASEO_WORKSPACE_ID PASEO_AGENT_CWD
bin/isolated fleet tree demo-app          # the tree
bin/isolated fleet rollup iter-05         # roll-up, counts, each child's stage
bin/isolated fleet stages --table
bin/isolated down                         # stop when done
```

Screenshots: `docs/task-tree-demo/`.
