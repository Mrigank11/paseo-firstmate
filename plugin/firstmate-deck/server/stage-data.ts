// Stage rows for the CLI: the SAME computeStage() the page uses, fed from Paseo's agent files on disk plus one `paseo ls`,
// with no daemon connection and no plugin. Used by stage-cli.ts (bin/fleet stage/stages) and page-tool.ts (bin/page status).
// Env: PASEO_HOME (default ~/.paseo) names the daemon; STAGE_AGENTS_JSON (a file of agent records) replaces the lookup (tests).
// The agent files are daemon-internal; their shape was checked on Paseo 0.12.0 (the plugin pins >=0.12 <0.13). If they are
// missing, each task falls back to `paseo ls -a -g --label fm.task=<id>`. The last message of an agent is not on the CLI path,
// so a finished agent shows as Idle, never guessed to have no DONE: line.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { computeStage, type Stage, type StageAgent } from "./stage.ts";
import { loadAllLive, type Task } from "./state.ts";

export type Rec = { id: string; task: string; status: string; archived: boolean; createdAt: string | null; lastActivityAt: string | null; pending: number };


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
  const status = new Map<string, string>(paseoLs(["ls", "-g"]).map((a) => [String(a.id), String(a.status)]));
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
      out.push({
        id: a.id, task, archived, createdAt: a.createdAt ?? null, lastActivityAt: a.lastActivityAt ?? a.updatedAt ?? null,
        status: status.get(a.id) ?? a.lastStatus ?? "unknown", pending: a.requiresAttention && a.attentionReason === "permission" ? 1 : 0,
      });
    }
  }
  return out;
}

const toAgent = (r: Rec): StageAgent => ({ id: r.id, status: r.status, archived: r.archived, createdAt: r.createdAt, lastActivityAt: r.lastActivityAt, pendingPermissions: r.pending });

export type Row = { id: string; project: string | null; state: string; stage: string; group: string; agentId: string | null; flags: Stage["flags"]; note?: string };

export function rowOf(t: Task, recs: Rec[], now: Date): Row {
  const mine = recs.filter((r) => r.task === t.id).map(toAgent);
  // a v1 task whose agent carries no label yet: the recorded agentId stands in, as it does on the page
  if (!mine.length && t.agentId) {
    const hit = recs.find((r) => r.id === t.agentId);
    mine.push(hit ? toAgent(hit) : { id: t.agentId, status: "unknown", archived: false, pendingPermissions: 0 });
  }
  const s = computeStage(t, mine, now, { finalKnown: false });
  return { id: t.id, project: t.project ?? null, state: t.state, stage: s.stage, group: s.group, agentId: s.agentId, flags: s.flags, ...(s.stage === "Idle" ? { note: "final line unknown on CLI" } : {}) };
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
  return { id, project: hit.project ?? null, state: failed ? "failed" : "done", stage: failed ? "Failed" : "Done", group: "done", agentId: hit.agents?.at?.(-1) ?? hit.agentId ?? null, flags: [], note: "archived" };
}

export function table(rows: Row[]): string {
  const head = ["TASK", "PROJECT", "STATE", "STAGE", "AGENT", "FLAGS"];
  const body = rows.map((r) => [r.id, r.project ?? "-", r.state, r.stage + (r.note ? ` (${r.note})` : ""), r.agentId?.slice(0, 8) ?? "-", r.flags.map((f) => (f.drift ? "!" : "") + f.key).join(",") || "-"]);
  const w = head.map((_, i) => Math.max(head[i].length, ...body.map((b) => b[i].length)));
  return [head, ...body].map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd()).join("\n");
}

export function stages(root: string, project?: string): Row[] {
  const tasks = loadAllLive(root).filter((t) => !project || t.project === project);
  if (!tasks.length) return [];
  const recs = labelledAgents(tasks.map((t) => t.id));
  const now = new Date();
  return tasks.map((t) => rowOf(t, recs, now));
}

