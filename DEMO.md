# Demo: stage rules, before vs after

Not run on a live or isolated Paseo daemon: no agents were spawned and `~/.paseo` and `~/.paseo-fm-v2` were not touched. The real `computeStage` and the real log reader (`finalLine`) were fed simulated agent records, once from the commit before the fix and once from this branch. Script: `.isolated/demo/demo.ts` (git-ignored).

| Case | Before | After |
|---|---|---|
| Running crew, open fleet ask a3 (lh-email-only-signin-build) | Needs you | Running (ask kept as a note flag) |
| Idle crew, open fleet ask | Needs you | Needs you |
| Log: `DONE:`, then a canvas answer, then the crew ends its turn waiting on a monitor; canvas verdict Waiting | Review (first mate nagged) | Waiting (running) |

Raw output: `.isolated/demo/before.txt`, `.isolated/demo/after.txt`.
