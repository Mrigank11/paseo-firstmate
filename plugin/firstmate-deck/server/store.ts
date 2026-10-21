// On-disk files the plugin owns per project: inbox.jsonl (comments) and page.json (page/session status).
// Pure node:fs, sync, shared with bin/page's helper. Writers take a mkdir lock so the plugin's append and
// `bin/page reply`'s atomic rewrite can never lose each other's lines.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type InboxEntry = {
  id: string;
  at: string;
  project: string;
  target: string;
  text: string;
  prompt: unknown;
  delivered: boolean;
  answered: boolean;
  /** Set when the comment is a click on an ask's option button. */
  choice?: Choice;
};

/** A click on an ask option: which task and ask (1-based), which option, and the ask text for the message. */
export type Choice = { task: string; ask: number; option: string; askText?: string };

export type PageJson = {
  lavishUrl: string | null;
  session: "open" | "ended" | "unknown";
  lastRender: string | null;
  lastDelivery: string | null;
  undelivered: number;
  /** "ok" | "active-elsewhere" | "error": the state of the plugin's Lavish poll. Informational. */
  listener?: string;
  /** Banner text currently shown on the page, if any. */
  banner?: string | null;
};

export const projectDir = (root: string, project: string) => join(root, "state", "projects", project);
export const inboxPath = (root: string, project: string) => join(projectDir(root, project), "inbox.jsonl");
export const pageJsonPath = (root: string, project: string) => join(projectDir(root, project), "page.json");
export const pidPath = (root: string, project: string) => join(projectDir(root, project), ".poll.pid");

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run fn holding `<file>.lock` (an mkdir lock). Stale locks older than 5 s are broken. */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = file + ".lock";
  mkdirSync(dirname(file), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) rmdirSync(lock);
      } catch {}
      if (Date.now() - t0 > 8000) throw new Error(`lock timeout: ${lock}`);
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch {}
  }
}

export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), "." + path.slice(path.lastIndexOf("/") + 1) + ".tmp");
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function readInbox(path: string): InboxEntry[] {
  if (!existsSync(path)) return [];
  const out: InboxEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

export function appendInbox(path: string, entries: InboxEntry[]): void {
  if (!entries.length) return;
  withLock(path, () => appendFileSync(path, entries.map((e) => JSON.stringify(e) + "\n").join("")));
}

/** Atomically rewrite the inbox, applying fn to every entry (mutate in place). Returns how many changed. */
export function updateInbox(path: string, fn: (e: InboxEntry) => void): number {
  return withLock(path, () => {
    const all = readInbox(path);
    let changed = 0;
    for (const e of all) {
      const before = JSON.stringify(e);
      fn(e);
      if (JSON.stringify(e) !== before) changed++;
    }
    if (changed) writeAtomic(path, all.map((e) => JSON.stringify(e) + "\n").join(""));
    return changed;
  });
}

export function readPageJson(path: string): PageJson {
  const base: PageJson = { lavishUrl: null, session: "unknown", lastRender: null, lastDelivery: null, undelivered: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { ...base, ...raw };
  } catch {
    return base;
  }
}

/** Merge `patch` into page.json (atomic). Skips the write when nothing changes. Returns the new value. */
export function patchPageJson(path: string, patch: Partial<PageJson>): PageJson {
  return withLock(path, () => {
    const cur = readPageJson(path);
    if (!existsSync(join(dirname(path), "project.json"))) return cur; // project deleted: don't recreate its dir
    const next = { ...cur, ...patch };
    if (JSON.stringify(next) !== JSON.stringify(cur) || !existsSync(path)) writeAtomic(path, JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}
