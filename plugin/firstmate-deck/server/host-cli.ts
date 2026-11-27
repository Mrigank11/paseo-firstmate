// Our crews (ownership.ts; anyone else's agents there are left out entirely) on other Paseo hosts through the CLI (`paseo host ls`, then `ls`/`inspect --host <target>`): used by the stage
// CLI (stage-data.ts) and by the plugin before it has an SDK handle (paseo-cli.ts, cold-agents.ts). Dependency-free.
// Nothing here fails a caller because a host is away: its crews come back from state/remote-agents.json (remote-store.ts)
// as "unknown". `ls` shows neither dates nor permissions, so `inspect` supplies them: the creation date once (it is kept in
// the store), the rest only for crews that can still be doing something.
// Env: PASEO_HOST_TIMEOUT_MS (default 8000) bounds each call to another host; one host gets at most twice that per read.
import type { Exec } from "./paseo-cli.ts";
import { claims, daemonServerId, type Self } from "./ownership.ts";
import type { PortAgent } from "./paseo-port.ts";
import { mergeHosts, readRemoteStore, recordHosts, remoteRecords, type HostSeen, type RemoteAgent, type RemoteRecord, type RemoteStore } from "./remote-store.ts";

export type CliHost = { serverId: string; label: string; target: string; online: boolean; lastOnlineAt: string | null };

const callTimeout = (): number => Number(process.env.PASEO_HOST_TIMEOUT_MS) || 8000;
const INSPECTS_AT_ONCE = 4;

/** Every registered host, disabled ones included (as offline); null when the directory cannot be read (no `host` command). */
export async function listHosts(exec: Exec): Promise<CliHost[] | null> {
  try {
    const rows = JSON.parse((await exec(["host", "ls", "--json"], callTimeout())) || "[]");
    if (!Array.isArray(rows)) return null;
    return rows.filter((h) => h && typeof h.serverId === "string" && h.serverId).map((h): CliHost => {
      const target = typeof h.targetDescription === "string" ? h.targetDescription : "";
      return { serverId: h.serverId, label: String(h.label || h.serverId), target, online: h.enabled !== false && h.status === "online" && !!target, lastOnlineAt: h.lastOnlineAt ?? null };
    });
  } catch {
    return null;
  }
}

const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };

/** `ls`'s "18 minutes ago" as a date, roughly: only for a crew whose `inspect` failed. */
function roughDate(text: unknown, now: Date): string | null {
  if (text === "just now") return now.toISOString();
  const m = /^(\d+) (second|minute|hour|day|week|month|year)s? ago$/.exec(String(text ?? ""));
  return m ? new Date(now.getTime() - Number(m[1]) * UNIT_MS[m[2]]).toISOString() : null;
}

type Listing = { agents: RemoteAgent[]; rough: Map<string, string>; others: PortAgent[] };

/** A listed agent that is not a crew: shown to a caller that asks for everything, never remembered or inspected. */
const bystander = (a: any, host: CliHost, archived: boolean): PortAgent => ({
  id: String(a.id), status: String(a.status), labels: a.labels ?? {}, createdAt: null, updatedAt: null, model: null, thinking: null, title: a.name ?? null, archived, host: host.label, serverId: host.serverId,
});

/** The live agents of the local daemon, asked once and only if a relay label needs it. */
function localIds(exec: Exec): Self["isLocal"] {
  let asked: Promise<Set<string>> | null = null;
  return async (id) => {
    asked ??= exec(["ls", "-g", "--background", "--json"]).then((out) => {
      const rows = JSON.parse(out || "[]");
      if (!Array.isArray(rows)) throw new Error("unreadable local agent list");
      return new Set(rows.map((a) => String(a.id)));
    });
    return (await asked).has(id);
  };
}

