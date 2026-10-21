// Read-only loader: first-mate state on disk -> a typed model of one project's status page.
// Missing files mean empty values. Malformed JSON throws a clear Error naming the file.
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type Ask = { text: string; since?: string; context?: string; contextMd: string; repliedAt?: string; replyText?: string };

export type Task = {
  id: string;
  intent: string;
  title?: string;
  project?: string;
  shape?: string;
  status: string;
  agentId?: string;
  depends_on: string[];
  asks: Ask[];
  notes: string;
  pr?: string;
  branch?: string;
  lastEvent?: string;
  /** Markdown from state/tasks/<id>/card.md ("" when absent). */
  card: string;
};

export type Section = { name: string; kind: "md" | "html"; content: string };

export type ProjectModel = {
  project: string;
  title: string;
  /** Absolute path of the page file, if configured. */
  page?: string;
  sectionTitles: Record<string, string>;
  sections: Section[];
  /** Live index tasks of this project, in file order. */
  tasks: Task[];
  /** Last 30 archive lines of this project, oldest first. */
  archive: Task[];
};

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: invalid JSON (${(e as Error).message})`);
  }
}

type Comment = { target: string; at: number; atIso: string; text: string };

/** Captain comments from inbox.jsonl. Read-only; a missing file or bad lines are skipped. */
function readInbox(path: string): Comment[] {
  const out: Comment[] = [];
  for (const line of readText(path).split("\n")) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      const at = Date.parse(c?.at);
      if (c && typeof c.target === "string" && typeof c.text === "string" && !isNaN(at)) out.push({ target: c.target, at, atIso: c.at, text: c.text });
    } catch { /* bad line */ }
  }
  return out;
}

function toTask(raw: any, root: string, label: string, inbox: Comment[] = []): Task {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") throw new Error(`${label}: task without a string id`);
  const asks: Ask[] = (Array.isArray(raw.asks) ? raw.asks : []).map((a: any) => {
    const stateDir = resolve(root, "state");
    let contextMd = "";
    if (a && typeof a.context === "string" && a.context) {
      const p = resolve(stateDir, a.context);
      if (p.startsWith(stateDir + sep)) contextMd = readText(p);
    }
    const ask: Ask = { text: String(a?.text ?? ""), since: a?.since, context: a?.context, contextMd };
    const since = Date.parse(a?.since ?? "");
    let best: Comment | undefined;
    if (!isNaN(since)) for (const c of inbox) if (c.target === `t-${raw.id}` && c.at > since && (!best || c.at >= best.at)) best = c;
    if (best) { ask.repliedAt = best.atIso; ask.replyText = best.text; }
    return ask;
  });
  return {
    id: raw.id,
    intent: String(raw.intent ?? ""),
    title: raw.title || undefined,
    project: raw.project || undefined,
    shape: raw.shape,
    status: String(raw.status ?? "queued"),
    agentId: raw.agentId || undefined,
    depends_on: Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : [],
    asks,
    notes: String(raw.notes ?? ""),
    pr: raw.pr || undefined,
    branch: raw.branch || undefined,
    lastEvent: raw.lastEvent || undefined,
    card: /^[\w.-]+$/.test(raw.id) ? readText(join(root, "state", "tasks", raw.id, "card.md")) : "",
  };
}

export function loadProject(root: string, project: string): ProjectModel {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error(`bad project slug '${project}'`);
  const state = join(root, "state");
  const pdir = join(state, "projects", project);

  const cfgPath = join(pdir, "project.json");
  const cfgText = readText(cfgPath);
  const cfg: any = cfgText.trim() ? parseJson(cfgText, cfgPath) : {};

  const inbox = readInbox(join(pdir, "inbox.jsonl"));

  const fleetPath = join(state, "fleet.json");
  const fleetText = readText(fleetPath);
  const fleet: any = fleetText.trim() ? parseJson(fleetText, fleetPath) : { tasks: [] };
  const live: any[] = Array.isArray(fleet?.tasks) ? fleet.tasks : [];
  const tasks = live.filter((t) => t && t.project === project).map((t) => toTask(t, root, fleetPath, inbox));
  // A replied ask is "with the first mate" only while something in the project is in progress. Once no task is
  // dispatched or running, the follow-up is over (or never started), so the ask is the captain's again, even
  // if the first mate forgot `bin/fleet reask`.
  if (!tasks.some((t) => t.status === "dispatched" || t.status === "running")) {
    for (const t of tasks) for (const a of t.asks) { delete a.repliedAt; delete a.replyText; }
  }

  const archPath = join(state, "fleet-archive.jsonl");
  const archive: Task[] = [];
  readText(archPath).split("\n").forEach((line, n) => {
    if (!line.trim()) return;
    const raw: any = parseJson(line, `${archPath} line ${n + 1}`);
    if (raw && raw.project === project) archive.push(toTask(raw, root, `${archPath} line ${n + 1}`));
  });

  const sections: Section[] = [];
  for (const name of Array.isArray(cfg.sections) ? cfg.sections : []) {
    if (typeof name !== "string" || !/^[\w-]+$/.test(name)) throw new Error(`${cfgPath}: bad section name ${JSON.stringify(name)}`);
    const dir = join(pdir, "sections");
    const html = readText(join(dir, `${name}.html`));
    if (html) sections.push({ name, kind: "html", content: html });
    else sections.push({ name, kind: "md", content: readText(join(dir, `${name}.md`)) });
  }

  return {
    project,
    title: typeof cfg.title === "string" && cfg.title ? cfg.title : project,
    page: typeof cfg.page === "string" && cfg.page ? cfg.page : undefined,
    sectionTitles: cfg.sectionTitles && typeof cfg.sectionTitles === "object" ? cfg.sectionTitles : {},
    sections,
    tasks,
    archive: archive.slice(-30),
  };
}
