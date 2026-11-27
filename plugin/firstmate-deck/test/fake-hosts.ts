// A fake `paseo` CLI with other hosts, shaped like Paseo 0.17.4 (`host ls`, `ls` with labels, `inspect`, `--host`), usable
// in process (as an Exec) or as a PASEO_BIN script that reads its world from a file and logs every call.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAC = "tcp://100.64.1.20:6767";

export type FakeAgent = {
  id: string;
  status?: string;
  archived?: boolean;
  createdAt: string;
  updatedAt?: string;
  labels?: Record<string, string>;
  pending?: number;
  /** Created between the two listings: `ls -a` shows it, the default listing does not yet. */
  unlisted?: boolean;
  /** The relative text `ls` prints. */
  created?: string;
  name?: string;
};
export type FakeHost = {
  serverId: string;
  label: string;
  target: string;
  status?: string;
  enabled?: boolean;
  lastOnlineAt?: string | null;
  agents: FakeAgent[];
  /** `ls` on this host fails; `inspect` on this host fails; `ls` never returns. */
  lsFails?: boolean;
  inspectFails?: boolean;
  hangs?: boolean;
};
export type World = { local: FakeAgent[]; hosts: FakeHost[]; hostLsFails?: boolean };

export const mac = (agents: FakeAgent[], over: Partial<FakeHost> = {}): FakeHost => ({ serverId: "srv_mac", label: "mac", target: MAC, status: "online", lastOnlineAt: "2026-11-27T12:22:45.386Z", agents, ...over });
export const crew = (id: string, task: string, createdAt: string, over: Partial<FakeAgent> = {}): FakeAgent => ({ id, createdAt, status: "running", labels: { "fm.task": task }, ...over });

const fail = (code: string, message: string): never => { throw new Error(JSON.stringify({ error: { code, message } })); };

/** One call: the stdout the real CLI would print, or a throw. `"hang"` for a host that never answers. */
export function answer(w: World, args: string[]): string | "hang" {
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const target = flag("--host");
  if (target !== undefined && args.includes("--home")) fail("TARGET_AMBIGUOUS", "Choose either --home or --host, not both.");
  if (args[0] === "host") {
    if (w.hostLsFails) fail("UNKNOWN_COMMAND", "unknown command 'host'");
    return JSON.stringify(w.hosts.map((h) => ({ registrationId: `hst_${h.label}`, serverId: h.serverId, label: h.label, enabled: h.enabled ?? true, status: h.status ?? "online", targetDescription: h.target, lastOnlineAt: h.lastOnlineAt ?? null, error: null })));
  }
  const host = target === undefined ? undefined : w.hosts.find((h) => h.target === target);
  if (target !== undefined && (!host || (host.status ?? "online") !== "online")) fail("DAEMON_UNREACHABLE", `Cannot connect to daemon at ${target}`);
  if (host?.hangs) return "hang";
  const agents = host ? host.agents : w.local;
  const find = (id: string) => agents.find((a) => a.id === id) ?? fail("AGENT_NOT_FOUND", `Agent not found: ${id}`);
  if (args[0] === "ls") {
    if (host?.lsFails) fail("DAEMON_UNREACHABLE", "ls failed");
    const label = flag("--label");
    const all = args.includes("-a");
    const rows = agents.filter((a) => all || (!a.archived && !a.unlisted)).filter((a) => !label?.includes("=") || a.labels?.[label.split("=")[0]] === label.slice(label.indexOf("=") + 1));
    return JSON.stringify(rows.map((a) => ({ id: a.id, shortId: a.id.slice(0, 7), name: a.name ?? a.id, status: a.status ?? "idle", created: a.created ?? "1 hours ago", labels: a.labels ?? {} })));
  }
  if (args[0] === "inspect") {
    if (host?.inspectFails) fail("TIMEOUT", "inspect failed");
    const a = find(args[1]);
    return JSON.stringify({ Id: a.id, Status: a.status ?? "idle", Archived: !!a.archived, ArchivedAt: a.archived ? a.createdAt : null, CreatedAt: a.createdAt, UpdatedAt: a.updatedAt ?? a.createdAt, PendingPermissions: Array.from({ length: a.pending ?? 0 }, (_, i) => ({ id: `p${i}` })), ParentAgentId: null });
  }
  if (args[0] === "logs") { find(args[1]); return `[Shell] ls\nDONE: from ${host?.label ?? "local"}\n`; }
  if (args[0] === "send") { find(args[1]); return ""; }
  return "";
}

/** In process: an Exec plus the calls it saw. */
export function fakeExec(w: World) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    const r = answer(w, args);
    if (r === "hang") throw new Error("paseo timed out");
    return r;
  };
  return { exec, calls };
}

/** A `PASEO_BIN` script in `dir` answering from `<dir>/world.json`, appending each argv to `<dir>/calls.jsonl`. */
export function fakeBin(dir: string, w: World): { bin: string; calls: string; world: (w: World) => void } {
  const bin = join(dir, "paseo.mjs");
  const worldFile = join(dir, "world.json");
  const calls = join(dir, "calls.jsonl");
  const self = pathToFileURL(fileURLToPath(import.meta.url)).href;
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { answer } from ${JSON.stringify(self)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
try {
  const r = answer(JSON.parse(readFileSync(${JSON.stringify(worldFile)}, "utf8")), args);
  if (r === "hang") setTimeout(() => process.exit(1), 60000);
  else process.stdout.write(r);
} catch (e) { process.stdout.write(e.message); process.stderr.write(e.message); process.exit(1); }
`);
  chmodSync(bin, 0o755);
  const world = (next: World) => writeFileSync(worldFile, JSON.stringify(next));
  world(w);
  return { bin, calls, world };
}
