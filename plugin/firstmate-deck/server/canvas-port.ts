// The deck's loopback client for agent-canvas (A1's `/api/fm/*`): per-agent summaries and the embeddable card fragment.
// Plugin-side only: the browser never talks to agent-canvas from the page (Lavish's sandbox makes that cross-origin), the deck
// pulls here and writes the result into the page. Polls every POLL_MS while some page tracks an agent, backs off while
// agent-canvas is unreachable, and fetches a card only when its summary `rev` moved. It never throws: no canvas is a soft state.

import { inlineImages, type LoadedImage } from "./canvas-images.ts";

/** What `GET /api/fm/summary` returns per agent (agent-canvas server/hub.ts `FmSummary`). */
export type FmSummary = {
  agentId: string;
  rev: number;
  archived: boolean;
  title: string;
  verdict: { label: string; flags: { signal: string; text: string }[]; needsYou: boolean };
  bluf: string;
  steps: { done: number; total: number; current: string | null };
  openAsks: { id: string; question: string; options: { value: string; label: string }[]; blocking: boolean; pending?: string }[];
  updatedAt: number | null;
  runState: string;
  activity?: unknown;
  url: string;
  agentUrl: string | null;
  auto: boolean;
};

/** ok: the last read worked. down: it failed (the page shows a soft badge). off: no canvas URL is configured. */
export type CanvasStatus = "ok" | "down" | "off";

/** What a render reads: a plain snapshot, so render stays pure. */
export type CanvasData = {
  status: CanvasStatus;
  /** agent-canvas's component stylesheet (scoped under `.acv`), inlined once per page. */
  css: string;
  summaries: Record<string, FmSummary>;
  /** The embed-mode card HTML, per agent (absent until fetched). */
  cards: Record<string, string>;
};

/** The deck page has one theme (light): the embedded canvas follows it, never prefers-color-scheme. */
export const PAGE_THEME = "light" as const;
export const POLL_MS = 3000;
export const MAX_BACKOFF_MS = 60_000;
const TIMEOUT_MS = 4000;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any>; arrayBuffer?(): Promise<ArrayBuffer>; headers?: { get(name: string): string | null } }>;

export type CanvasPortOpts = {
  /** Base URL of agent-canvas, e.g. http://127.0.0.1:6790. "" = no canvas. Read on every poll, so a settings change applies. */
  url: () => string;
  /** Called with the agent ids whose summary or card changed (and with every wanted id when the status flips). */
  onChange: (agentIds: string[]) => void;
  log?: (m: string) => void;
  fetch?: FetchLike;
  pollMs?: number;
  maxBackoffMs?: number;
  /** The theme of the page the canvas is embedded in (the deck page is light). agent-canvas then draws that theme, not the OS's. */
  theme?: "light" | "dark";
};

export class CanvasPort {
  private o: CanvasPortOpts;
  private wanted = new Map<string, Set<string>>(); // owner (a project) -> agent ids
  private sums = new Map<string, FmSummary>();
  private cards = new Map<string, { rev: number; archived: boolean; html: string }>();
  private pics = new Map<string, LoadedImage>(); // canvas assets are immutable by hash: fetched once
  private css = "";
  private st: CanvasStatus = "off";
  private fails = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private stopped = false;
  private lastErr = "";

  constructor(o: CanvasPortOpts) { this.o = o; }

  get status(): CanvasStatus { return this.st; }
  summary(agentId: string): FmSummary | undefined { return this.sums.get(agentId); }

  /** Everything a render needs, for the agents `ids` (all wanted agents when omitted). */
  data(ids?: Iterable<string>): CanvasData {
    const want = ids ? new Set(ids) : this.allWanted();
    const summaries: Record<string, FmSummary> = {};
    const cards: Record<string, string> = {};
    // unreachable or off: no fragment and no stage input (the registry decides alone); the cache is kept for when it returns
    for (const id of this.st === "ok" ? want : []) {
      const s = this.sums.get(id);
      if (s) summaries[id] = s;
      const c = this.cards.get(id);
      if (c) cards[id] = c.html;
    }
    return { status: this.st, css: this.css, summaries, cards };
  }

