// Stage rows for the CLI: the SAME computeStage() the page uses, fed from Paseo's agent files on disk plus one `paseo ls`
// (and, for the other hosts of `paseo host ls`, their crews through host-cli.ts), with no daemon connection and no plugin.
// Used by stage-cli.ts (bin/fleet stage/stages), page-tool.ts (bin/page status) and canvas-cmd.ts.
// Env: PASEO_HOME (default ~/.paseo) names the daemon; STAGE_AGENTS_JSON (a file of agent records) replaces the lookup (tests).
// The agent files are daemon-internal; their shape was checked on Paseo 0.12.0 (the plugin pins >=0.12 <0.13). If they are
// missing, each task falls back to `paseo ls -a -g --label fm.task=<id>`. The last message of an agent is not on the CLI path,
// so a finished agent shows as Idle, never guessed to have no DONE: line.
// The crew's canvases (agent-canvas `/api/fm/summary`, loopback) feed the same stage engine as on the page: the URL is AGENT_CANVAS_URL,
// else the `canvasUrl` the deck stamped into state/projects/*/page.json; STAGE_CANVAS_JSON (a file of summaries) replaces the lookup
// (tests). An unreachable canvas is not an error: the rows are then the registry's and Paseo's alone.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activeSinceOf, computeStage, currentAgent, type HostOffline, type StageAgent } from "./stage.ts";
import { loadAllLive, type Task } from "./state.ts";
import { canvasInput } from "./canvas-view.ts";
import type { FmSummary } from "./canvas-port.ts";
import { freshSnapshot, type StageRow } from "./stages-file.ts";
import { readRemote } from "./host-cli.ts";
import { daemonServerId } from "./ownership.ts";
import { readRemoteStore, remoteRecords } from "./remote-store.ts";
import { makeExec } from "./paseo-cli.ts";

export type Rec = { id: string; task: string; status: string; archived: boolean; createdAt: string | null; lastActivityAt: string | null; pending: number; labels?: Record<string, string>; relayGone?: string; host?: string; serverId?: string; hostOffline?: HostOffline };


const home = () => process.env.PASEO_HOME || join(homedir(), ".paseo");

function paseoLs(args: string[]): any[] {
  const h = process.env.PASEO_HOME;
  try {
    return JSON.parse(execFileSync(process.env.PASEO_BIN || "paseo", [...args, "--json", ...(h ? ["--home", h] : [])], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }) || "[]");
  } catch (e) {
    throw new Error(`cannot ask the Paseo daemon (paseo ${args.join(" ")}): ${(e as Error).message.split("\n")[0]}`);
  }
}

const fakeAgents = (): Rec[] | null => (process.env.STAGE_AGENTS_JSON ? JSON.parse(readFileSync(process.env.STAGE_AGENTS_JSON, "utf8")) : null);

/**
 * This daemon's agents carrying an fm.task label: status from one `paseo ls`, labels and archive state from the agent files.
 * `status` (every live agent id -> status) and `ids` (every agent file) are null without agent files.
 */
