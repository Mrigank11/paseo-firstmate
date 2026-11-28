# Page pipeline: build plan

Design: the `deck-page-firstprinciples` canvas (the page as an app: the deck owns the tasks, the page owns the view, per-task records, change-only updates). This plan builds its steps 4, 1, 2, 3 and 5, one commit each, in that order. Step 6 (trim Lavish's state file) is out of scope until the captain agrees to it.

**Goal:** an open LH page stops redrawing the whole list: an idle tab downloads nothing, a busy one moves under 0.5 MB a minute, an update takes under 50 ms, and plugin restarts do not reload the page.

**Architecture:** the live payload becomes clock-free (browser writes the words), the page file becomes a stable shell with no list, done and parked tasks load as one line with the body on open, and the list is split into an index plus content-named task files so only changed cards are fetched and swapped. Lavish keeps hosting the page (comments, picks and anchors need it).

**Stack:** TypeScript on Node (type stripping), the deck plugin under `plugin/firstmate-deck`, Idiomorph in the page, real Lavish 0.1.95, Playwright for the gate.

## Global constraints

- Never touch live state: no `bin/page install`, no plugin reload, no live Lavish (4387, `~/.lavish-axi`), no push, PR, merge. The gate runs on its own Lavish port and state dir under `.isolated/deck-page-firstprinciples-build/`.
- One Chrome at most, `XDG_CONFIG_HOME` under `.isolated`, `TMPDIR` on disk (never `/tmp`).
- Groups and the Done list render and sort as today, with no scroll reset; selection, folds and focus survive an update.
- Gate budgets: idle 5 min = 0 list downloads; 3 plugin restarts = 0 frame reloads; busy copy < 0.5 MB a minute per tab; update p95 < 50 ms; a comment on an old done card still shows with its body.

## Review focus

- A restart under an open tab must not leave an old list or blank sidebar on screen.
- A comment or read mark on a done card whose body is not loaded.
- A browser whose clock is minutes off: clocks use only its own clock, never the daemon's.
- A page whose first load lands mid-update (index and task files from two versions).
- Two tabs on one page (Lavish hands the page to the second).

## Tasks

### 4. The gate (`test/pagegate/serve.ts`, `test/pagegate/gate.ts`)

- Consumes: nothing. Produces: `node test/pagegate/gate.ts` (env `GATE_CHECKS`, `GATE_IDLE_S`, `GATE_BUSY_S`, `GATE_CPU`) printing PASS/FAIL per check and exiting 1 on a miss; `serve.ts` runs the same copy for people to click (URL in `url-<run>.txt`).
- Gate on today's code: all checks but the comment one fail (idle 2 downloads in 70 s, 93 MB a minute, update p95 1.8 s, 3 reloads).

### 1. Clocks in the browser (`server/render.ts`, `server/page-script.ts`, `server/runtime.ts`)

- `stampLive(live, now)` fills `{TS}` and `{STAMP}` after the content hash; a running agent carries `data-so=<start ms>`, a comment still sending carries `data-late=<ms>`; `clocks(root)` in the page writes "N min so far" and flips `st-late` on its own clock.
- The 20 s tick only bumps the version file (`heartbeat()`); a full re-render runs every `renderMs` (5 min) for clock-only stage changes.
- Tests: payload byte-identical two hours later (render.test), browser writes the elapsed text (flicker.test). Gate: idle 5 min = 0 list downloads.

### 2. Done and parked as one line, body on open

- A done or parked card renders its header row; its body arrives when opened or when a comment targets it. Gate: comment on an old done card still shows with its body; groups and sort unchanged.

### 3. The page file without the list

- The page file holds the shell only ("loading" in `#live`); a restart does not rewrite it when its signature is unchanged. Gate: 3 plugin restarts = 0 frame reloads.

### 5. Index plus content-named task files

- The deck writes an index (lanes, groups, order, sidebar) and one file per card named by content hash; the page fetches the index, then only files it lacks, and swaps only changed cards. Gate: busy copy < 0.5 MB a minute, update p95 < 50 ms; fallback to the full payload on any gap.

## After review (2026-11-27)

Step 5 (index plus content-named task files) is removed, and so is the step-1 heartbeat: the page has one update path (fetch the whole live payload, morph it, then one restore step), and the plugin renders every 20 s again so the stale warning means "rendering stopped". The gate now also checks correctness (`canvas`: nothing disappears in a canvas outage; `correct`: with focus view on and folds open, the page after live updates equals a fresh load). The `bytes` (0.5 MB a minute) and `update` (p95 under 50 ms) budgets are not met on this design: every change downloads the whole payload.