  /** The agents `owner` (a project page) currently shows; the poll covers the union. An empty set stops polling for that owner. */
  want(owner: string, agentIds: string[]): void {
    const ids = agentIds.filter((id) => /^[\w-]+$/.test(id));
    if (ids.length) this.wanted.set(owner, new Set(ids)); else this.wanted.delete(owner);
    if (!this.timer && !this.flight && this.allWanted().size && !this.stopped) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private allWanted(): Set<string> {
    return new Set([...this.wanted.values()].flatMap((s) => [...s]));
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.poll(); }, ms);
    this.timer.unref?.();
  }

  /** One poll cycle (public so a test can drive it). Never rejects. */
  poll(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.cycle().catch((e) => this.log(`canvas poll failed: ${(e as Error).message}`)).finally(() => {
      this.flight = null;
      if (this.allWanted().size) this.schedule(this.fails ? Math.min((this.o.pollMs ?? POLL_MS) * 2 ** this.fails, this.o.maxBackoffMs ?? MAX_BACKOFF_MS) : this.o.pollMs ?? POLL_MS);
    });
    return this.flight;
  }

  private async picture(hash: string, base: string): Promise<LoadedImage | null> {
    const had = this.pics.get(hash);
    if (had) return had;
    const r = await this.get(`/asset/${hash}`, base);
    if (!r.ok || !r.arrayBuffer) return null;
    const img = { mime: r.headers?.get("content-type") ?? "", bytes: new Uint8Array(await r.arrayBuffer()) };
    if (this.pics.size >= 64) this.pics.delete(this.pics.keys().next().value!);
    this.pics.set(hash, img);
    return img;
  }

  private log(m: string): void { this.o.log?.(m); }

  private async get(path: string, base: string): ReturnType<FetchLike> {
    const f = this.o.fetch ?? ((globalThis as any).fetch as FetchLike);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try { return await f(base + path, { signal: ac.signal }); } finally { clearTimeout(t); }
  }

  private async cycle(): Promise<void> {
    const base = this.o.url().trim().replace(/\/+$/, "");
    const ids = [...this.allWanted()];
    if (!base) { this.setStatus("off", ids); return; }
    if (!ids.length) return;
    let changed = new Set<string>();
    try {
      if (!this.css || this.st !== "ok") {
        const c = await this.get(`/api/fm/css?theme=${this.o.theme ?? PAGE_THEME}`, base);
        if (c.ok) { const css = await c.text(); if (css !== this.css) { this.css = css; ids.forEach((i) => changed.add(i)); } }
      }
      const r = await this.get(`/api/fm/summary?agents=${encodeURIComponent(ids.join(","))}`, base);
      if (!r.ok) throw new Error(`summary answered ${r.status}`);
      const body = await r.json();
      const list: FmSummary[] = Array.isArray(body?.agents) ? body.agents : [];
      const seen = new Set<string>();
      for (const s of list) {
        if (!s || typeof s.agentId !== "string" || !ids.includes(s.agentId)) continue;
        seen.add(s.agentId);
        const prev = this.sums.get(s.agentId);
        const card = this.cards.get(s.agentId);
        // rev bumps on every canvas change; the card is fetched only when it did (or the snapshot flipped to/from archived)
        if (!prev || prev.rev !== s.rev || prev.archived !== s.archived || !card) changed.add(s.agentId);
        this.sums.set(s.agentId, s);
        if (!card || card.rev !== s.rev || card.archived !== s.archived) {
          const c = await this.get(`/api/fm/card/${encodeURIComponent(s.agentId)}${s.archived ? "?archived=1" : ""}`, base);
          if (c.ok) this.cards.set(s.agentId, { rev: s.rev, archived: s.archived, html: await inlineImages(await c.text(), (h) => this.picture(h, base)) });
        }
      }
      // agents the canvas no longer knows (or that nobody wants any more) leave the cache
      for (const id of [...this.sums.keys()]) if (!seen.has(id)) { this.sums.delete(id); this.cards.delete(id); if (ids.includes(id)) changed.add(id); }
      for (const id of [...this.cards.keys()]) if (!seen.has(id)) this.cards.delete(id);
      this.fails = 0;
      this.lastErr = "";
      if (this.st !== "ok") { this.st = "ok"; this.log("agent-canvas reachable"); ids.forEach((i) => changed.add(i)); }
    } catch (e) {
      this.fails++;
      const msg = (e as Error).message || String(e);
      if (msg !== this.lastErr) this.log(`agent-canvas unreachable at ${base}: ${msg}`);
      this.lastErr = msg;
      // the cache is kept (not shown while down) so the page is whole again the moment the canvas is back
      this.setStatus("down", ids);
      return;
    }
    if (changed.size) this.o.onChange([...changed]);
  }

  private setStatus(s: CanvasStatus, ids: string[]): void {
    if (this.st === s) return;
    this.st = s;
    this.o.onChange(ids);
  }
}

/** One agent's summary straight from agent-canvas (the finish gate's needs-you bounce). Null when there is none or it is unreachable. */
export async function fetchSummary(base: string, agentId: string, f: FetchLike = (globalThis as any).fetch): Promise<(FmSummary & { lastRejection?: unknown }) | null> {
  const url = base.trim().replace(/\/+$/, "");
  if (!url || !/^[\w-]+$/.test(agentId)) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await f(`${url}/api/fm/summary?agents=${encodeURIComponent(agentId)}`, { signal: ac.signal });
    if (!r.ok) return null;
    const list = (await r.json())?.agents;
    return Array.isArray(list) ? list.find((s: FmSummary) => s?.agentId === agentId) ?? null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
