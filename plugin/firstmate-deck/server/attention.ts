// What the tab of a project page tells the captain. Pure, no I/O.
//   needsYou  = the "Needs you" group (the same number as the Paseo sidebar row): a state, it stays until answered.
//   keys      = one short hash per task ("t-<id>") plus one for the page itself ("page"): it changes when something
//               the captain would want to look at changes, and not on step churn, canvas progress or the refresh stamp.
// The page compares `keys` with the keys the captain last saw (ui-state.json `s`) to show the `*` and the "new" dots.
import { createHash } from "node:crypto";
import { cardHash } from "./marks.ts";
import type { ProjectModel, Task, TrailComment } from "./state.ts";
import type { Stage } from "./stage.ts";
import type { CanvasData } from "./canvas-port.ts";

export type Attention = { needsYou: number; keys: Record<string, string> };

const short = (parts: unknown[]) => createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 8);

/** First-mate replies on a card or its asks: a `bin/page reply` answer is news. */
const repliesOn = (comments: readonly TrailComment[], target: string) =>
  comments.filter((c) => c.answered && (c.target === target || c.target.startsWith(`${target}#`))).length;

export function taskKey(t: Task, stage: Stage | undefined, comments: readonly TrailComment[], canvas?: CanvasData): string {
  const agent = stage?.agentId ?? "";
  const canvasAsks = ((canvas?.summaries[agent]?.openAsks ?? []).map((a) => a.id)).sort();
  const asks = t.asks.filter((a) => !a.repliedAt).map((a) => a.id).sort();
  return short([stage?.group ?? t.state, !!stage?.failed, asks, canvasAsks, cardHash(t.card), repliesOn(comments, `t-${t.id}`)]);
}

/** `tasks` = the live tasks and the archived ones the page shows. `stages` has one entry per task id. */
export function attentionOf(model: ProjectModel, tasks: readonly Task[], stages: ReadonlyMap<string, Stage>, canvas?: CanvasData): Attention {
  const keys: Record<string, string> = {};
  for (const t of tasks) keys[`t-${t.id}`] = taskKey(t, stages.get(t.id), model.comments, canvas);
  keys.page = short([repliesOn(model.comments, "page"), model.sections.map((s) => [s.name, createHash("sha1").update(s.content).digest("hex").slice(0, 8)]), model.comments.filter((c) => c.answered && model.sections.some((s) => s.name === c.target)).length]);
  const needsYou = model.tasks.filter((t) => stages.get(t.id)?.group === "you").length;
  return { needsYou, keys };
}
