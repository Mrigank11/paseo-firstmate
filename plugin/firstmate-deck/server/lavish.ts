// The plugin's Lavish poll owner: one PagePoller per project page. Speed matters, so the lavish-axi binary
// is resolved once and spawned directly with node (about 160 ms per poll versus about 1 s through npx),
// and the next poll is started before the previous batch is handled.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPoll, decodePoll, type PollOutcome, type Prompt } from "./toon.ts";

// ---------- binary resolution ----------

function versionOf(cli: string): number[] {
  try {
    const pkg = JSON.parse(readFileSync(join(cli, "..", "..", "package.json"), "utf8"));
    return String(pkg.version).split(".").map((n) => parseInt(n, 10) || 0);
  } catch {
    return [0];
  }
}

const cmpVersion = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** Every lavish-axi dist/cli.mjs in the npx cache, best (highest version, then newest) first. */
export function scanNpxCache(home = homedir()): string[] {
  const base = join(home, ".npm", "_npx");
  let dirs: string[] = [];
  try { dirs = readdirSync(base); } catch { return []; }
  return dirs
    .map((d) => join(base, d, "node_modules", "lavish-axi", "dist", "cli.mjs"))
    .filter((p) => existsSync(p))
    .sort((a, b) => cmpVersion(versionOf(b), versionOf(a)) || statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function whichGlobal(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, "lavish-axi");
    try {
      if (existsSync(p)) return realpathSync(p);
    } catch {}
  }
  return null;
}

let cachedBin: string | null = null;
/** Real path of lavish-axi's cli.mjs. Falls back to one `npx -y lavish-axi --version` to populate the cache. */
export async function resolveLavishBin(): Promise<string> {
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  const env = process.env.LAVISH_AXI_BIN;
  if (env && existsSync(env)) return (cachedBin = env);
  const found = () => whichGlobal() ?? scanNpxCache()[0] ?? null;
  let bin = found();
  if (!bin) {
    await new Promise<void>((res) => execFile("npx", ["-y", "lavish-axi", "--version"], { timeout: 180_000 }, () => res()));
    bin = found();
  }
  if (!bin) throw new Error("cannot locate lavish-axi (tried PATH, ~/.npm/_npx, npx)");
  return (cachedBin = bin);
}

// ---------- one poll ----------

export type PollRun = { code: number | null; stdout: string };
export type PollEnv = { LAVISH_AXI_PORT?: string; LAVISH_AXI_STATE_DIR?: string };

export function lavishEnv(e: PollEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LAVISH_AXI_NO_OPEN: "1" };
  if (e.LAVISH_AXI_PORT) env.LAVISH_AXI_PORT = e.LAVISH_AXI_PORT;
  if (e.LAVISH_AXI_STATE_DIR) env.LAVISH_AXI_STATE_DIR = e.LAVISH_AXI_STATE_DIR;
  return env;
}

// ---------- the poll loop ----------

export type PollerHooks = {
  /** Run one poll to completion. Must resolve (never reject) with the exit code and stdout. */
  run: () => Promise<PollRun>;
  decode: (stdout: string) => Promise<any>;
  /** Called with the prompts of a feedback batch, NOT awaited: the next poll is already running. */
  onBatch: (prompts: Prompt[], outcome: PollOutcome) => void | Promise<void>;
  /** The session ended (after its final prompts were passed to onBatch). */
  onEnded: (outcome: PollOutcome) => void | Promise<void>;
  onListener?: (state: "ok" | "active-elsewhere" | "error", detail: string) => void;
  log?: (msg: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
export const LISTENER_RETRY_MS = 30_000;
export const OWN_LISTENER_RETRY_MS = 1000;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal.aborted) return res();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); res(); }
    signal.addEventListener("abort", done);
  });

export class PagePoller {
  private ac = new AbortController();
  private fails = 0;
  private ownRetries = 0;
  private quick = 0;
  done: Promise<void> = Promise.resolve();
  private hooks: PollerHooks;
  private ownerLabel: string;
  constructor(hooks: PollerHooks, ownerLabel = "firstmate-deck") {
    this.hooks = hooks;
    this.ownerLabel = ownerLabel;
  }

  start(): void { this.done = this.loop(); }
  stop(): void { this.ac.abort(); }
  get stopped(): boolean { return this.ac.signal.aborted; }

