// Delivery of page comments to the first mate. Entries are already in inbox.jsonl when they reach the relay.
// Batches arriving within BATCH_MS (300 ms: Lavish already hands over one Send as one poll result) become one message; a failed send retries at 2 s, 10 s, 30 s, then every 60 s.
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { CANVAS_ASK_BODY } from "./ask-id.ts";
import { askIdOf, canvasAskIdOf, type Choice, type InboxEntry } from "./store.ts";
import type { Prompt } from "./toon.ts";
import { extractTarget, type Known } from "./target.ts";

export const BATCH_MS = 300;
export const RETRY_MS = [2000, 10_000, 30_000];
export const RETRY_EVERY_MS = 60_000;

const CONTEXT_MARK = "\n\nContext data:\n";

/**
 * An ask-choice click, if the prompt is one. lavish-axi folds `queuePrompt(..., {data})` into the prompt text as
 * "<text>\n\nContext data:\n<pretty JSON>", so the data is read from there (or from a `data` field, if a future
 * Lavish passes it separately). Returns the choice and the prompt text without the data suffix.
 */
export function parseChoice(p: Prompt): { choice: Choice; text: string } | null {
  let data: any = (p as any).data;
  let text = p.prompt;
  const at = text.indexOf(CONTEXT_MARK);
  if (at >= 0) {
    if (data === undefined) { try { data = JSON.parse(text.slice(at + CONTEXT_MARK.length)); } catch {} }
    text = text.slice(0, at);
  }
  if (!data || typeof data !== "object" || data.kind !== "ask-choice") return null;
  const { task, option } = data;
  const ask = askIdOf(data.ask) ?? canvasAskIdOf(data.ask); // the ask's stable id; a bare number comes from a page loaded before ids existed
  if (typeof task !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(task)) return null;
  if (!ask || typeof option !== "string" || !option.trim()) return null;
  return { choice: { task, ask, option }, text };
}

/** What the plugin knows about an ask when a click arrives: its text and options, or undefined when it is not open. */
export type AskLookup = (task: string, ask: string) => { text: string; options?: string[] } | undefined;

type Attachment = { type?: string; path: string; mime?: string; width?: number; height?: number; [k: string]: unknown };

/** The attachments Lavish put on a prompt (`prompt.attachments`), minus anything malformed. */
function attachmentsOf(p: unknown): Attachment[] {
  const a = (p as any)?.attachments;
  return Array.isArray(a) ? a.filter((x) => x && typeof x.path === "string" && x.path) : [];
}

/**
 * Lavish deletes an upload an hour after it hands the prompt over, so each attachment is copied into `dir`
 * (state/projects/<p>/attachments/) and the prompt is rewritten to point at the copy. A file that cannot be copied
 * keeps its original path. Returns a new prompt; the input is not touched.
 */
export function keepAttachments(p: Prompt, dir: string, id: string): Prompt {
  const list = attachmentsOf(p);
  if (!list.length) return p;
  let made = false;
  const kept = (p as any).attachments.map((a: any, i: number) => {
    if (!list.includes(a)) return a;
    try {
      if (!made) { mkdirSync(dir, { recursive: true }); made = true; }
      const dest = join(dir, `${id}-${i + 1}-${basename(a.path).replace(/[^A-Za-z0-9._-]/g, "_")}`);
      copyFileSync(a.path, dest);
      return { ...a, path: dest, original: a.path };
    } catch {
      return a;
    }
  });
  return { ...p, attachments: kept };
}