function localAgents(taskIds: string[]): { recs: Rec[]; status: Map<string, string> | null; ids: Set<string> | null } {
  const dir = join(home(), "agents");
  if (!existsSync(dir)) {
    // no agent files to read: ask per task (labels are not read here, so the filter is the label)
    const recs = taskIds.flatMap((task) => paseoLs(["ls", "-a", "-g", "--label", `fm.task=${task}`]).map((a): Rec => ({
      id: String(a.id), task, status: String(a.status), archived: false, createdAt: null, lastActivityAt: null, pending: 0,
    })));
    return { recs, status: null, ids: null };
  }
  const status = new Map<string, string>(paseoLs(["ls", "-g", "--background"]).map((a) => [String(a.id), String(a.status)]));
  const out: Rec[] = [];
  const ids = new Set<string>();
  for (const sub of readdirSync(dir)) {
    let files: string[] = [];
    try { files = readdirSync(join(dir, sub)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      let a: any;
      try { a = JSON.parse(readFileSync(join(dir, sub, f), "utf8")); } catch { continue; }
      if (typeof a?.id !== "string") continue;
      ids.add(a.id);
      const task = a.labels?.["fm.task"];
      if (typeof task !== "string" || !task) continue;
      const archived = !!a.archivedAt;
      const relay = a.labels?.["canvas.relay"];
      out.push({
        labels: a.labels, ...(typeof relay === "string" && relay && !archived && !status.has(relay) ? { relayGone: relay } : {}),
        id: a.id, task, archived, createdAt: a.createdAt ?? null, lastActivityAt: a.lastActivityAt ?? a.updatedAt ?? null,
        status: status.get(a.id) ?? a.lastStatus ?? "unknown", pending: a.requiresAttention && a.attentionReason === "permission" ? 1 : 0,
      });
    }
  }
  return { recs: out, status, ids };
}

/** `local` plus the crews of every other host (remembered under `root` for when a host is away). */
async function withRemote(root: string, taskIds: string[], local: ReturnType<typeof localAgents>): Promise<Rec[]> {
  const { records } = await readRemote(makeExec(process.env.PASEO_HOME || undefined), { root, tasks: new Set(taskIds) });
  const mine = new Set(local.recs.map((r) => r.id));
  const others = records.filter((r) => !mine.has(r.id));
  const live = new Set(others.filter((r) => !r.archived).map((r) => r.id));
  return [...local.recs, ...others.map((r): Rec => {
    const relay = r.labels?.["canvas.relay"];
    return { ...r, ...(local.status && relay && !r.archived && !r.hostOffline && !local.status.has(relay) && !live.has(relay) ? { relayGone: relay } : {}) };
  })];
}

/** Every agent carrying an fm.task label, on this daemon, and ours (ownership.ts) on every other host. `taskIds`: the tasks being asked about. */
export async function labelledAgents(root: string, taskIds: string[]): Promise<Rec[]> {
  return fakeAgents() ?? withRemote(root, taskIds, localAgents(taskIds));
}

/**
 * `labelledAgents` without a call to another host: their crews as last seen (the plugin keeps that current). One live read of the
 * other hosts takes seconds, and longer when one is asleep, while `bin/fleet` allows a canvas snapshot 5 s.
 */
export function rememberedAgents(root: string, taskIds: string[]): Rec[] {
  const fake = fakeAgents();
  if (fake) return fake;
  const local = localAgents(taskIds).recs;
  const mine = new Set(local.map((r) => r.id));
  return [...local, ...remoteRecords(readRemoteStore(root, daemonServerId())).filter((r) => !mine.has(r.id))];
}

/** What `--host` accepts for our agent `id` on another host that is online; "" for any other agent. */
export async function hostTarget(root: string, id: string): Promise<string> {
  const { records, others, targets } = await readRemote(makeExec(process.env.PASEO_HOME || undefined), { root, tasks: new Set() });
  const hit = records.find((r) => r.id === id && !r.hostOffline) ?? others.find((a) => a.id === id);
  return (hit?.serverId && targets.get(hit.serverId)) || "";
}

/** The fm.task label of an agent, "" when it has none. Other hosts are asked only about an agent this daemon does not have. */
export async function taskOf(root: string, id: string): Promise<string> {
  const find = (recs: Rec[]) => recs.find((r) => r.id === id)?.task ?? "";
  const fake = fakeAgents();
  if (fake) return find(fake);
  const local = localAgents([]);
  return local.ids?.has(id) ? find(local.recs) : find(await withRemote(root, [], local));
}

const toAgent = (r: Rec): StageAgent => ({ id: r.id, status: r.status, archived: r.archived, createdAt: r.createdAt, lastActivityAt: r.lastActivityAt, pendingPermissions: r.pending, relayGone: r.relayGone, host: r.host, hostOffline: r.hostOffline });

export type Row = StageRow;

/** agent-canvas's base URL, or "" when none is configured. */
export function canvasUrl(root: string): string {
  const env = (process.env.AGENT_CANVAS_URL ?? "").trim();
  if (env) return env === "off" ? "" : env;
  try {
    for (const p of readdirSync(join(root, "state", "projects"))) {
      try {
        const u = JSON.parse(readFileSync(join(root, "state", "projects", p, "page.json"), "utf8")).canvasUrl;
        if (typeof u === "string" && u) return u;
      } catch {}
    }
  } catch {}
  return "";
}

/** Summaries of `agentIds` straight from agent-canvas (one short curl; a soft failure is `{}`). */
export function canvasSummaries(root: string, agentIds: string[]): Record<string, FmSummary> {
  const fake = process.env.STAGE_CANVAS_JSON;
  if (fake) { try { return JSON.parse(readFileSync(fake, "utf8")); } catch { return {}; } }
  const base = canvasUrl(root).replace(/\/+$/, "");
  const ids = [...new Set(agentIds)].filter((id) => /^[\w-]+$/.test(id));
  if (!base || !ids.length) return {};
  try {
    const body = execFileSync("curl", ["-s", "-m", "3", "--fail", `${base}/api/fm/summary?agents=${ids.join(",")}`], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const list: FmSummary[] = JSON.parse(body)?.agents ?? [];
    return Object.fromEntries(list.filter((s) => s && typeof s.agentId === "string").map((s) => [s.agentId, s]));
  } catch { return {}; }
}

export function rowOf(t: Task, recs: Rec[], now: Date, canvas: Record<string, FmSummary> = {}): Row {
  const mine = recs.filter((r) => r.task === t.id).map(toAgent);
  const cur = currentAgent(mine);
  const sum = cur && !cur.archived ? canvas[cur.id] : undefined;
  const s = computeStage(t, mine, now, { finalKnown: false, canvas: canvasInput(sum, t.id, [], activeSinceOf(cur)) });
  const host = mine.find((a) => a.id === s.agentId)?.host;
  return {
    id: t.id, project: t.project ?? null, state: t.state, stage: s.stage, group: s.group, agentId: s.agentId, flags: s.flags,
    owner: s.owner, reason: s.reason, clears: s.clears, fp: s.fp, source: "local", ...(host ? { host } : {}),
    ...(s.stage === "Idle" ? { note: "final line unknown on CLI" } : {}),
    ...(sum ? { canvas: { verdict: sum.verdict.label, bluf: sum.bluf.replace(/\s+/g, " ").slice(0, 80), asks: sum.openAsks.length } } : {}),
  };
}

export function archiveRow(root: string, id: string): Row | null {
  let hit: any = null;
  try {
    for (const line of readFileSync(join(root, "state", "fleet-archive.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); if (t?.id === id) hit = t; } catch {}
    }
  } catch { return null; }
  if (!hit) return null;
  const failed = hit.outcome === "failed" || hit.status === "failed";
  return { id, project: hit.project ?? null, state: failed ? "failed" : "done", stage: failed ? "Failed" : "Done", group: "done", agentId: hit.agents?.at?.(-1) ?? hit.agentId ?? null, flags: [], owner: "nobody", reason: "finished", clears: "", fp: `${failed ? "Failed" : "Done"}|finished|`, note: "archived" };
}

export function table(rows: Row[]): string {
  const head = ["TASK", "PROJECT", "STATE", "STAGE", "OWNER", "AGENT", "FLAGS"];
  const body = rows.map((r) => [r.id, r.project ?? "-", r.state, r.stage + (r.note ? ` (${r.note})` : ""), r.owner, r.agentId ? r.agentId.slice(0, 8) + (r.host ? `@${r.host}` : "") : "-", r.flags.map((f) => (f.drift ? "!" : "") + f.key).join(",") || "-"]);
  const w = head.map((_, i) => Math.max(head[i].length, ...body.map((b) => b[i].length)));
  const lines = [head, ...body].map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
  // a running task's canvas verdict and BLUF, so "status?" needs no chat: an indented line under its row
  const out = lines.flatMap((l, i) => (i && rows[i - 1].canvas ? [l, `    canvas · ${rows[i - 1].canvas!.verdict}${rows[i - 1].canvas!.bluf ? ` · ${rows[i - 1].canvas!.bluf}` : ""}`] : [l]));
  if (rows.some((r) => r.source === "local")) out.push("(degraded: no fresh plugin snapshot, so this was computed locally without comments or last messages and may differ from the page)");
  return out.join("\n");
}

/** The plugin's snapshot rows for the live tasks that still exist (its source is the same engine the page uses), else a local computation. */
export async function stages(root: string, project?: string): Promise<Row[]> {
  const tasks = loadAllLive(root).filter((t) => !project || t.project === project);
  if (!tasks.length) return [];
  const snap = freshSnapshot(root, Number(process.env.STAGE_SNAPSHOT_WAIT_MS ?? 4000));
  if (snap) {
    const by = new Map(snap.rows.map((r) => [r.id, r]));
    if (tasks.every((t) => by.has(t.id))) return tasks.map((t) => ({ ...by.get(t.id)!, source: "plugin" as const }));
  }
  const recs = await labelledAgents(root, tasks.map((t) => t.id));
  const canvas = canvasSummaries(root, recs.filter((r) => !r.archived).map((r) => r.id));
  const now = new Date();
  return tasks.map((t) => rowOf(t, recs, now, canvas));
}

/** One live task's row: the snapshot's, else local. Null when the task is not live. */
export async function stageRow(root: string, id: string): Promise<Row | null> {
  const t = loadAllLive(root).find((x) => x.id === id);
  if (!t) return null;
  return (await stages(root)).find((r) => r.id === id) ?? null;
}
