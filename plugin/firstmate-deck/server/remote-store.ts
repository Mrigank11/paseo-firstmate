// state/remote-agents.json: the last-known crew records of every other Paseo host, so an offline host's crews stay
// "unknown" (never gone) for the plugin and for `bin/fleet stage(s)`. Written by both; derived data, safe to delete.
// Dependency-free (bin/fleet runs it without installing the plugin).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostOffline } from "./stage.ts";

/** One crew (an agent carrying `fm.task`) as last seen on its host. */
export type RemoteAgent = {
  id: string;
  task: string;
  status: string;
  archived: boolean;
  createdAt: string | null;
  lastActivityAt: string | null;
  pending: number;
  labels?: Record<string, string>;
};

export type StoredHost = {
  label: string;
  /** What `paseo --host` accepts to reach it (the directory's targetDescription). */
  target?: string;
  /** Null while online; else when it was last online (or first seen offline), ISO. */
  offlineSince: string | null;
  agents: RemoteAgent[];
};

export type RemoteStore = { version: 1; hosts: Record<string, StoredHost> };

/** One registered host as just read. `agents: null` = they could not be listed (offline, or the call failed). */
export type HostSeen = { serverId: string; label: string; target?: string; online: boolean; lastOnlineAt?: string | null; agents: RemoteAgent[] | null };

export type RemoteRecord = RemoteAgent & { host: string; serverId: string; hostOffline?: HostOffline };

export const remoteStorePath = (root: string): string => join(root, "state", "remote-agents.json");

export function readRemoteStore(root: string): RemoteStore {
  try {
    const s = JSON.parse(readFileSync(remoteStorePath(root), "utf8"));
    if (s?.version === 1 && s.hosts && typeof s.hosts === "object") return s as RemoteStore;
  } catch {}
  return { version: 1, hosts: {} };
}

/** The store after `seen`, which must name EVERY registered host (one left out is forgotten). */
export function mergeHosts(prev: RemoteStore, seen: readonly HostSeen[], now: Date): RemoteStore {
  const hosts: Record<string, StoredHost> = {};
  for (const h of seen) {
    const was = prev.hosts[h.serverId];
    const listed = h.online && h.agents !== null;
    hosts[h.serverId] = {
      label: h.label,
      ...(h.target ?? was?.target ? { target: h.target ?? was?.target } : {}),
      // lastOnlineAt is when the host last connected, so it only stands in for a host never recorded here
      offlineSince: listed ? null : was ? was.offlineSince ?? now.toISOString() : h.lastOnlineAt ?? now.toISOString(),
      agents: listed ? h.agents! : was?.agents ?? [],
    };
  }
  return { version: 1, hosts };
}

/** Merge `seen` into the file (written only when it changes) and return the new store. */
export function recordHosts(root: string, seen: readonly HostSeen[], now: Date = new Date()): RemoteStore {
  const prev = readRemoteStore(root);
  const next = mergeHosts(prev, seen, now);
  const body = JSON.stringify(next);
  if (body !== JSON.stringify(prev)) {
    const path = remoteStorePath(root);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  }
  return next;
}

/** Every stored crew, marked with its host. An offline host's crews read as status "unknown" with no open permissions. */
export function remoteRecords(store: RemoteStore): RemoteRecord[] {
  return Object.entries(store.hosts).flatMap(([serverId, h]) =>
    h.agents.map((a): RemoteRecord => ({
      ...a, host: h.label, serverId,
      ...(h.offlineSince ? { status: "unknown", pending: 0, hostOffline: { label: h.label, since: h.offlineSince } } : {}),
    })),
  );
}
