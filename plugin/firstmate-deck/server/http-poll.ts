// Comment checks over HTTP. Lavish's `lavish-axi poll` is one long GET /api/poll?file=<page> on the Lavish server, which
// answers only when the captain comments (or ends the session, or the browser stays disconnected). The plugin makes that
// request itself, so there is no guard process and no lavish-axi process per page (about 176 MB each). If the plugin dies
// the connection closes and Lavish frees the listener and requeues anything it had not delivered, so the guard has no job.
// The old CLI path stays as the fallback: after FAIL_LIMIT transport errors in a row the page's poller uses it for COOLDOWN_MS.
import { realpathSync } from "node:fs";
import { decodePoll } from "./toon.ts";
import type { PollRun } from "./lavish.ts";

/** Prefix of a stdout that carries a JSON document built from an HTTP answer instead of the CLI's TOON. */
export const HTTP_MARK = "#http-json\n";
export const FAIL_LIMIT = 3;
export const COOLDOWN_MS = 10 * 60_000;

/**
 * Turn one /api/poll answer into the document shape `classifyPoll` already understands (what the CLI prints):
 * `session.status`, `prompts`, or an `error` + `code`.
 */
export function httpDoc(status: number, body: any): any {
  if (!body || typeof body !== "object") return { error: `Lavish answered ${status} with no usable body` };
  if (status === 409 || body.code === "LISTENER_ACTIVE") {
    const h = body.holder;
    const where = h && typeof h.label === "string" ? ` (current listener: ${h.label}; active for ${Math.max(0, Number(h.age_ms) || 0)}ms)` : "";
    return { code: body.code ?? "LISTENER_ACTIVE", error: `${body.error ?? "Lavish already has an active poll listener"}${where}` };
  }
  if (status < 200 || status >= 300 || body.status === "error" || body.status === "missing") {
    return { error: String(body.error ?? `Lavish answered ${status}${body.status ? ` (${body.status})` : ""}`), code: body.code };
  }
  const session: Record<string, unknown> = { status: String(body.status ?? "waiting") };
  if (body.session_ended) session.session_ended = true;
  if (body.ended_by) session.ended_by = String(body.ended_by);
  const doc: Record<string, unknown> = { session };
  if (Array.isArray(body.prompts)) doc.prompts = body.prompts;
  return doc;
}

export type HttpPollOpts = { port?: string | number; host?: string; signal: AbortSignal; fetch?: typeof fetch };

/**
 * One long poll over HTTP. Resolves (never rejects): code 0 with a marked JSON document, or code -1 for a transport
 * failure (refused, reset, aborted). No `owner` is sent: an owned poll shows a permanent "Working..." bubble on the page.
 */
export async function httpPoll(page: string, o: HttpPollOpts): Promise<PollRun> {
  let file: string;
  try { file = realpathSync(page); } catch (e) { return { code: -1, stdout: `cannot resolve ${page}: ${(e as Error).message}` }; }
  const base = `http://${o.host ?? "127.0.0.1"}:${o.port ?? 4387}`;
  try {
    const res = await (o.fetch ?? fetch)(`${base}/api/poll?file=${encodeURIComponent(file)}`, { signal: o.signal });
    const text = await res.text(); // Lavish streams a space every 15 s as a heartbeat, then the JSON
    let body: unknown;
    try { body = JSON.parse(text.trim()); } catch { body = null; }
    return { code: 0, stdout: HTTP_MARK + JSON.stringify(httpDoc(res.status, body)) };
  } catch (e) {
    return { code: -1, stdout: String((e as Error).message ?? e) };
  }
}

export type PollSourceOpts = {
  http: () => Promise<PollRun>;
  cli: () => Promise<PollRun>;
  now?: () => number;
  log?: (m: string) => void;
  failLimit?: number;
  cooldownMs?: number;
  /** Never use the other path (tests, and the `FM_DECK_POLL_MODE` escape hatch). */
  force?: "http" | "cli";
  lavishBin?: string;
};

/** Chooses, per poll, between the HTTP request and the lavish-axi CLI. Decodes both outputs. */
export class PollSource {
  mode: "http" | "cli";
  private fails = 0;
  private cliSince = 0;
  private o: Required<Pick<PollSourceOpts, "failLimit" | "cooldownMs">> & PollSourceOpts;
  constructor(o: PollSourceOpts) {
    this.o = { failLimit: FAIL_LIMIT, cooldownMs: COOLDOWN_MS, ...o };
    this.mode = o.force ?? "http";
  }
  private now() { return (this.o.now ?? Date.now)(); }
  private log(m: string) { this.o.log?.(m); }

  async run(): Promise<PollRun> {
    const o = this.o;
    if (o.force === "cli") return o.cli();
    if (this.mode === "cli" && !o.force && this.now() - this.cliSince >= o.cooldownMs) {
      this.log("trying HTTP polling again");
      this.mode = "http";
      this.fails = 0;
    }
    if (this.mode === "cli") return o.cli();
    const r = await o.http();
    if (r.code !== -1) { this.fails = 0; return r; }
    if (o.force) return r;
    if (++this.fails < o.failLimit) return r;
    this.log(`HTTP polling failed ${this.fails} times in a row (${r.stdout.slice(0, 120)}); using the lavish-axi CLI for ${Math.round(o.cooldownMs / 60000)} min`);
    this.mode = "cli";
    this.cliSince = this.now();
    return o.cli();
  }

  decode(stdout: string): Promise<any> {
    if (stdout.startsWith(HTTP_MARK)) return Promise.resolve(JSON.parse(stdout.slice(HTTP_MARK.length)));
    return decodePoll(stdout, this.o.lavishBin);
  }
}

