// Delivery of page comments to the first mate. Entries are already in inbox.jsonl when they reach the relay.
// Batches arriving within BATCH_MS (300 ms: Lavish already hands over one Send as one poll result) become one message; a failed send retries at 2 s, 10 s, 30 s, then every 60 s.
import { randomBytes } from "node:crypto";
import type { Choice, InboxEntry } from "./store.ts";
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
  const { task, ask, option } = data;
  if (typeof task !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(task)) return null;
  if (!Number.isInteger(ask) || ask < 1 || typeof option !== "string" || !option.trim()) return null;
  return { choice: { task, ask, option }, text };
}

export function newEntries(project: string, prompts: Prompt[], known: Known, now = new Date(), askText?: (task: string, ask: number) => string | undefined): InboxEntry[] {
  return prompts.map((p) => {
    const picked = parseChoice(p);
    const base = {
      id: `c-${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`,
      at: now.toISOString(),
      project,
      prompt: p,
      delivered: false,
      answered: false,
    };
    if (picked) {
      const { choice } = picked;
      const at = askText?.(choice.task, choice.ask);
      return { ...base, target: `t-${choice.task}#a${choice.ask}`, text: picked.text, choice: at ? { ...choice, askText: at } : choice };
    }
    return { ...base, target: extractTarget(p.selector, known), text: p.prompt };
  });
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const brief = (s: string, n = 100) => { const t = oneLine(s).replace(/"/g, "'"); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** What the first mate needs to know about a comment's target without looking anything up. */
export type TargetInfo = { title: string; asks: string[] };
export type Describe = (target: string) => TargetInfo | undefined;

/** `t-<task>` or `t-<task>#a<n>` -> the task id and, for an ask target, the 1-based ask index. */
export function parseTarget(target: string): { task: string; ask?: number } | null {
  const m = /^t-(.+?)(?:#a(\d+))?$/.exec(target);
  return m ? { task: m[1], ask: m[2] ? Number(m[2]) : undefined } : null;
}

/**
 * One line per comment, self-contained and traceable:
 *   - [t-pick-db · "Choose the database" · ask 1: "Postgres or SQLite?"] (c-abc123) "<text>"
 * The bracket names the target, the task title and the open ask text(s); the parenthesis is the inbox comment id.
 */
type Line = Pick<InboxEntry, "target" | "text" | "choice"> & { id?: string };

export function formatMessage(project: string, entries: Line[], describe?: Describe): string {
  const choices = entries.filter((e) => e.choice).map((e) => e.choice!);
  const line = (e: Line) => {
    const parts = [e.target];
    const info = describe?.(e.target);
    if (info) {
      parts.push(`"${brief(info.title, 80)}"`);
      const at = parseTarget(e.target);
      if (!e.choice) {
        const only = at?.ask;
        info.asks.forEach((a, i) => { if ((only === undefined || only === i + 1) && a) parts.push(`ask ${i + 1}: "${brief(a)}"`); });
      }
    }
    const id = e.id ? ` (${e.id})` : "";
    return e.choice
      ? `- [${parts.join(" · ")}]${id} picked option "${oneLine(e.choice.option)}" for ask ${e.choice.ask}${e.choice.askText ? ` ("${oneLine(e.choice.askText)}")` : ""}`
      : `- [${parts.join(" · ")}]${id} "${oneLine(e.text)}"`;
  };
  return [
    `## Page comments · ${project}`,
    ...entries.map(line),
    `Reply with: bin/page reply ${project} "<your reply>"`,
    ...choices.map((c) => `Apply with: bin/fleet answer ${c.task} ${c.ask}, then act on it.`),
  ].join("\n");
}

export type RelayDeps = {
  /** Send the message to the first mate (resolving it afresh). Resolves to the agent id; rejects on failure. */
  send: (project: string, message: string) => Promise<string>;
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
    const batch = q.pending.splice(0);
    const log = this.d.log ?? (() => {});
    let agentId: string;
    try {
      agentId = await this.d.send(project, formatMessage(project, batch, this.d.describe && ((t) => this.d.describe!(project, t))));
    } catch (e) {
      q.pending.unshift(...batch);
      q.failures++;
      q.sending = false;
      const delay = q.failures <= RETRY_MS.length ? RETRY_MS[q.failures - 1] : RETRY_EVERY_MS;
      log(`delivery to first mate failed (${(e as Error).message}); ${q.pending.length} queued, retry in ${delay} ms`);
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
    try {
      await this.d.afterSend?.(project, batch, agentId);
    } catch (e) {
      log(`timeline row skipped: ${e}`);
    }
  }

  stop(): void {
    for (const q of this.q.values()) if (q.timer) { clearTimeout(q.timer); q.timer = null; }
  }
}