export function newEntries(project: string, prompts: Prompt[], known: Known, now = new Date(), lookup?: AskLookup, attachDir?: string): InboxEntry[] {
  return prompts.map((p0) => {
    const id = `c-${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
    const p = attachDir ? keepAttachments(p0, attachDir, id) : p0;
    const picked = parseChoice(p);
    const base = {
      id,
      at: now.toISOString(),
      project,
      prompt: p,
      delivered: false,
      answered: false,
    };
    if (picked) {
      const { choice } = picked;
      const a = lookup?.(choice.task, choice.ask);
      // Validate at ingest: the ask must still be open and the option one of its own. Otherwise the click is kept
      // (the captain did make it) but marked stale, and the first mate is told it is not to be applied.
      const stale = lookup ? !a || (!!a.options && !a.options.includes(choice.option)) : false;
      return {
        ...base, target: `t-${choice.task}#${choice.ask}`, text: picked.text,
        choice: a ? { ...choice, askText: a.text } : choice,
        ...(stale ? { stale: true } : {}),
      };
    }
    return { ...base, target: extractTarget(p.selector, known), text: p.prompt };
  });
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const brief = (s: string, n = 100) => { const t = oneLine(s).replace(/"/g, "'"); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** What the first mate needs to know about a comment's target without looking anything up. */
export type TargetInfo = { title: string; asks: { id: string; text: string }[]; /** Questions open on the crew's own canvas (ids without the "c-"). */ canvasAsks?: { id: string; text: string }[] };
export type Describe = (target: string) => TargetInfo | undefined;

/** `t-<task>` or `t-<task>#<askId>` -> the task id and, for an ask target, the ask id ("a2"). */
export function parseTarget(target: string): { task: string; ask?: string } | null {
  const m = new RegExp(`^t-(.+?)(?:#(a[1-9][0-9]*|c-${CANVAS_ASK_BODY}))?$`).exec(target);
  return m ? { task: m[1], ask: m[2] } : null;
}

export const CHOICES_APPLIED_LINE = "Option picks are applied automatically when you reply; use --keep-open <task>#<askId> to keep an ask open.";

export const CANVAS_PICK_LINE = "A canvas ask is a question on the crew's own canvas: replying does not apply the pick, deliver it to the crew's canvas.";

/**
 * One line per comment, self-contained and traceable:
 *   - [t-pick-db · "Choose the database" · ask a1: "Postgres or SQLite?"] (c-abc123) "<text>"
 * The bracket names the target, the task title and the open ask text(s); the parenthesis is the inbox comment id.
 */
type Line = Pick<InboxEntry, "target" | "text" | "choice" | "stale"> & { id?: string; prompt?: unknown };

/** `[image: <path> (WxH)]` per attachment, so the first mate can open the file. */
const attachmentTags = (e: Line) =>
  attachmentsOf(e.prompt).map((a) => `[${a.type ?? "file"}: ${a.path}${a.width && a.height ? ` (${a.width}x${a.height})` : ""}]`);

/** The text of the element the comment was made on (Lavish keeps up to 240 characters of it), "" for a freeform message. */
const clickedText = (e: Line): string => {
  const p = e.prompt as { selector?: unknown; text?: unknown } | undefined;
  // a comment on the whole page (body/html) has no element worth quoting
  return p && typeof p.selector === "string" && !/^(body|html)$/.test(p.selector) && p.selector && typeof p.text === "string" ? p.text : "";
};

export function formatMessage(project: string, entries: Line[], describe?: Describe): string {
  const onCanvas = (e: Line) => !!e.choice && e.choice.ask.startsWith("c-");
  const live = entries.some((e) => e.choice && !e.stale && !onCanvas(e));
  const canvasPick = entries.some((e) => onCanvas(e) && !e.stale);
  const line = (e: Line) => {
    const parts = [e.target];
    const info = describe?.(e.target);
    if (info) {
      parts.push(`"${brief(info.title, 80)}"`);
      const at = parseTarget(e.target);
      if (!e.choice) {
        const only = at?.ask;
        for (const a of info.asks) if ((only === undefined || only === a.id) && a.text) parts.push(`ask ${a.id}: "${brief(a.text)}"`);
        for (const a of info.canvasAsks ?? []) if ((only === undefined || only === `c-${a.id}`) && a.text) parts.push(`canvas ask ${a.id}: "${brief(a.text)}"`);
      }
    } else if (e.target === "page" && !e.choice) {
      // a comment on an element that still could not be placed: say what was clicked, so it is not a bare "[page]"
      const on = clickedText(e);
      if (on) parts.push(`on "${brief(on, 80)}"`);
    }
    const id = e.id ? ` (${e.id})` : "";
    if (!e.choice) {
      const tags = attachmentTags(e);
      const text = oneLine(e.text);
      return `- [${parts.join(" · ")}]${id} ${text || tags.length ? [text ? `"${text}"` : "(image only)", ...tags].join(" ") : '""'}`;
    }
    // a question the crew put on its canvas (not a registry ask): named by its canvas id so it can be delivered without curating first
    const what = `option "${oneLine(e.choice.option)}" for ${onCanvas(e) ? `canvas ask ${e.choice.ask.slice(2)}` : `ask ${e.choice.ask}`}${e.choice.askText ? ` ("${oneLine(e.choice.askText)}")` : ""}`;
    return e.stale
      ? `- [${parts.join(" · ")}]${id} option click on an ask that is no longer open, ignored: ${what}`
      : `- [${parts.join(" · ")}]${id} picked ${what}`;
  };
  return [
    `## Page comments · ${project}`,
    ...entries.map(line),
    `Reply with: bin/page reply ${project} "<your reply>"`,
    ...(live ? [CHOICES_APPLIED_LINE] : []),
    ...(canvasPick ? [CANVAS_PICK_LINE] : []),
  ].join("\n");
}

export type RelayDeps = {
  /** Send the message to the first mate (resolving it afresh). Resolves to the agent id; rejects on failure. */
  send: (project: string, message: string) => Promise<string>;
  /**
   * Task tree: the agent that owns this comment's target when it is not the project's first mate (the nearest live second mate above
   * the task), else null. Without `route` every comment goes to the first mate, as before.
   */
  route?: (project: string, entry: InboxEntry) => Promise<string | null>;
  /** Send a message straight to the agent `route` named. Rejects on failure. */
  sendTo?: (agentId: string, message: string) => Promise<void>;
  /** Persist the delivery: mark the entries delivered, update page.json. */
  markDelivered: (project: string, ids: string[], at: string) => void;
  /** Tell the page about the queue (banner) and the project's undelivered count. */
  onQueue: (project: string, queued: number, failing: boolean) => void;
  /** After a successful send: best-effort timeline row. Errors are swallowed. */
  afterSend?: (project: string, entries: InboxEntry[], agentId: string) => Promise<void> | void;
  /** Target -> task title and open ask texts, for self-contained comment lines. */
  describe?: (project: string, target: string) => TargetInfo | undefined;
  now?: () => Date;
  batchMs?: number;
  log?: (msg: string) => void;
};

type Q = { pending: InboxEntry[]; timer: ReturnType<typeof setTimeout> | null; sending: boolean; failures: number };

export class Relay {
  private q = new Map<string, Q>();
  private d: RelayDeps;
  constructor(d: RelayDeps) {
    this.d = d;
  }

  private get(project: string): Q {
    let q = this.q.get(project);
    if (!q) this.q.set(project, (q = { pending: [], timer: null, sending: false, failures: 0 }));
    return q;
  }

  queued(project: string): number {
    const q = this.q.get(project);
    return q ? q.pending.length : 0;
  }

  /** Add entries (already written to the inbox). Idempotent per entry id. */
  enqueue(project: string, entries: InboxEntry[], delayMs?: number): void {
    const q = this.get(project);
    for (const e of entries) if (!q.pending.some((p) => p.id === e.id)) q.pending.push(e);
    this.d.onQueue(project, q.pending.length, q.failures > 0);
    // While waiting out a retry, the retry timer will pick the new entries up; otherwise open the batch window.
    if (!q.timer && !q.sending) q.timer = setTimeout(() => void this.flush(project), delayMs ?? this.d.batchMs ?? BATCH_MS);
  }

  async flush(project: string): Promise<void> {
    const q = this.get(project);
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    if (q.sending || !q.pending.length) return;
    q.sending = true;
    const all = q.pending.splice(0);
    const log = this.d.log ?? (() => {});
    // comments owned by a second mate go to it, the rest to the first mate; each group is sent and marked on its own
    const parts: { to: string | null; entries: InboxEntry[] }[] = [];
    for (const e of all) {
      let to: string | null = null;
      if (this.d.route && this.d.sendTo) { try { to = await this.d.route(project, e); } catch { to = null; } }
      const part = parts.find((x) => x.to === to);
      if (part) part.entries.push(e); else parts.push({ to, entries: [e] });
    }
    // the first mate's group goes last, so the common case (no second mate) is one send exactly as before
    parts.sort((a, b) => Number(a.to === null) - Number(b.to === null));
    const okParts: { id: string; entries: InboxEntry[] }[] = [];
    let failure: Error | null = null;
    let left: InboxEntry[] = [];
    for (const part of parts) {
      const msg = formatMessage(project, part.entries, this.d.describe && ((t) => this.d.describe!(project, t)));
      try {
        if (part.to) await this.d.sendTo!(part.to, msg);
        const id = part.to ?? (await this.d.send(project, msg));
        okParts.push({ id, entries: part.entries });
      } catch (e) {
        failure = e as Error; // this group stays queued; the others are still tried
        left.push(...part.entries);
      }
    }
    const batch = okParts.flatMap((p) => p.entries);
    const agentId = okParts.at(-1)?.id ?? "";
    if (failure) {
      q.pending.unshift(...left);
      q.failures++;
      q.sending = false;
      const delay = q.failures <= RETRY_MS.length ? RETRY_MS[q.failures - 1] : RETRY_EVERY_MS;
      log(`delivery to first mate failed (${failure.message}); ${q.pending.length} queued, retry in ${delay} ms`);
      if (batch.length) { try { this.d.markDelivered(project, batch.map((e) => e.id), (this.d.now?.() ?? new Date()).toISOString()); } catch (e) { log(`could not mark delivered: ${e}`); } }
      this.d.onQueue(project, q.pending.length, true);
      q.timer = setTimeout(() => void this.flush(project), delay);
      return;
    }
    q.failures = 0;
    q.sending = false;
    const at = (this.d.now?.() ?? new Date()).toISOString();
    try {
      this.d.markDelivered(project, batch.map((e) => e.id), at);
    } catch (e) {
      log(`could not mark delivered: ${e}`);
    }
    this.d.onQueue(project, q.pending.length, false);
    if (q.pending.length) q.timer = setTimeout(() => void this.flush(project), this.d.batchMs ?? BATCH_MS);
    for (const p of okParts) {
      try {
        await this.d.afterSend?.(project, p.entries, p.id);
      } catch (e) {
        log(`timeline row skipped: ${e}`);
      }
    }
  }

  stop(): void {
    for (const q of this.q.values()) if (q.timer) { clearTimeout(q.timer); q.timer = null; }
  }
}
