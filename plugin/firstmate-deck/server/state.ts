// Read-only loader: first-mate state on disk -> a typed model of one project's status page.
// Missing files mean empty values. Malformed JSON throws a clear Error naming the file.
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type Ask = {
  text: string;
  since?: string;
  context?: string;
  contextMd: string;
  /** Fixed answers offered as buttons (2-6 strings), from `bin/fleet ask --options`. */
  options?: string[];
  /**
   * Set while the ask is "with the first mate": an unanswered comment or choice on the ask itself, or the first
   * mate marked a follow-up pending (`bin/fleet pending`, via `bin/page reply --followup`). Cleared otherwise.
   */
  repliedAt?: string;
  /** The comment that moved the ask (absent when it is only marked pending). */
  replyText?: string;
  /** That comment has been answered via `bin/page reply`. */
  replyAnswered?: boolean;
  /** When the first mate marked a follow-up pending (`bin/fleet pending`); cleared by reask and answer. */
  pendingSince?: string;
  /** The reply was a click on one of the options. */
  replyChoice?: string;
};

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

/** One captain comment from inbox.jsonl, as the page trail shows it. */
export type TrailComment = {
  id: string;
  at: string;
  target: string;
  text: string;
  delivered: boolean;
  answered: boolean;
  choice?: { ask: number; option: string };
};

export type ProjectModel = {
  project: string;
  title: string;
  /** Absolute path of the page file, if configured. */
  page?: string;
  sectionTitles: Record<string, string>;
  sections: Section[];
  /** Every captain comment in the inbox, oldest first. Not part of the page signature (it changes with delivery state). */
  comments: TrailComment[];
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

type Comment = TrailComment & { atMs: number };

/** Captain comments from inbox.jsonl. Read-only; a missing file or bad lines are skipped. */
function readInbox(path: string): Comment[] {
  const out: Comment[] = [];
  for (const line of readText(path).split("\n")) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      const atMs = Date.parse(c?.at);
      if (c && typeof c.target === "string" && typeof c.text === "string" && !isNaN(atMs)) {
        const ch = c.choice;
        const choice = ch && typeof ch.option === "string" && Number.isInteger(ch.ask) ? { ask: ch.ask as number, option: ch.option } : undefined;
        out.push({ id: String(c.id ?? ""), at: c.at, atMs, target: c.target, text: c.text, delivered: c.delivered === true, answered: c.answered === true, ...(choice ? { choice } : {}) });
      }
    } catch { /* bad line */ }
  }
  return out;
}

function toTask(raw: any, root: string, label: string, inbox: Comment[] = []): Task {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") throw new Error(`${label}: task without a string id`);
  const asks: Ask[] = (Array.isArray(raw.asks) ? raw.asks : []).map((a: any, i: number) => {
    const stateDir = resolve(root, "state");
    let contextMd = "";
    if (a && typeof a.context === "string" && a.context) {
      const p = resolve(stateDir, a.context);
      if (p.startsWith(stateDir + sep)) contextMd = readText(p);
    }
    const ask: Ask = { text: String(a?.text ?? ""), since: a?.since, context: a?.context, contextMd };
    if (Array.isArray(a?.options)) {
      const opts = a.options.filter((o: unknown) => typeof o === "string" && o.length > 0).slice(0, 6) as string[];
      if (opts.length >= 2) ask.options = opts;
    }
    const since = Date.parse(a?.since ?? "");
    if (typeof a?.pendingSince === "string" && a.pendingSince) ask.pendingSince = a.pendingSince;
    // Only comments on THIS ask (its block, option buttons or context expander: target "t-<task>#a<n>") move it.
    // Comments on the card's steps or body (target "t-<task>") are shown in the trail and nothing else.
    let latest: Comment | undefined; // newest comment on this ask since it was raised
    let open: Comment | undefined; // newest UNANSWERED one: the immediate "with the first mate" reaction
    if (!isNaN(since)) {
      for (const c of inbox) {
        if (c.target !== `t-${raw.id}#a${i + 1}` || c.atMs <= since) continue;
        if (!latest || c.atMs >= latest.atMs) latest = c;
        if (!c.answered && (!open || c.atMs >= open.atMs)) open = c;
      }
    }
    // After the reply, the ask stays with the first mate ONLY if the first mate marked it pending; otherwise it
    // is back in Needs you.
    const mover = open ?? (ask.pendingSince ? latest : undefined);
    if (mover) {
      ask.repliedAt = mover.at; ask.replyText = mover.text; ask.replyAnswered = mover.answered;
      if (mover.choice) ask.replyChoice = mover.choice.option;
    } else if (ask.pendingSince) {
      ask.repliedAt = ask.pendingSince;
    }
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
    comments: inbox.map(({ atMs: _a, ...c }) => c),
    tasks,
    archive: archive.slice(-30),
  };
}
