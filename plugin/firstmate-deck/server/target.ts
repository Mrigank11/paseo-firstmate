// Where on the page a Lavish comment points: "t-<taskId>" for a task card, "t-<taskId>#<askId>" for an ask of a task
// (its block, option buttons or context expander; the ask id is bin/fleet's stable "a2"), a section id, or "page".

import { STAMP_ID } from "./anchors.ts";
import { CANVAS_ASK_BODY } from "./ask-id.ts";

const CANVAS_ASK_ID = new RegExp(`^c-${CANVAS_ASK_BODY}$`);

/** `agents`: crew agent id -> task id, for the ids the deck and the crew canvas put on a card's canvas embed (cvd-<agent>, cv-<agent>-…). */
export type Known = { tasks?: Iterable<string>; sections?: Iterable<string>; agents?: Record<string, string> };

export function extractTarget(selector: string | undefined, known: Known = {}): string {
  if (!selector) return "page";
  const tasks = known.tasks ? new Set(known.tasks) : null;
  const sections = known.sections ? new Set(known.sections) : null;
  const agents = known.agents;
  // [id=x] and [data-section=x] behave like #x; remember which were data-section.
  const dataSections = new Set<string>();
  let sel = selector.replace(/\\(.)/g, "$1");
  sel = sel.replace(/\[(id|data-section)\s*=\s*["']?([\w.-]+)["']?\]/g, (_m, kind, v) => {
    if (kind === "data-section") dataSections.add(v);
    return "#" + v;
  });
  sel = sel.replace(/"[^"]*"|'[^']*'/g, "");
  const parts = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const taskId = (id: string): string | null => {
    let m = /^t-(.+)$/.exec(id);
    if (m && (!tasks || tasks.has(m[1]))) return "t-" + m[1];
    m = /^s-(.+)$/.exec(id);
    if (m && (!tasks || tasks.has(m[1]))) return "t-" + m[1];
    // a-<task>-<askId>: the ask block; x-<task>-<askId>: its context expander (a bare number is an older page: ask "a<n>")
    // a question on the crew's canvas: a-<task>-c-<askId> (block), x- (context), o-<task>-c-<askId>-<n> (an option button).
    // Task and ask ids both hold hyphens, so try every "-c-" as the split, the longest task first, and keep the first one that is a known task.
    m = /^[ax]-(.+)$/.exec(id) ?? /^o-(.+)-[1-9][0-9]*$/.exec(id);
    if (m) {
      for (let i = m[1].lastIndexOf("-c-"); i > 0; i = m[1].lastIndexOf("-c-", i - 1)) {
        const task = m[1].slice(0, i), askId = m[1].slice(i + 1);
        if (CANVAS_ASK_ID.test(askId) && (!tasks || tasks.has(task))) return `t-${task}#${askId}`;
      }
    }
    m = /^o-(.+)-(a[1-9][0-9]*)-[1-9][0-9]*$/.exec(id);
    if (m && (!tasks || tasks.has(m[1]))) return `t-${m[1]}#${m[2]}`;
    if (agents) for (const [aid, task] of Object.entries(agents)) {
      if (id === `cvd-${aid}` || id.startsWith(`cv-${aid}-`)) return !tasks || tasks.has(task) ? "t-" + task : null;
    }
    m = /^[ax]-(.+)-(a?[1-9][0-9]*)$/.exec(id);
    if (m && (!tasks || tasks.has(m[1]))) return `t-${m[1]}#${m[2].startsWith("a") ? m[2] : "a" + m[2]}`;
    return null;
  };
  for (let i = parts.length - 1; i >= 0; i--) {
    const idm = /#([A-Za-z_][\w.-]*)/.exec(parts[i]);
    if (!idm) continue;
    const id = idm[1];
    const t = taskId(id);
    if (t) return t;
    // an anchor the page stamped inside a card (anchors.ts): k_<owning card/ask id>_<path>
    const k = STAMP_ID.exec(id);
    const owned = k && taskId(k[1]);
    if (owned) return owned;
    if (/^g-|^(live|tasks)$/.test(id)) continue;
    if (parts[i].startsWith("section") || dataSections.has(id) || sections?.has(id)) return id;
  }
  return "page";
}
