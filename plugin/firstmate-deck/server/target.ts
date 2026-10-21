// Where on the page a Lavish comment points: "t-<taskId>" for a task card, a section id, or "page".

export type Known = { tasks?: Iterable<string>; sections?: Iterable<string> };

export function extractTarget(selector: string | undefined, known: Known = {}): string {
  if (!selector) return "page";
  const tasks = known.tasks ? new Set(known.tasks) : null;
  const sections = known.sections ? new Set(known.sections) : null;
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
    m = /^a-(.+)-\d+$/.exec(id);
    if (m && (!tasks || tasks.has(m[1]))) return "t-" + m[1];
    return null;
  };
  for (let i = parts.length - 1; i >= 0; i--) {
    const idm = /#([A-Za-z_][\w.-]*)/.exec(parts[i]);
    if (!idm) continue;
    const id = idm[1];
    const t = taskId(id);
    if (t) return t;
    if (/^g-|^(live|tasks)$/.test(id)) continue;
    if (parts[i].startsWith("section") || dataSections.has(id) || sections?.has(id)) return id;
  }
  return "page";
}