  private async loop(): Promise<void> {
    const h = this.hooks;
    const sleep = h.sleep ?? defaultSleep;
    const log = h.log ?? (() => {});
    const backoff = async (why: string) => {
      const ms = BACKOFF_MS[Math.min(this.fails, BACKOFF_MS.length - 1)];
      this.fails++;
      log(`poll problem (${why}); retrying in ${ms} ms`);
      h.onListener?.("error", why);
      await sleep(ms, this.ac.signal);
    };
    while (!this.ac.signal.aborted) {
      const t0 = Date.now();
      const r = await h.run();
      if (this.ac.signal.aborted) return;
      let outcome: PollOutcome;
      try {
        outcome = classifyPoll(await h.decode(r.stdout));
      } catch (e) {
        await backoff(`unreadable output (exit ${r.code}): ${(e as Error).message}`);
        continue;
      }
      if (outcome.kind === "listener-active") {
        const own = outcome.holder === this.ownerLabel && this.ownRetries < 10;
        if (own) this.ownRetries++;
        log(`LISTENER_ACTIVE (holder ${outcome.holder ?? "?"}); retry in ${own ? OWN_LISTENER_RETRY_MS : LISTENER_RETRY_MS} ms`);
        h.onListener?.("active-elsewhere", outcome.message ?? "");
        await sleep(own ? OWN_LISTENER_RETRY_MS : LISTENER_RETRY_MS, this.ac.signal);
        continue;
      }
      if (outcome.kind === "error" || (r.code !== 0 && !outcome.prompts.length && outcome.kind !== "ended")) {
        await backoff(outcome.message ?? `exit ${r.code}`);
        continue;
      }
      this.fails = 0;
      this.ownRetries = 0;
      h.onListener?.("ok", "");
      if (outcome.prompts.length) {
        log(`poll returned ${outcome.prompts.length} prompt(s) after ${Date.now() - t0} ms`);
        // Not awaited: the next poll must be waiting before the batch is handled.
        Promise.resolve(h.onBatch(outcome.prompts, outcome)).catch((e) => log(`batch handler failed: ${e}`));
      }
      if (outcome.ended) {
        await h.onEnded(outcome);
        return;
      }
      // browser_disconnected and plain waiting: re-poll immediately (the session is resumable). Only if such
      // a poll came back instantly twice in a row do we space them out, so a misbehaving server cannot spin us.
      if (!outcome.prompts.length && Date.now() - t0 < 1000) {
        if (++this.quick >= 2) await sleep(1000, this.ac.signal);
      } else this.quick = 0;
    }
  }
}

// ---------- real spawning ----------

export type SpawnedPoll = { child: ChildProcess; result: Promise<PollRun> };

const spawned = new Set<ChildProcess>();
/** Kill every poll process this module started (plugin cleanup). */
export function killAllPolls(): void {
  for (const c of spawned) { try { c.kill("SIGTERM"); } catch {} }
  spawned.clear();
}

/**
 * Spawn one `lavish-axi poll`. The result resolves as soon as the document is complete, which is when its
 * `next_step:` line appears (the prompts table always precedes it), NOT when the process exits: the CLI lingers
 * for about a second after printing, and the server has already freed the listener slot by then, so waiting
 * for the exit would add a second to every comment. Error documents have no next_step and resolve on exit.
 */
export function spawnPoll(bin: string, page: string, env: NodeJS.ProcessEnv, owner: string): SpawnedPoll {
  const child = spawn(process.execPath, [bin, "poll", page, "--owner", owner], { env, stdio: ["ignore", "pipe", "pipe"] });
  spawned.add(child);
  let out = "";
  let settle: (r: PollRun) => void = () => {};
  const result = new Promise<PollRun>((res) => (settle = res));
  child.stdout!.on("data", (d) => {
    out += d;
    const i = out.startsWith("next_step:") ? 0 : out.indexOf("\nnext_step:");
    if (i >= 0) settle({ code: 0, stdout: out.slice(0, i + 1) });
  });
  child.stderr!.on("data", () => {});
  child.on("error", () => { spawned.delete(child); settle({ code: -1, stdout: out }); });
  child.on("close", (code) => { spawned.delete(child); settle({ code, stdout: out }); });
  return { child, result };
}

/** Kill a still-alive poll recorded in a pid file, if its command line really is `lavish-axi ... poll <page>`. */
export function killStalePoll(pidFile: string, page: string): boolean {
  let pid = NaN;
  try { pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    if (cmd.includes("lavish-axi") && cmd.includes(" poll ") && cmd.includes(page)) {
      process.kill(pid, "SIGTERM");
      try { unlinkSync(pidFile); } catch {}
      return true;
    }
  } catch {}
  try { unlinkSync(pidFile); } catch {}
  return false;
}

export const writePid = (pidFile: string, pid: number | undefined) => { if (pid) try { writeFileSync(pidFile, String(pid)); } catch {} };
/** Remove the pid file, but only if it still names `pid` (a newer poll may have written its own). */
export const removePid = (pidFile: string, pid?: number) => {
  try {
    if (pid === undefined || readFileSync(pidFile, "utf8").trim() === String(pid)) unlinkSync(pidFile);
  } catch {}
};

export { decodePoll };
