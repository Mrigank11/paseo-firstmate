// The labelled agents before the SDK has a handle (a plugin reload, until the first hook or RPC fires): read from the daemon's
// agent files (labels, archive state, dates) plus one `paseo ls` for the live status. Same source as the stage CLI. Soft: nothing
// readable is an empty list, and the SDK read replaces this as soon as there is a handle.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./paseo-cli.ts";
import type { PortAgent } from "./paseo-port.ts";

/** Agents carrying `key` (any value), archived ones included, from `<agentsDir>/<shard>/<id>.json`. */
export async function coldLabelled(agentsDir: string, key: string, exec: Exec): Promise<PortAgent[]> {
  if (!existsSync(agentsDir)) return [];
  let status = new Map<string, string>();
  try { status = new Map((JSON.parse((await exec(["ls", "-g", "--background", "--json"])) || "[]") as any[]).map((a) => [String(a.id), String(a.status)])); } catch {}
  const out: PortAgent[] = [];
  for (const sub of readdirSync(agentsDir)) {
    let files: string[] = [];
    try { files = readdirSync(join(agentsDir, sub)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      let a: any;
      try { a = JSON.parse(readFileSync(join(agentsDir, sub, f), "utf8")); } catch { continue; }
      if (typeof a?.id !== "string" || !a.labels || typeof a.labels[key] !== "string") continue;
      out.push({
        id: a.id, status: status.get(a.id) ?? a.lastStatus ?? "unknown", labels: a.labels, createdAt: a.createdAt ?? null, updatedAt: a.updatedAt ?? null,
        model: null, thinking: null, title: a.title ?? null, archived: !!a.archivedAt, lastActivityAt: a.lastActivityAt ?? a.updatedAt ?? null,
        pendingPermissions: a.requiresAttention && a.attentionReason === "permission" ? 1 : 0,
      });
    }
  }
  return out;
}
