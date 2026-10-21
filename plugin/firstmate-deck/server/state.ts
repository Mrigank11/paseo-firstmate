// Read-only loader: first-mate state on disk -> a typed model of one project's status page.
// Missing files mean empty values. Malformed JSON throws a clear Error naming the file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { cleanUi } from "./marks.ts";
import { askIdOf } from "./store.ts";

export type Ask = {
  /** bin/fleet's stable ask id ("a2"). An ask written before ids existed is "a<its 1-based index>". */
  id: string;
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
  /** That comment has reached the first mate. */
  replyDelivered?: boolean;
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
  /** "<provider>/<model>" or a plain model name, as the first mate (or an import) recorded it. The label of last resort when Paseo has no record of the agent. */
  provider?: string;
  /** Position within its page group, lowest first (bin/fleet set order=N). Tasks without one keep file order, after the ordered ones. */
  order?: number;
  /** The id this task had on a hand-run page it was imported from. */
  legacyId?: string;
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
  /** Asks the first mate has answered (state/tasks/<id>/asks.jsonl, written by `bin/fleet answer`), oldest first; context files left without a record come last with no text. */
  answered: AnsweredAsk[];
  /** state/tasks/<id>/report.md exists: the page points at it. */
  hasReport: boolean;
  /** `lastEvent` as epoch ms (0 when absent): what the Done group sorts by. */
  updatedMs: number;
};

export type AnsweredAsk = { id: string; text: string; since?: string; answeredAt?: string; contextMd: string };

export type Section = { name: string; kind: "md" | "html"; content: string };

/** One captain comment from inbox.jsonl, as the page trail shows it. */
export type TrailComment = {
  id: string;
  at: string;
  target: string;
  text: string;
  delivered: boolean;
  answered: boolean;
  choice?: { ask: string; option: string };
  /** A choice click on an ask that was no longer open (or an option it does not offer): shown, never applied. */
  stale?: boolean;
};

export type ProjectModel = {
  project: string;
  title: string;
  /** Absolute path of the page file, if configured. */
  page?: string;
  sectionTitles: Record<string, string>;
  /** Raw HTML shown after a section's heading (project.json `sectionSubtitles`), e.g. "· 19 commits, local only". */
  sectionSubtitles: Record<string, string>;
  /** Sections drawn as a collapsed <details> (project.json `collapsedSections`). */
  collapsedSections: string[];
  sections: Section[];
  /** Every captain comment in the inbox, oldest first. Not part of the page signature (it changes with delivery state). */
  comments: TrailComment[];
  /** Read marks ("t-<task>" -> card hash) from state/projects/<p>/ui-state.json; the first paint applies them. */
  marks?: Record<string, string>;
  /** Live index tasks of this project, in file order. */
  tasks: Task[];
  /** The project's archived tasks, oldest first: the last 30, or project.json `archiveLimit`. A task archived twice (bin/fleet archive-update) appears once, as its newest line. */
  archive: Task[];
  /** Archive lines skipped because they are not valid JSON (a crash mid-append leaves one). */
  archiveSkipped: number;
  /** Set when fleet.json exists but cannot be used (empty or malformed). `tasks` is then empty: the caller keeps its last good model. */
  fleetError?: { file: string; message: string };
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
        const askId = ch ? askIdOf(ch.ask) : null;
        const choice = ch && typeof ch.option === "string" && askId ? { ask: askId, option: ch.option } : undefined;
        out.push({ id: String(c.id ?? ""), at: c.at, atMs, target: c.target, text: c.text, delivered: c.delivered === true, answered: c.answered === true, ...(choice ? { choice } : {}), ...(c.stale === true ? { stale: true } : {}) });
      }
    } catch { /* bad line */ }
  }
  return out;
}

