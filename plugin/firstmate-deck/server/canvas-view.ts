// Canvas facts the stage engine and the card read, derived from agent-canvas summaries. Pure, no I/O.
import type { CanvasInput } from "./stage.ts";
import type { FmSummary } from "./canvas-port.ts";
import type { TrailComment } from "./state.ts";

/** The canvas ask ids the page can offer buttons for: they ride in an element id and a comment target (`c-<id>`). */
export const SAFE_ASK = /^[A-Za-z0-9_]+$/;

/**
 * The captain's click on a canvas ask that is still waiting for the first mate (comment on `t-<task>#c-<id>`, a pick, neither
 * stale nor answered). The canvas itself only learns of a pick when the first mate delivers it, so the page tracks it here.
 */
export function clickedPick(task: string, askId: string, comments: readonly TrailComment[]): string | undefined {
  let hit: TrailComment | undefined;
  for (const c of comments) {
    if (c.target !== `t-${task}#c-${askId}` || !c.choice || c.stale || c.answered) continue;
    if (!hit || c.at >= hit.at) hit = c;
  }
  return hit?.choice?.option;
}

/** What the stage engine reads from one agent's canvas summary (undefined when the canvas was not read). */
export function canvasInput(s: FmSummary | undefined, task: string, comments: readonly TrailComment[]): CanvasInput | undefined {
  if (!s) return undefined;
  return {
    verdict: s.verdict.label,
    asks: s.openAsks.map((a) => ({ id: a.id, pending: !!a.pending || clickedPick(task, a.id, comments) !== undefined })),
  };
}
