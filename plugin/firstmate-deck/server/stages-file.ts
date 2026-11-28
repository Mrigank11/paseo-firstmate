// state/stages.json: the plugin's single evaluation of every live task (owner, reason, stage), written on every render and
// tick, read by `bin/fleet stage(s)` so the CLI, the page and the enforcer cannot disagree. Derived data: never edited, safe
// to delete (the CLI then computes locally and says it is degraded). Dependency-free (bin/fleet runs it without installing the plugin).
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A task's row as `bin/fleet stages` prints it. */
export type StageRow = {
  id: string;
  project: string | null;
  state: string;
  stage: string;
  group: string;
  agentId: string | null;
  flags: { key: string; text: string; drift: boolean }[];
  /** Who owes the next move: captain | firstmate | crew | outside | nobody. */
  owner: string;
  reason: string;
  clears: string;
  /** Identity of the situation (stage + reason + agent): the enforcer counts nudges per fingerprint. */
  fp: string;
  /** When the current (owner, fingerprint) took over, ISO. Absent on a row computed locally. */
  owedSince?: string;
  note?: string;
  /** The label of the host the current agent runs on; absent for an agent on this daemon. */
  host?: string;
  canvas?: { verdict: string; bluf: string; asks: number };
  /** Where the row came from: the plugin's snapshot, or a local computation (no plugin, degraded). */
  source?: "plugin" | "local";
};

export type Snapshot = {
  version: 1;
  writtenAt: string;
  pid: number;
  /** The newest mtime (ms) of fleet.json and every inbox.jsonl when the plugin read them: older than the files now = stale. */
  inputsMtimeMs: number;
  /** The first mate that owns each project ("" = checkout-wide / no project): its agent id, or null when none is live. */
  owners: Record<string, string | null>;
  rows: StageRow[];
};

export const SNAPSHOT_MAX_AGE_MS = 120_000;

export const snapshotPath = (root: string): string => join(root, "state", "stages.json");

/** Newest mtime across the files a stage depends on that the plugin sees by watching: the registry and every project inbox. */
export function inputsMtimeMs(root: string): number {
  let newest = 0;
  const touch = (p: string) => { try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* absent */ } };
  touch(join(root, "state", "fleet.json"));
  let projects: string[] = [];
  try { projects = readdirSync(join(root, "state", "projects")); } catch { /* none */ }
  for (const p of projects) touch(join(root, "state", "projects", p, "inbox.jsonl"));
  return newest;
}

export function writeSnapshot(root: string, snap: Snapshot): void {
  const path = snapshotPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, path);
}

export function readSnapshot(root: string): Snapshot | null {
  try {
    const s = JSON.parse(readFileSync(snapshotPath(root), "utf8"));
    return s?.version === 1 && Array.isArray(s.rows) ? (s as Snapshot) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The snapshot, when it can be trusted: written recently (the plugin is alive) and not older than the registry/inboxes. A write that
 * landed a moment ago (`bin/fleet ask`, a comment) is waited for, up to `waitMs`, because the plugin re-evaluates within a second.
 * Null = no usable snapshot: the caller computes locally and says so.
 */
export function freshSnapshot(root: string, waitMs = 4000, now: () => number = Date.now): Snapshot | null {
  const deadline = now() + waitMs;
  for (;;) {
    const s = readSnapshot(root);
    if (s && now() - Date.parse(s.writtenAt) <= SNAPSHOT_MAX_AGE_MS && s.inputsMtimeMs >= inputsMtimeMs(root)) return s;
    if (!s || now() - Date.parse(s.writtenAt) > SNAPSHOT_MAX_AGE_MS || now() >= deadline) return null;
    sleep(150);
  }
}
