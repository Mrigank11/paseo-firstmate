// The `paseo` CLI behind the PaseoPort interface (CliPort), pinned to this plugin's own daemon (--home), except for calls
// about a crew on another Paseo host (--host). Used for delivery before any SDK handle exists, for `paseo status`, and by
// nothing that renders.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listHosts, readRemote, toPortAgent, type RemoteRead } from "./host-cli.ts";
import { human, parseStep } from "./humanize.ts";
import type { AgentView } from "./render.ts";
import type { CommentRowData, ListOptions, PaseoPort, PortAgent } from "./paseo-port.ts";
import { readRemoteStore, remoteRecords } from "./remote-store.ts";

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
      // the CLI refuses both: --host names another daemon, --home this one
      const full = home && !args.includes("--host") ? [...args, "--home", home] : args;
      execFile(bin, full, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) => {
        if (err) reject(new Error(`paseo ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
        else resolve(stdout);
      });
    });
}

/** Where a crew on another host lives. */
type Owner = { serverId: string; label: string; target?: string };

/** How long one read of the other hosts serves further calls (the start-up sweep lists once per task). */
const REMOTE_TTL_MS = 3000;

export class CliPort implements PaseoPort {
  readonly kind = "cli" as const;
  private exec: Exec;
  /** The firstmate checkout, when known: where the last-known crews of other hosts are kept. */
  private root: () => string | undefined;
  private owners = new Map<string, Owner>();
  private flight: { at: number; p: Promise<RemoteRead> } | null = null;
  constructor(exec: Exec, o: { root?: string | (() => string | undefined) } = {}) {
    this.exec = exec;
    const root = o.root;
    this.root = typeof root === "function" ? root : () => root;
  }

  /** Every other host's crews (never throws: a host that cannot be read is not a reason to fail the local part). */
  private remote(): Promise<RemoteRead> {
    if (this.flight && Date.now() - this.flight.at < REMOTE_TTL_MS) return this.flight.p;
    const p = readRemote(this.exec, { root: this.root() || undefined })
      .catch((): RemoteRead => ({ records: [], others: [], targets: new Map() }))
      .then((read) => {
        for (const r of read.records) this.owners.set(r.id, { serverId: r.serverId, label: r.host, target: read.targets.get(r.serverId) });
        for (const a of read.others) this.owners.set(a.id, { serverId: a.serverId!, label: a.host!, target: read.targets.get(a.serverId!) });
        return read;
      });
    this.flight = { at: Date.now(), p };
    return p;
  }

  async listAgents(o: ListOptions = {}): Promise<PortAgent[]> {
    // The CLI cannot filter by a bare key (it returns everything) and the local listing shows no archive state, so archived
    // local agents are not listed.
    const args = o.label && o.label.includes("=") ? ["ls", "-g", "--background", "--label", o.label, "--json"] : ["ls", "-g", "--background", "--json"];
    const rows: any[] = JSON.parse((await this.exec(args)) || "[]");
    const others = o.local ? [] : await this.otherHosts(o, new Set(rows.map((a) => String(a.id))));
    const mine = await Promise.all(rows.map(async (a): Promise<PortAgent> => {
      let createdAt: string | null = null;
      // only a choice between several labelled agents needs the age, so only then pay for `inspect`
      if (o.label && rows.length + others.length > 1) {
        try { createdAt = JSON.parse(await this.exec(["inspect", a.id, "--json"])).CreatedAt || null; } catch {}
      }
      return { id: String(a.id), status: String(a.status), labels: a.labels ?? {}, createdAt, updatedAt: null, model: null, thinking: null, title: a.name ?? null, archived: false };
    }));
    return [...mine, ...others];
  }

  /** The other hosts' agents `o` asks for, leaving out ids this daemon listed itself. */
  private async otherHosts(o: ListOptions, here: ReadonlySet<string>): Promise<PortAgent[]> {
    const read = await this.remote();
    const i = o.label?.indexOf("=") ?? -1;
    const [key, value] = !o.label ? ["", null] : i < 0 ? [o.label, null] : [o.label.slice(0, i), o.label.slice(i + 1)];
    return [...read.records.map(toPortAgent), ...read.others].filter((a) =>
      !here.has(a.id) && (o.includeArchived || !a.archived) && (!key || (a.labels[key] !== undefined && (value === null || a.labels[key] === value))));
  }

  /** The other host `id` is known to live on, from a listing or from the store. */
  private ownerOf(id: string): Owner | undefined {
    const listed = this.owners.get(id);
    if (listed) return listed;
    const root = this.root();
    if (!root) return undefined;
    const store = readRemoteStore(root);
    const r = remoteRecords(store).find((x) => x.id === id);
    return r ? { serverId: r.serverId, label: r.host, target: store.hosts[r.serverId]?.target } : undefined;
  }

  /** `--host` for an owner, checked against the directory now; throws for a host that is offline. */
  private async hostArgs(owner: Owner): Promise<string[]> {
    const host = (await listHosts(this.exec))?.find((h) => h.serverId === owner.serverId);
    if (host && !host.online) throw new Error(`host ${host.label} is offline: cannot reach its agent`);
    const target = host?.target ?? owner.target;
    if (!target) throw new Error(`no way to reach host ${owner.label}`);
    return ["--host", target];
  }

  /**
   * Run `fn` against the daemon that has `id`: its known host, else this one; an id this daemon rejects is then looked for
   * on the other hosts, and the local error stands when none has it.
   */
  private async onOwner<T>(id: string, fn: (host: string[]) => Promise<T>): Promise<T> {
    const known = this.ownerOf(id);
    if (known) return fn(await this.hostArgs(known));
    try {
      return await fn([]);
    } catch (e) {
      await this.remote();
      const found = this.ownerOf(id);
      if (!found) throw e;
      return fn(await this.hostArgs(found));
    }
  }

  /** `inspect` + `logs` parsed as text. The deck never renders from this (it has no handle-less rendering); kept for completeness. */
  async agentView(id: string): Promise<AgentView> {
    let meta: any = {};
    let host: string[] = [];
    try {
      meta = await this.onOwner(id, async (h) => {
        const m = JSON.parse((await this.exec(["inspect", id, "--json", ...h])) || "{}");
        host = h;
        return m;
      });
    } catch {}
    let log: string[] = [];
    try { log = (await this.exec(["logs", id, ...host])).split("\n"); } catch {}
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
      await this.onOwner(id, (host) => this.exec(["send", id, "--no-wait", "--behavior", "steer", "--prompt-file", file, ...host], 30_000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * `inspect` + `logs`, for the gate sweep before any SDK handle exists. The table log does not type its lines, so the final
   * message is approximated: the last line starting DONE:/BLOCKED: in the trailing block after the last `[Tag]` line.
   */
  async sweepInfo(id: string): Promise<{ status: string; updatedAt: string | null; parentAgentId: string | null; finalLine: string | null }> {
    return this.onOwner(id, async (host) => {
      const meta: any = JSON.parse((await this.exec(["inspect", id, "--json", ...host])) || "{}");
      const log = (await this.exec(["logs", id, "--tail", "40", ...host])).split("\n");
      let from = 0;
      log.forEach((l, i) => { if (l.startsWith("[")) from = i + 1; });
      const finalLine = [...log.slice(from)].reverse().find((l) => l.startsWith("DONE:") || l.startsWith("BLOCKED:")) ?? null;
      return { status: String(meta.Status ?? "").toLowerCase(), updatedAt: meta.UpdatedAt ?? null, parentAgentId: meta.ParentAgentId ?? null, finalLine };
    });
  }

  /** The CLI cannot write timeline rows. */
  async appendTimelineRow(): Promise<boolean> {
    return false;
  }
}
