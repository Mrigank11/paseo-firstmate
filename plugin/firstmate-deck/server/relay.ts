// Delivery of page comments to the first mate. Entries are already in inbox.jsonl when they reach the relay.
// Batches arriving within BATCH_MS (300 ms: Lavish already hands over one Send as one poll result) become one message; a failed send retries at 2 s, 10 s, 30 s, then every 60 s.
import { randomBytes } from "node:crypto";
import type { InboxEntry } from "./store.ts";
import type { Prompt } from "./toon.ts";
import { extractTarget, type Known } from "./target.ts";

export const BATCH_MS = 300;
export const RETRY_MS = [2000, 10_000, 30_000];
export const RETRY_EVERY_MS = 60_000;

export function newEntries(project: string, prompts: Prompt[], known: Known, now = new Date()): InboxEntry[] {
  return prompts.map((p) => ({
    id: `c-${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`,
    at: now.toISOString(),
    project,
    target: extractTarget(p.selector, known),
    text: p.prompt,
    prompt: p,
    delivered: false,
    answered: false,
  }));
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function formatMessage(project: string, entries: Pick<InboxEntry, "target" | "text">[]): string {
  return [
    `## Page comments · ${project}`,
    ...entries.map((e) => `- [${e.target}] "${oneLine(e.text)}"`),
    `Reply with: bin/page reply ${project} "<your reply>"`,
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
      agentId = await this.d.send(project, formatMessage(project, batch));
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
