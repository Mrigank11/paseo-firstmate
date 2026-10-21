// Thin wrapper over the `paseo` CLI, always pinned to this plugin's own daemon (--home).
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { human, parseStep } from "./humanize.ts";
import type { AgentView } from "./render.ts";

export type Exec = (args: string[], timeoutMs?: number) => Promise<string>;

/** The daemon home this plugin process belongs to: PASEO_HOME, else the parent daemon's environment. */
export function detectHome(): string | undefined {
  if (process.env.PASEO_HOME) return process.env.PASEO_HOME;
  try {
    const env = readFileSync(`/proc/${process.ppid}/environ`, "utf8").split("\0");
    const v = env.find((e) => e.startsWith("PASEO_HOME="));
    if (v) return v.slice("PASEO_HOME=".length);
  } catch {}
  return undefined;
}

function paseoBin(): string {
  if (process.env.PASEO_BIN) return process.env.PASEO_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "paseo"))) return join(dir, "paseo");
  for (const p of [join(homedir(), ".local/share/pnpm/paseo"), join(homedir(), ".local/bin/paseo"), "/usr/local/bin/paseo"]) if (existsSync(p)) return p;
  return "paseo";
}

export function makeExec(home: string | undefined): Exec {
  const bin = paseoBin();
  // Never inherit an agent scope: sends must come from the plugin, not from whichever agent started the daemon.
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;
  return (args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const full = home ? [...args, "--home", home] : args;
      execFile(bin, full, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) => {
        if (err) reject(new Error(`paseo ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
        else resolve(stdout);
      });
    });
}

export type ListedAgent = { id: string; name?: string; status: string };

export class AgentSource {
  private listCache: { at: number; map: Map<string, ListedAgent>; pending?: Promise<Map<string, ListedAgent>> } | null = null;
  private views = new Map<string, { status: string; view: AgentView }>();
  private exec: Exec;
  private ttlMs: number;
  constructor(exec: Exec, ttlMs = 1500) {
    this.exec = exec;
    this.ttlMs = ttlMs;
  }

  /** Forget what we know about an agent (a turn started or ended, it was archived, ...). */
  invalidate(agentId: string): void {
    this.views.delete(agentId);
    this.listCache = null;
  }

  /** Last view built for an agent, however old; undefined when none was ever built. */
  peek(agentId: string): AgentView | undefined {
    return this.views.get(agentId)?.view;
  }

  peekStatus(agentId: string): string {
    return this.listCache?.map.get(agentId)?.status ?? this.views.get(agentId)?.status ?? "unknown";
  }

  async list(): Promise<Map<string, ListedAgent>> {
    const c = this.listCache;
    if (c?.pending) return c.pending;
    if (c && Date.now() - c.at < this.ttlMs) return c.map;
    const pending = this.exec(["ls", "-a", "--json"]).then((out) => {
      const map = new Map<string, ListedAgent>();
      for (const a of JSON.parse(out || "[]")) map.set(a.id, { id: a.id, name: a.name, status: String(a.status) });
      this.listCache = { at: Date.now(), map };
      return map;
    });
    this.listCache = { at: c?.at ?? 0, map: c?.map ?? new Map(), pending };
    try {
      return await pending;
    } catch (e) {
      this.listCache = c;
      throw e;
    }
  }

  /** Build the AgentView for one agent. Cached while its status is unchanged and it is not running. */
  async view(agentId: string, listed: Map<string, ListedAgent>): Promise<AgentView> {
    const status = listed.get(agentId)?.status ?? "unknown";
    const active = status === "running" || status === "initializing";
    const hit = this.views.get(agentId);
    if (hit && hit.status === status && !active) return hit.view;
    let meta: any = {};
    try { meta = JSON.parse((await this.exec(["inspect", agentId, "--json"])) || "{}"); } catch {}
    let log: string[] = [];
    try { log = (await this.exec(["logs", agentId])).split("\n"); } catch {}
    const steps = log.map(parseStep).filter((x): x is [string, string] => !!x);
    const final = [...log].reverse().find((l) => l.startsWith("DONE:") || l.startsWith("BLOCKED:"));
    const view: AgentView = {
      status: (meta.Archived ? "archived" : status) as AgentView["status"],
      createdAt: meta.CreatedAt || undefined,
      updatedAt: meta.UpdatedAt || undefined,
      model: meta.Model || undefined,
      thinking: meta.Thinking || undefined,
      stepCount: steps.length,
      recent: steps.slice(-8).map(([t, x]) => human(t, x)),
      final,
    };
    this.views.set(agentId, { status, view });
    return view;
  }
}

// ---------- the first mate ----------

export type FirstMate = { id: string; status: string };

export const NO_CLAIM_MESSAGE = "No first mate claimed this checkout: run bin/page claim in the first mate's session";

/** Thrown when there is nobody to deliver to: no claim and no usable label. The banner says how to fix it. */
export class NoFirstMateError extends Error {
  constructor() { super(NO_CLAIM_MESSAGE); this.name = "NoFirstMateError"; }
}

/** Agent ids that fleet.json or the archive lists as crew: they are never the first mate. */
export function crewAgentIds(root: string): Set<string> {
  const ids = new Set<string>();
  const state = join(root, "state");
  try {
    for (const t of JSON.parse(readFileSync(join(state, "fleet.json"), "utf8"))?.tasks ?? []) if (t?.agentId) ids.add(String(t.agentId));
  } catch {}
  try {
    for (const line of readFileSync(join(state, "fleet-archive.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); if (t?.agentId) ids.add(String(t.agentId)); } catch {}
    }
  } catch {}
  return ids;
}

/** The agent id `bin/page claim` recorded in state/firstmate.json, if any. */
export function claimedId(root: string): string | null {
  try {
    const id = JSON.parse(readFileSync(join(root, "state", "firstmate.json"), "utf8"))?.agentId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * The first mate, decided by explicit facts only (no guessing from working directories):
 *   1. the agent `bin/page claim` recorded in state/firstmate.json, if it still exists and is not archived;
 *   2. else the newest live agent carrying the first-mate label, EXCLUDING every agent id fleet.json or the
 *      archive lists as crew;
 *   3. else null.
 * Never writes a label. Re-resolved on every use.
 */
export async function resolveFirstMate(exec: Exec, label: string, root?: string): Promise<FirstMate | null> {
  const claim = root ? claimedId(root) : null;
  if (claim) {
    const all: any[] = JSON.parse((await exec(["ls", "-g", "--json"])) || "[]"); // archived agents are not listed
    const hit = all.find((a) => String(a.id) === claim);
    if (hit) return { id: String(hit.id), status: String(hit.status) };
  }
  const crew = root ? crewAgentIds(root) : new Set<string>();
  const list: any[] = (JSON.parse((await exec(["ls", "-g", "--label", label, "--json"])) || "[]") as any[]).filter((a) => !crew.has(String(a.id)));
  if (!list.length) return null;
  return newest(exec, list);
}

async function newest(exec: Exec, list: any[]): Promise<FirstMate> {
  const rated = await Promise.all(
    list.map(async (a) => {
      let created = 0;
      if (list.length > 1) {
        try { created = Date.parse(JSON.parse(await exec(["inspect", a.id, "--json"])).CreatedAt) || 0; } catch {}
      }
      return { id: String(a.id), status: String(a.status), created };
    }),
  );
  // A closed agent is a worse target than a live one, whatever its age.
  rated.sort((a, b) => Number(b.status !== "closed") - Number(a.status !== "closed") || b.created - a.created);
  return { id: rated[0].id, status: rated[0].status };
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

async function sendTo(exec: Exec, id: string, message: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "deck-send-"));
  const file = join(dir, "message.md");
  try {
    writeFileSync(file, message);
    await exec(["send", id, "--no-wait", "--behavior", "steer", "--prompt-file", file], 30_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `paseo send <firstMate> --no-wait --behavior steer --prompt-file <tmp>`; resolves to the agent id used.
 * `early` is a first-mate lookup started a moment ago (while the batch window was open); if sending to it
 * fails, the first mate is resolved afresh and the send retried once.
 */
export async function sendToFirstMate(exec: Exec, label: string, message: string, early?: Promise<FirstMate | null>, root?: string): Promise<string> {
  let fm: FirstMate | null = null;
  if (early) { try { fm = await early; } catch {} }
  if (fm) {
    try {
      await sendTo(exec, fm.id, message);
      return fm.id;
    } catch {}
  }
  fm = await resolveFirstMate(exec, label, root);
  if (!fm) throw new NoFirstMateError();
  await sendTo(exec, fm.id, message);
  return fm.id;
}