/** `order` is a whole number >= 0 (bin/fleet stores it as a number); a numeric string is accepted too. Anything else means "no order". */
export function orderOf(v: unknown): number | undefined {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

function readContext(root: string, rel: unknown): string {
  const stateDir = resolve(root, "state");
  if (typeof rel !== "string" || !rel) return "";
  const p = resolve(stateDir, rel);
  return p.startsWith(stateDir + sep) ? readText(p) : "";
}

/** Answered asks of a task: the records bin/fleet answer kept, then any asks/<n>.md context with no record (answered before records existed). */
function loadAnswered(root: string, id: string): AnsweredAsk[] {
  if (!/^[\w.-]+$/.test(id)) return [];
  const dir = join(root, "state", "tasks", id);
  const out: AnsweredAsk[] = [];
  for (const line of readText(join(dir, "asks.jsonl")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line);
      const aid = askIdOf(a?.id);
      if (!aid || out.some((x) => x.id === aid)) continue;
      out.push({ id: aid, text: String(a.text ?? ""), since: a.since, answeredAt: a.answeredAt, contextMd: readContext(root, a.context) });
    } catch { /* bad line */ }
  }
  let files: string[] = [];
  try { files = readdirSync(join(dir, "asks")).filter((f) => /^\d+\.md$/.test(f)); } catch { /* none */ }
  files.sort((a, b) => parseInt(a) - parseInt(b));
  for (const f of files) {
    const aid = `a${parseInt(f)}`;
    if (!out.some((x) => x.id === aid)) out.push({ id: aid, text: "", contextMd: readText(join(dir, "asks", f)) });
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
    // The plugin never writes fleet.json, so an ask without an id falls back to its index: the id bin/fleet gives it at its first write.
    const id = askIdOf(a?.id) ?? `a${i + 1}`;
    const ask: Ask = { id, text: String(a?.text ?? ""), since: a?.since, context: a?.context, contextMd };
    if (Array.isArray(a?.options)) {
      const opts = a.options.filter((o: unknown) => typeof o === "string" && o.length > 0).slice(0, 6) as string[];
      if (opts.length >= 2) ask.options = opts;
    }
    const since = Date.parse(a?.since ?? "");
    if (typeof a?.pendingSince === "string" && a.pendingSince) ask.pendingSince = a.pendingSince;
    // Only comments on THIS ask (its block, option buttons or context expander: target "t-<task>#<askId>") move it.
    // A stale click (the ask was already closed when it arrived) moves nothing.
    // Comments on the card's steps or body (target "t-<task>") are shown in the trail and nothing else.
    let latest: Comment | undefined; // newest comment on this ask since it was raised
    let open: Comment | undefined; // newest UNANSWERED one: the immediate "with the first mate" reaction
    if (!isNaN(since)) {
      for (const c of inbox) {
        if (c.target !== `t-${raw.id}#${id}` || c.atMs <= since || c.stale) continue;
        if (!latest || c.atMs >= latest.atMs) latest = c;
        if (!c.answered && (!open || c.atMs >= open.atMs)) open = c;
      }
    }
    // After the reply, the ask stays with the first mate ONLY if the first mate marked it pending; otherwise it
    // is back in Needs you.
    const mover = open ?? (ask.pendingSince ? latest : undefined);
    if (mover) {
      ask.repliedAt = mover.at; ask.replyText = mover.text; ask.replyAnswered = mover.answered; ask.replyDelivered = mover.delivered;
      if (mover.choice) ask.replyChoice = mover.choice.option;
    } else if (ask.pendingSince) {
      ask.repliedAt = ask.pendingSince;
    }
    return ask;
  });
  const slug = /^[\w.-]+$/.test(raw.id);
  const answeredIds = new Set(asks.map((a) => a.id));
  return {
    id: raw.id,
    intent: String(raw.intent ?? ""),
    title: raw.title || undefined,
    project: raw.project || undefined,
    shape: raw.shape,
    provider: typeof raw.provider === "string" && raw.provider ? raw.provider : undefined,
    order: orderOf(raw.order),
    legacyId: typeof raw.legacyId === "string" && raw.legacyId ? raw.legacyId : undefined,
    status: String(raw.status ?? "queued"),
    agentId: raw.agentId || undefined,
    depends_on: Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : [],
    asks,
    notes: String(raw.notes ?? ""),
    pr: raw.pr || undefined,
    branch: raw.branch || undefined,
    lastEvent: raw.lastEvent || undefined,
    card: slug ? readText(join(root, "state", "tasks", raw.id, "card.md")) : "",
    answered: loadAnswered(root, raw.id).filter((a) => !answeredIds.has(a.id)),
    hasReport: slug && existsSync(join(root, "state", "tasks", raw.id, "report.md")),
    updatedMs: Date.parse(raw.lastEvent ?? "") || 0,
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

  // A missing fleet.json is a fresh checkout (no tasks). One that exists but is empty or malformed is a problem the
  // caller must see: it keeps its last good model and says so, instead of showing "no tasks".
  const fleetPath = join(state, "fleet.json");
  let fleetError: ProjectModel["fleetError"];
  let live: any[] = [];
  const fleetExists = existsSync(fleetPath);
  const fleetText = readText(fleetPath);
  if (fleetExists && !fleetText.trim()) {
    fleetError = { file: basename(fleetPath), message: "file is empty" };
  } else if (fleetText.trim()) {
    try {
      const fleet: any = parseJson(fleetText, fleetPath);
      live = Array.isArray(fleet?.tasks) ? fleet.tasks : [];
    } catch (e) {
      fleetError = { file: basename(fleetPath), message: (e as Error).message.replace(`${fleetPath}: `, "") };
    }
  }
  const tasks = live.filter((t) => t && t.project === project).map((t) => toTask(t, root, fleetPath, inbox));
  const archPath = join(state, "fleet-archive.jsonl");
  const archive = new Map<string, Task>();
  let archiveSkipped = 0;
  for (const line of readText(archPath).split("\n")) {
    if (!line.trim()) continue;
    let raw: any;
    try { raw = JSON.parse(line); } catch { archiveSkipped++; continue; }
    if (raw && typeof raw.id === "string") {
      // the newest line for an id wins (bin/fleet archive-update appends), whichever project the older line named
      if (raw.project === project) { archive.delete(raw.id); archive.set(raw.id, toTask(raw, root, archPath)); }
      else archive.delete(raw.id);
    }
  }
  const archiveLimit = Number.isInteger(cfg.archiveLimit) && cfg.archiveLimit > 0 ? cfg.archiveLimit : 30;

  const sections: Section[] = [];
  for (const name of Array.isArray(cfg.sections) ? cfg.sections : []) {
    if (typeof name !== "string" || !/^[\w-]+$/.test(name)) throw new Error(`${cfgPath}: bad section name ${JSON.stringify(name)}`);
    const dir = join(pdir, "sections");
    const html = readText(join(dir, `${name}.html`));
    if (html) sections.push({ name, kind: "html", content: html });
    else sections.push({ name, kind: "md", content: readText(join(dir, `${name}.md`)) });
  }

  let marks: Record<string, string> = {};
  try { marks = cleanUi(JSON.parse(readText(join(pdir, "ui-state.json")) || "{}")).r; } catch { /* a bad file means no marks */ }

  return {
    project,
    marks,
    title: typeof cfg.title === "string" && cfg.title ? cfg.title : project,
    page: typeof cfg.page === "string" && cfg.page ? cfg.page : undefined,
    sectionTitles: cfg.sectionTitles && typeof cfg.sectionTitles === "object" ? cfg.sectionTitles : {},
    sectionSubtitles: cfg.sectionSubtitles && typeof cfg.sectionSubtitles === "object" ? cfg.sectionSubtitles : {},
    collapsedSections: Array.isArray(cfg.collapsedSections) ? cfg.collapsedSections.filter((x: unknown): x is string => typeof x === "string") : [],
    sections,
    comments: inbox.map(({ atMs: _a, ...c }) => c),
    tasks,
    archive: [...archive.values()].slice(-archiveLimit),
    archiveSkipped,
    ...(fleetError ? { fleetError } : {}),
  };
}
