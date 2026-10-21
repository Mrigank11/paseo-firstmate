// Read-only loader: first-mate state on disk -> a typed model of one project's status page.
// Missing files mean empty values. Malformed JSON throws a clear Error naming the file.
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type Ask = { text: string; since?: string; context?: string; contextMd: string };

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

function toTask(raw: any, root: string, label: string): Task {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") throw new Error(`${label}: task without a string id`);
  const asks: Ask[] = (Array.isArray(raw.asks) ? raw.asks : []).map((a: any) => {
    const stateDir = resolve(root, "state");
    let contextMd = "";
    if (a && typeof a.context === "string" && a.context) {
      const p = resolve(stateDir, a.context);
      if (p.startsWith(stateDir + sep)) contextMd = readText(p);
    }
    return { text: String(a?.text ?? ""), since: a?.since, context: a?.context, contextMd };
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

  const fleetPath = join(state, "fleet.json");
  const fleetText = readText(fleetPath);
  const fleet: any = fleetText.trim() ? parseJson(fleetText, fleetPath) : { tasks: [] };
  const live: any[] = Array.isArray(fleet?.tasks) ? fleet.tasks : [];
  const tasks = live.filter((t) => t && t.project === project).map((t) => toTask(t, root, fleetPath));

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
