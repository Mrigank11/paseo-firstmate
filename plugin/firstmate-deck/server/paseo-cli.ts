// The `paseo` CLI behind the PaseoPort interface (CliPort), always pinned to this plugin's own daemon (--home).
// Used for delivery before any SDK handle exists, for `paseo status`, and by nothing that renders.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { human, parseStep } from "./humanize.ts";
import type { AgentView } from "./render.ts";
import type { CommentRowData, PaseoPort, PortAgent } from "./paseo-port.ts";

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

export class CliPort implements PaseoPort {
  readonly kind = "cli" as const;
  private exec: Exec;
  constructor(exec: Exec) {
    this.exec = exec;
  }

  async listAgents(o: { label?: string } = {}): Promise<PortAgent[]> {
    const args = o.label ? ["ls", "-g", "--label", o.label, "--json"] : ["ls", "-g", "--json"]; // archived agents are not listed
    const rows: any[] = JSON.parse((await this.exec(args)) || "[]");
    return Promise.all(rows.map(async (a): Promise<PortAgent> => {
      let createdAt: string | null = null;
      // only a choice between several labelled agents needs the age, so only then pay for `inspect`
      if (o.label && rows.length > 1) {
        try { createdAt = JSON.parse(await this.exec(["inspect", a.id, "--json"])).CreatedAt || null; } catch {}
      }
      return { id: String(a.id), status: String(a.status), labels: {}, createdAt, updatedAt: null, model: null, thinking: null, title: a.name ?? null, archived: false };
    }));
  }

  /** `inspect` + `logs` parsed as text. The deck never renders from this (it has no handle-less rendering); kept for completeness. */
  async agentView(id: string): Promise<AgentView> {
    let meta: any = {};
    try { meta = JSON.parse((await this.exec(["inspect", id, "--json"])) || "{}"); } catch {}
    let log: string[] = [];
    try { log = (await this.exec(["logs", id])).split("\n"); } catch {}
    const steps = log.map(parseStep).filter((x): x is [string, string] => !!x);
    return {
      status: (meta.Archived ? "archived" : String(meta.Status ?? "unknown").toLowerCase()) as AgentView["status"],
      createdAt: meta.CreatedAt || undefined,
      updatedAt: meta.UpdatedAt || undefined,
      model: meta.Model || undefined,
      thinking: meta.Thinking || undefined,
      stepCount: steps.length,
      recent: steps.slice(-8).map(([t, x]) => human(t, x)),
      final: [...log].reverse().find((l) => l.startsWith("DONE:") || l.startsWith("BLOCKED:")),
    };
  }

  /** `paseo send <id> --no-wait --behavior steer --prompt-file <tmp>`: the prompt goes through a file so any text is safe. */
  async send(id: string, text: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "deck-send-"));
    const file = join(dir, "message.md");
    try {
      writeFileSync(file, text);
      await this.exec(["send", id, "--no-wait", "--behavior", "steer", "--prompt-file", file], 30_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The CLI cannot write timeline rows. */
  async appendTimelineRow(): Promise<boolean> {
    return false;
  }
}
