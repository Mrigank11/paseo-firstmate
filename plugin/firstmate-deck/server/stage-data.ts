// Stage rows for the CLI: the SAME computeStage() the page uses, fed from Paseo's agent files on disk plus one `paseo ls`,
// with no daemon connection and no plugin. Used by stage-cli.ts (bin/fleet stage/stages) and page-tool.ts (bin/page status).
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
import { activeSinceOf, computeStage, currentAgent, type Stage, type StageAgent } from "./stage.ts";
import { archivedChildren, loadAllLive, type Task } from "./state.ts";
import { cardMarkdown, withRollups } from "./tree.ts";
import { canvasInput } from "./canvas-view.ts";
import type { FmSummary } from "./canvas-port.ts";
import { freshSnapshot, type StageRow } from "./stages-file.ts";

export type Rec = { id: string; task: string; status: string; archived: boolean; createdAt: string | null; lastActivityAt: string | null; pending: number; labels?: Record<string, string>; relayGone?: string };


const home = () => process.env.PASEO_HOME || join(homedir(), ".paseo");

function paseoLs(args: string[]): any[] {
  const h = process.env.PASEO_HOME;
  try {
    return JSON.parse(execFileSync(process.env.PASEO_BIN || "paseo", [...args, "--json", ...(h ? ["--home", h] : [])], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }) || "[]");
  } catch (e) {
    throw new Error(`cannot ask the Paseo daemon (paseo ${args.join(" ")}): ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Every agent carrying an fm.task label: status from one `paseo ls`, labels and archive state from the agent files. */
export function labelledAgents(taskIds: string[]): Rec[] {
  const fake = process.env.STAGE_AGENTS_JSON;
  if (fake) return JSON.parse(readFileSync(fake, "utf8"));
  const dir = join(home(), "agents");
  if (!existsSync(dir)) {
    // no agent files to read: ask per task (labels are not in the CLI output, so the filter is the label)
    return taskIds.flatMap((task) => paseoLs(["ls", "-a", "-g", "--label", `fm.task=${task}`]).map((a): Rec => ({
      id: String(a.id), task, status: String(a.status), archived: false, createdAt: null, lastActivityAt: null, pending: 0,
    })));
  }
  const status = new Map<string, string>(paseoLs(["ls", "-g", "--background"]).map((a) => [String(a.id), String(a.status)]));
  const out: Rec[] = [];
  for (const sub of readdirSync(dir)) {
    let files: string[] = [];
    try { files = readdirSync(join(dir, sub)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      let a: any;
      try { a = JSON.parse(readFileSync(join(dir, sub, f), "utf8")); } catch { continue; }
      const task = a?.labels?.["fm.task"];
      if (typeof task !== "string" || !task || typeof a.id !== "string") continue;
      const archived = !!a.archivedAt;
      const relay = a.labels?.["canvas.relay"];
      out.push({
        labels: a.labels, ...(typeof relay === "string" && relay && !archived && !status.has(relay) ? { relayGone: relay } : {}),
        id: a.id, task, archived, createdAt: a.createdAt ?? null, lastActivityAt: a.lastActivityAt ?? a.updatedAt ?? null,
        status: status.get(a.id) ?? a.lastStatus ?? "unknown", pending: a.requiresAttention && a.attentionReason === "permission" ? 1 : 0,
      });
    }
  }
  return out;
}

const toAgent = (r: Rec): StageAgent => ({ id: r.id, status: r.status, archived: r.archived, createdAt: r.createdAt, lastActivityAt: r.lastActivityAt, pendingPermissions: r.pending, relayGone: r.relayGone });

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
  return {
    id: t.id, project: t.project ?? null, ...(t.parent ? { parent: t.parent } : {}), ...(t.kind ? { kind: t.kind } : {}), state: t.state, stage: s.stage, group: s.group, agentId: s.agentId, flags: s.flags,
    owner: s.owner, reason: s.reason, clears: s.clears, fp: s.fp, source: "local",
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
  const body = rows.map((r) => [r.id, r.project ?? "-", r.state, r.stage + (r.note ? ` (${r.note})` : ""), r.owner, r.agentId?.slice(0, 8) ?? "-", r.flags.map((f) => (f.drift ? "!" : "") + f.key).join(",") || "-"]);
  const w = head.map((_, i) => Math.max(head[i].length, ...body.map((b) => b[i].length)));
  const lines = [head, ...body].map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
  // a running task's canvas verdict and BLUF, so "status?" needs no chat: an indented line under its row
  const out = lines.flatMap((l, i) => (i && rows[i - 1].canvas ? [l, `    canvas · ${rows[i - 1].canvas!.verdict}${rows[i - 1].canvas!.bluf ? ` · ${rows[i - 1].canvas!.bluf}` : ""}`] : [l]));
  if (rows.some((r) => r.source === "local")) out.push("(degraded: no fresh plugin snapshot, so this was computed locally without comments or last messages and may differ from the page)");
  return out.join("\n");
}

/** The plugin's snapshot rows for the live tasks that still exist (its source is the same engine the page uses), else a local computation. */
export function stages(root: string, project?: string): Row[] {
  const tasks = loadAllLive(root).filter((t) => !project || t.project === project);
  if (!tasks.length) return [];
  const snap = freshSnapshot(root, Number(process.env.STAGE_SNAPSHOT_WAIT_MS ?? 4000));
  if (snap) {
    const by = new Map(snap.rows.map((r) => [r.id, r]));
    if (tasks.every((t) => by.has(t.id))) return tasks.map((t) => ({ ...by.get(t.id)!, source: "plugin" as const }));
  }
  const recs = labelledAgents(tasks.map((t) => t.id));
  const canvas = canvasSummaries(root, recs.filter((r) => !r.archived).map((r) => r.id));
  const now = new Date();
  // a group's stage rolls up from its leaves, so the leaves are read even when only one project was asked for
  return withRollups(tasks.map((t) => rowOf(t, recs, now, canvas)), archivedChildren(root, new Set(tasks.filter((t) => t.kind === "group").map((t) => t.id))));
}

/** The rollup of one group (stage-cli `rollup`): its row, each child's row, and the card text rebuilt from them. */
export function rollupOf(root: string, id: string): { row: Row; children: Row[]; markdown: string } | null {
  const rows = stages(root);
  const row = rows.find((r) => r.id === id);
  if (!row || row.kind !== "group") return null;
  const tasks = loadAllLive(root);
  const name = (x: string) => { const t = tasks.find((y) => y.id === x); return (t?.title || t?.intent || x).replace(/\s+/g, " "); };
  const direct = rows.filter((r) => r.parent === id);
  return { row, children: direct, markdown: cardMarkdown(row, rows, name, archivedChildren(root, new Set(tasks.filter((t) => t.kind === "group").map((t) => t.id)))) };
}

/** One live task's row: the snapshot's, else local. Null when the task is not live. */
export function stageRow(root: string, id: string): Row | null {
  const t = loadAllLive(root).find((x) => x.id === id);
  if (!t) return null;
  return stages(root).find((r) => r.id === id) ?? null;
}