/** One online host's crews of ours (agents carrying `fm.task`), or null when it cannot be listed. */
async function crewsOf(exec: Exec, host: CliHost, self: Self, known: Map<string, RemoteAgent>, tasks: ReadonlySet<string> | undefined, now: Date): Promise<Listing | null> {
  const deadline = Date.now() + 2 * callTimeout();
  const left = () => Math.min(callTimeout(), deadline - Date.now());
  const call = async (args: string[]): Promise<any> => {
    const ms = left();
    if (ms <= 0) throw new Error(`${host.label}: out of time`);
    // the exec has its own timeout; this one also covers an exec that does not honour it
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([exec([...args, "--json", "--host", host.target], ms), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${host.label}: timed out`)), ms + 500); })]);
      return JSON.parse(out || "null");
    } finally {
      clearTimeout(timer);
    }
  };
  let all: any[], live: any[];
  try {
    // `ls` shows no archive state: whatever `-a` lists that the default (non-archived) listing lacks is archived
    [all, live] = await Promise.all([call(["ls", "-a", "-g"]), call(["ls", "-g", "--background"])]);
    if (!Array.isArray(all) || !Array.isArray(live)) return null;
  } catch {
    return null;
  }
  const unarchived = new Set(live.map((a) => String(a.id)));
  const listed = new Map<string, any>();
  for (const a of [...all, ...live]) {
    const id = String(a.id);
    if (known.has(id) || (await claims(a.labels, self))) listed.set(id, a);
  }
  const isCrew = (a: any) => typeof a?.labels?.["fm.task"] === "string" && !!a.labels["fm.task"];
  const rows = new Map([...listed].filter(([, a]) => isCrew(a)));
  const others = [...listed].filter(([, a]) => !isCrew(a)).map(([id, a]) => bystander(a, host, !unarchived.has(id)));
  const agents = [...rows].map(([id, a]): RemoteAgent => {
    const was = known.get(id);
    return { id, task: a.labels["fm.task"], status: String(a.status), archived: !unarchived.has(id), createdAt: was?.createdAt ?? null, lastActivityAt: was?.lastActivityAt ?? null, pending: 0, labels: a.labels, owner: self.serverId };
  });
  const busy = (a: RemoteAgent) => !a.archived && a.status !== "closed" && (!tasks || tasks.has(a.task));
  // Inspected: crews that may be doing something, and ones seen for the first time (the two listings are not one snapshot,
  // so inspect also settles their archive state). Busy ones first, so a slow host runs out of time on history, not on them.
  const queue = agents.filter((a) => busy(a) || !a.createdAt).sort((x, y) => Number(busy(y)) - Number(busy(x)));
  const rough = new Map<string, string>();
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        const meta = await call(["inspect", a.id]);
        a.createdAt = meta?.CreatedAt ?? a.createdAt;
        if (typeof meta?.Archived === "boolean") a.archived = meta.Archived;
        a.lastActivityAt = meta?.UpdatedAt ?? a.lastActivityAt;
        a.pending = busy(a) && Array.isArray(meta?.PendingPermissions) ? meta.PendingPermissions.length : 0;
      } catch {
        if (busy(a)) a.pending = known.get(a.id)?.pending ?? 0;
      }
      if (!a.createdAt) {
        const guess = roughDate(rows.get(a.id)?.created, now);
        if (guess) rough.set(a.id, guess);
      }
    }
  };
  await Promise.all(Array.from({ length: INSPECTS_AT_ONCE }, worker));
  return { agents, rough, others };
}

export type RemoteRead = {
  /** Every crew of ours on every other host; an offline (or unlistable) host's come from the store, as "unknown". */
  records: RemoteRecord[];
  /** The online hosts' agents of ours that are not crews. */
  others: PortAgent[];
  /** serverId -> what `--host` accepts. */
  targets: Map<string, string>;
};

/**
 * Read every registered host and remember what was seen under `root`. Without `root` nothing is stored or recalled, so an
 * offline host's crews are only known to a caller that has one. `tasks` narrows which crews get the permission check
 * (undefined: all of them). When the host directory cannot be read the store is left alone and all its crews are unknown.
 */
export async function readRemote(exec: Exec, o: { root?: string; tasks?: ReadonlySet<string>; now?: Date; serverId?: string } = {}): Promise<RemoteRead> {
  const now = o.now ?? new Date();
  const hosts = await listHosts(exec);
  const self: Self = { serverId: o.serverId ?? daemonServerId(), isLocal: localIds(exec) };
  const prev: RemoteStore = o.root ? readRemoteStore(o.root, self.serverId) : { version: 1, hosts: {} };
  const targetsOf = (s: RemoteStore) => new Map(Object.entries(s.hosts).flatMap(([id, h]): [string, string][] => (h.target ? [[id, h.target]] : [])));
  if (!hosts) {
    const away = mergeHosts(prev, Object.entries(prev.hosts).map(([serverId, h]): HostSeen => ({ serverId, label: h.label, online: false, agents: null })), now);
    return { records: remoteRecords(away), others: [], targets: targetsOf(away) };
  }
  const rough = new Map<string, string>();
  const others: PortAgent[] = [];
  const seen = await Promise.all(hosts.map(async (h): Promise<HostSeen> => {
    const known = new Map((prev.hosts[h.serverId]?.agents ?? []).map((a) => [a.id, a]));
    const got = h.online ? await crewsOf(exec, h, self, known, o.tasks, now) : null;
    for (const [id, at] of got?.rough ?? []) rough.set(id, at);
    others.push(...(got?.others ?? []));
    return { serverId: h.serverId, label: h.label, ...(h.target ? { target: h.target } : {}), online: h.online, lastOnlineAt: h.lastOnlineAt, agents: got?.agents ?? null };
  }));
  const store = o.root ? recordHosts(o.root, seen, now, self.serverId) : mergeHosts(prev, seen, now);
  return { records: remoteRecords(store).map((r) => (r.createdAt ? r : { ...r, createdAt: rough.get(r.id) ?? null })), others, targets: targetsOf(store) };
}

/** A remote crew as the plugin's port lists it. */
export function toPortAgent(r: RemoteRecord): PortAgent {
  return {
    id: r.id, status: r.status, labels: r.labels ?? { "fm.task": r.task }, createdAt: r.createdAt, updatedAt: r.lastActivityAt, model: null, thinking: null, title: null,
    archived: r.archived, lastActivityAt: r.lastActivityAt, pendingPermissions: r.pending, host: r.host, serverId: r.serverId, ...(r.hostOffline ? { hostOffline: r.hostOffline } : {}),
  };
}
