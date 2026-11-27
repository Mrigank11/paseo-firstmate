// The daemon API the deck needs, behind one small interface. Two implementations:
//   SdkPort  wraps the `context.paseo` handle (fast, typed; only exists once a hook or RPC has fired)
//   CliPort  shells out to the `paseo` CLI (server/paseo-cli.ts); the cold-start fallback for delivery
// PortSelector picks between them: the SdkPort once any hook or RPC callback has handed us a handle.
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Types come from @getpaseo/plugin (which Paseo itself supplies to plugins), not @getpaseo/client: a dev-only
// package cannot be resolved when the plugin is installed with production dependencies only.
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
type PaseoApi = PluginHandlerContext["paseo"];
type PaseoAgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
import { COMMENT_ROW_KIND, COMMENT_ROW_VERSION } from "../shared/contract.ts";
import { claimedId, projectClaimedId } from "./claims.ts";
import { Hosts, within, type HostInfo, type HostRef, type HostsOptions } from "./hosts.ts";
import { mergeHosts, readRemoteStore, recordHosts, remoteRecords, type HostSeen, type RemoteRecord, type RemoteStore } from "./remote-store.ts";
import { human } from "./humanize.ts";
import type { AgentView } from "./render.ts";
import type { HostOffline } from "./stage.ts";

export type PortAgent = {
  id: string;
  status: string;
  labels: Record<string, string>;
  createdAt: string | null;
  updatedAt: string | null;
  model: string | null;
  thinking: string | null;
  title: string | null;
  archived: boolean;
  lastActivityAt?: string | null;
  /** Open permission requests (0 when unknown, as on the CLI). */
  pendingPermissions?: number;
  /** Set for an agent on another Paseo host: its label and server id. */
  host?: string;
  serverId?: string;
  /** That host is offline: this is the last known record, with status "unknown". */
  hostOffline?: HostOffline;
};

export type ListOptions = { label?: string; includeArchived?: boolean; local?: boolean };

export type AgentInfo = {
  id: string; status: string; labels: Record<string, string>; archived: boolean; updatedAt: string | null;
  /** A path on the agent's own machine: meaningless here when `serverId` is set. */
  cwd: string | null;
  host?: string;
  serverId?: string;
};

export type CommentRowData = { project: string; pageUrl: string | null; at: string; comments: { target: string; text: string }[]; replied: boolean };

export interface PaseoPort {
  readonly kind: "sdk" | "cli";
  /**
   * Live (non-archived) agents, optionally only those carrying `label` ("key=value", or just "key"), archived ones too with
   * `includeArchived`. Every host's agents are merged in (marked `host`/`serverId`) unless `local` asks for this daemon's only.
   */
  listAgents(o?: ListOptions): Promise<PortAgent[]>;
  agentView(id: string): Promise<AgentView>;
  /** Send `text` to the agent, steering it if it is mid-turn (never interrupting). */
  send(id: string, text: string): Promise<void>;
  /** Handle-less peek for the gate sweep (CLI only): status, age, parent and the last DONE:/BLOCKED: line of the trailing log block. */
  sweepInfo?(id: string): Promise<{ status: string; updatedAt: string | null; parentAgentId: string | null; finalLine: string | null }>;
  /** Add (or replace, same id) the plugin timeline row on an agent. False when this port cannot. */
  appendTimelineRow(agentId: string, rowId: string, data: CommentRowData): Promise<boolean>;
}

// ---------- timeline items -> the (tag, text) pairs `human()` expects ----------

type TimelineEntry = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>["entries"][number];
export type TimelineItem = TimelineEntry["item"];
type ToolCall = Extract<TimelineItem, { type: "tool_call" }>;

/** Mirrors the daemon's display-name humanizer so SDK steps carry the same tags `paseo logs` prints. */
function toolTag(name: string): string {
  const t = name.trim();
  if (!t) return name;
  if (/[:./]/.test(t) || t.includes("__")) return t;
  return t.replace(/[._-]+/g, " ").split(" ").filter(Boolean).join(" ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

const EVENT_TAGS: Record<string, string> = {
  message: "Message received", finished: "Agent finished", errored: "Agent errored", "permission-required": "Agent needs permission", closed: "Agent closed",
};

/** The text of an unknown-shaped tool call: the Skill name, a command, a path... whichever its input carries. */
function unknownText(input: unknown, tag: string): string {
  if (!isRecord(input)) return "";
  if (tag === "Skill") return str(input.skill) ?? str(input.name) ?? "";
  for (const k of ["command", "file_path", "path", "pattern", "query", "url", "description", "name"]) {
    const v = str(input[k]);
    if (v) return v;
  }
  return "";
}

function toolStep(c: ToolCall): [string, string] | null {
  if (c.agentMessage) {
    const tag = EVENT_TAGS[c.agentMessage.event] ?? "Message received";
    if (tag === "Message received") return null; // inter-agent chatter is not a step (parseStep skips it too)
    return [tag, c.agentMessage.sender.title ?? c.agentMessage.sender.id];
  }
  const d = c.detail;
  switch (d.type) {
    case "shell": return ["Shell", d.command];
    case "read": return ["Read", d.filePath];
    case "edit": return ["Edit", d.filePath];
    case "write": return ["Write", d.filePath];
    case "search": return ["Search", d.query];
    case "fetch": return ["Fetch", d.url];
    case "worktree_setup": return ["Worktree setup", d.branchName];
    case "sub_agent": return [d.subAgentType || "Task", d.description ?? ""];
    case "plan": return ["Plan", ""];
    case "plain_text": return [toolTag(c.name), d.label ?? ""];
    default: {
      const tag = c.name.trim().toLowerCase() === "task" ? "Task" : c.name.trim().toLowerCase() === "thinking" ? "Thinking" : toolTag(c.name);
      return [tag, unknownText(d.input, tag)];
    }
  }
}

/** One timeline item as a step: reasoning, tool calls, task list, errors. Messages and notices are not steps. */
export function itemStep(item: TimelineItem): [string, string] | null {
  switch (item.type) {
    case "reasoning": return item.text.trim() ? ["Thought", item.text.trim()] : null;
    case "tool_call": return toolStep(item);
    case "todo": return ["Tasks", ""];
    case "error": return ["Error", item.message];
    case "compaction": return ["Compacted", ""];
    default: return null; // user_message, assistant_message, notification, plugin
  }
}

/** The last assistant line that starts with DONE: or BLOCKED:. */
export function finalLine(items: readonly TimelineItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type !== "assistant_message") continue;
    const lines = it.text.split("\n");
    for (let j = lines.length - 1; j >= 0; j--) if (lines[j].startsWith("DONE:") || lines[j].startsWith("BLOCKED:")) return lines[j];
  }
  return undefined;
}

/** Items (oldest first) to the fields of an AgentView that come from the log. */
export function viewFromItems(items: readonly TimelineItem[]): Pick<AgentView, "stepCount" | "recent" | "final"> {
  const steps = items.map(itemStep).filter((s): s is [string, string] => !!s);
  return { stepCount: steps.length, recent: steps.slice(-8).map(([t, x]) => human(t, x)), final: finalLine(items) };
}

// ---------- SdkPort ----------

/** How much timeline the SDK view reads. */
export const TAIL_LIMIT = 200;
const PAGE_LIMIT = 200;
const MAX_PAGES = 5;

export function parseLabel(label: string): [string, string | null] {
  const i = label.indexOf("=");
  return i < 0 ? [label, null] : [label.slice(0, i), label.slice(i + 1)];
}

/** Timeouts of calls to another host: a directory listing, a read, a send. */
export const REMOTE_LIST_MS = 5000;
export const REMOTE_SEND_MS = 20_000;
/** A host's agent list is reused for this long. */
export const REMOTE_TTL_MS = 2000;
/** How long a caller waits for a slow host before taking what is already known (the read carries on behind it). */
export const REMOTE_PATIENCE_MS = 1000;

export type SdkPortOptions = HostsOptions & {
  listTimeoutMs?: number;
  sendTimeoutMs?: number;
  remoteTtlMs?: number;
  patienceMs?: number;
};

const sleep = <T>(ms: number, v: T) => new Promise<T>((r) => { setTimeout(() => r(v), ms).unref?.(); });

/** One page-walk of a daemon's agent directory. */
async function listFrom(api: PaseoApi, o: ListOptions, sort?: { key: "updated_at"; direction: "desc" }[]): Promise<PortAgent[]> {
  const [key, value] = o.label ? parseLabel(o.label) : ["", null];
  const out: PortAgent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await api.agents.list({
      // includeBackground: crew an agent starts over MCP live in a background workspace, which the default listing hides
      filter: { ...(key && value !== null ? { labels: { [key]: value } } : {}), ...(o.includeArchived ? { includeArchived: true } : {}), includeBackground: true },
      ...(sort ? { sort } : {}),
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent: a } of r.entries) {
      if (key && value === null && !(key in a.labels)) continue;
      out.push({
        id: a.id, status: a.status, labels: a.labels, createdAt: a.createdAt, updatedAt: a.updatedAt,
        model: a.model, thinking: a.effectiveThinkingOptionId ?? a.thinkingOptionId ?? null, title: a.title, archived: !!a.archivedAt,
        lastActivityAt: a.updatedAt, pendingPermissions: a.pendingPermissions?.length ?? 0,
      });
    }
    if (!r.pageInfo.hasMore || !r.pageInfo.nextCursor) break;
    cursor = r.pageInfo.nextCursor;
  }
  return out;
}

const matches = (a: PortAgent, o: ListOptions): boolean => {
  if (a.archived && !o.includeArchived) return false;
  if (!o.label) return true;
  const [key, value] = parseLabel(o.label);
  return value === null ? key in a.labels : a.labels[key] === value;
};

/** The persisted form of one remote crew. */
const toRecord = (a: PortAgent) => ({
  id: a.id, task: a.labels["fm.task"], status: a.status, archived: a.archived, createdAt: a.createdAt, lastActivityAt: a.lastActivityAt ?? a.updatedAt,
  pending: a.pendingPermissions ?? 0, labels: a.labels,
});

/** A remembered remote crew as a port agent. */
export function fromRecord(r: RemoteRecord): PortAgent {
  return {
    id: r.id, status: r.status, labels: r.labels ?? { "fm.task": r.task }, createdAt: r.createdAt, updatedAt: r.lastActivityAt, lastActivityAt: r.lastActivityAt,
    model: null, thinking: null, title: null, archived: r.archived, pendingPermissions: r.pending, host: r.host, serverId: r.serverId,
    ...(r.hostOffline ? { hostOffline: r.hostOffline } : {}),
  };
}

/**
 * The SDK handle's agents: this daemon's, plus those of every other Paseo host it is linked to. Per-agent calls go to the host
 * the agent lives on. A host that cannot be listed keeps its last-known crews, as status "unknown" with `hostOffline`.
 */
export class SdkPort implements PaseoPort {
  readonly kind = "sdk" as const;
  private api: PaseoApi;
  /** Null for a daemon without a host directory: then everything is local. */
  readonly hosts: Hosts | null;
  private o: SdkPortOptions;
  /** Last-known remote crews when there is no checkout to persist them in. */
  private memory: RemoteStore = { version: 1, hosts: {} };
  private lists = new Map<string, { at: number; agents: PortAgent[] }>();
  private listing = new Map<string, Promise<PortAgent[] | null>>();
  private failing = new Set<string>();
  constructor(api: PaseoApi, o: SdkPortOptions = {}) {
    this.api = api;
    this.o = o;
    this.hosts = (api as Partial<PaseoApi>).hosts ? new Hosts(api, o) : null;
  }

  async listAgents(o: ListOptions = {}): Promise<PortAgent[]> {
    const local = await listFrom(this.api, o);
    if (!this.hosts || o.local) return local;
    let remote: PortAgent[] = [];
    try { remote = await this.remoteAgents(); }
    catch (e) { this.o.log?.(`listing other hosts' agents failed: ${(e as Error).message}`); }
    const here = new Set(local.map((a) => a.id));
    return [...local, ...remote.filter((a) => !here.has(a.id) && matches(a, o))];
  }

  /** The agents of one host, or null when they cannot be read now. A slow host is waited for only `patienceMs`. */
  private async hostAgents(h: HostInfo): Promise<PortAgent[] | null> {
    const id = h.serverId;
    const have = this.lists.get(id);
    if (have && Date.now() - have.at < (this.o.remoteTtlMs ?? (this.o.ttlMs ?? REMOTE_TTL_MS))) return have.agents;
    let flight = this.listing.get(id);
    if (!flight) {
      flight = this.hosts!
        .call(id, (api) => listFrom(api, { includeArchived: true }, [{ key: "updated_at", direction: "desc" }]), this.o.listTimeoutMs ?? this.o.timeoutMs ?? REMOTE_LIST_MS)
        .then(
          (all) => {
            const agents = all.map((a) => ({ ...a, host: h.label, serverId: id }));
            this.lists.set(id, { at: Date.now(), agents });
            this.failing.delete(id);
            return agents;
          },
          (e) => {
            if (!this.failing.has(id)) this.o.log?.(`could not list the agents of host ${h.label}: ${(e as Error).message}`);
            this.failing.add(id);
            this.lists.delete(id);
            return null;
          },
        )
        .finally(() => this.listing.delete(id));
      this.listing.set(id, flight);
    }
    // never read: wait for it. Otherwise only briefly, then what is already known.
    if (!have && !this.failing.has(id)) return flight;
    return Promise.race([flight, sleep(this.o.patienceMs ?? REMOTE_PATIENCE_MS, have?.agents ?? null)]);
  }

  private async remoteAgents(): Promise<PortAgent[]> {
    const root = this.o.root?.() || "";
    const dir = await this.hosts!.list();
    const read = (): RemoteStore => (root ? readRemoteStore(root) : this.memory);
    // no directory: every remembered host is one that cannot be listed
    const seen: (HostSeen & { live: PortAgent[] | null })[] = dir
      ? await Promise.all(dir.map(async (h) => {
          const live = h.online ? await this.hostAgents(h) : null;
          return { serverId: h.serverId, label: h.label, target: h.target, online: h.online, lastOnlineAt: h.online ? null : h.lastOnlineAt, agents: live?.filter((a) => a.labels["fm.task"]).map(toRecord) ?? null, live };
        }))
      : Object.entries(read().hosts).map(([serverId, h]) => ({ serverId, label: h.label, online: false, agents: null, live: null }));
    if (!seen.length && !Object.keys(read().hosts).length) return [];
    let store: RemoteStore;
    const records = seen.map(({ live: _, ...h }) => h);
    try {
      store = root ? recordHosts(root, records) : (this.memory = mergeHosts(this.memory, records, new Date()));
    } catch (e) {
      this.o.log?.(`could not record other hosts' crews: ${(e as Error).message}`);
      store = this.memory = mergeHosts(this.memory, records, new Date());
    }
    const remembered = remoteRecords(store);
    const out = seen.flatMap((h) => h.live ?? remembered.filter((r) => r.serverId === h.serverId).map(fromRecord));
    for (const a of out) this.hosts!.note(a.id, a.serverId!, a.host!);
    return out;
  }

  /** Something happened on that host: its next listing is read afresh. */
  invalidate(serverId: string): void {
    const have = this.lists.get(serverId);
    if (have) have.at = 0;
  }

  /** The other host an agent lives on; undefined for a local (or unknown) one. */
  hostOf(id: string): HostRef | undefined {
    return this.hosts?.hostOf(id);
  }

  /** Ask every online host for an agent nobody has placed yet. */
  private async discover(id: string): Promise<HostRef | undefined> {
    if (!this.hosts) return undefined;
    const clients = await this.hosts.clients();
    const found = await Promise.all(clients.map(async (c) => {
      try { return (await within(c.api.agents.ref(id).refresh(), this.o.listTimeoutMs ?? this.o.timeoutMs ?? REMOTE_LIST_MS, "agent lookup"))?.agent ? c : null; }
      catch { return null; }
    }));
    const c = found.find((x) => !!x);
    if (!c) return undefined;
    this.hosts.note(id, c.serverId, c.label);
    return { serverId: c.serverId, label: c.label };
  }

  /** Run `op` against the API of the agent's host. An unplaced agent is tried here first, then looked for on the other hosts. */
  private async routed<T>(id: string, op: (api: PaseoApi) => Promise<T>, ms?: number): Promise<T> {
    const owner = this.hostOf(id);
    if (owner) return this.hosts!.call(owner.serverId, op, ms);
    try {
      return await op(this.api);
    } catch (e) {
      const found = await this.discover(id);
      if (!found) throw e;
      return this.hosts!.call(found.serverId, op, ms);
    }
  }

  async agentView(id: string): Promise<AgentView> {
    return this.routed(id, async (api) => {
      const h = api.agents.ref(id);
      // A bounded tail: for an agent with more than TAIL_LIMIT timeline entries `stepCount` is a lower bound
      // (`stepsAtLeast` says so and the page shows "N+ steps").
      const page = await h.timeline.refetch({ direction: "tail", limit: TAIL_LIMIT, projection: "projected" });
      const a = page.agent ?? h.current() ?? (await h.refresh())?.agent ?? null;
      if (!a) throw new Error(`agent ${id} not found`);
      const items = [...page.entries].sort((x, y) => x.seqStart - y.seqStart).map((e) => e.item);
      const v = viewFromItems(items);
      return {
        status: (a.archivedAt ? "archived" : a.status) as AgentView["status"],
        createdAt: a.createdAt || undefined,
        updatedAt: a.updatedAt || undefined,
        model: a.model || a.runtimeInfo?.model || undefined,
        thinking: a.effectiveThinkingOptionId || a.thinkingOptionId || undefined,
        ...v,
        ...(page.hasOlder ? { stepsAtLeast: true } : {}),
      };
    });
  }

  /** Status and labels of one agent, fresh from its daemon (hook events carry no labels). Null when it is gone. */
  async agentInfo(id: string): Promise<AgentInfo | null> {
    const read = async (api: PaseoApi): Promise<AgentInfo | null> => {
      const a = (await api.agents.ref(id).refresh())?.agent;
      return a ? { id: a.id, status: a.status, labels: a.labels, archived: !!a.archivedAt, updatedAt: a.updatedAt, cwd: a.cwd || null } : null;
    };
    const there = async (host: HostRef) => {
      const a = await this.hosts!.call(host.serverId, read);
      return a && { ...a, host: host.label, serverId: host.serverId };
    };
    const owner = this.hostOf(id);
    if (owner) return there(owner);
    let here: AgentInfo | null = null;
    let failed: unknown;
    try { here = await read(this.api); } catch (e) { failed = e; }
    if (here) return here;
    const found = await this.discover(id);
    if (found) return there(found);
    if (failed) throw failed;
    return null;
  }

  /** Answer an open permission request (the permission hook's auto-approve). */
  async respondToPermission(id: string, requestId: string, response: { behavior: "allow" } | { behavior: "deny"; message?: string }): Promise<void> {
    await this.routed(id, (api) => api.agents.ref(id).respondToPermission({ requestId, response }));
  }

  /** The newest timeline items (oldest first), for the gate's sweep. */
  async tailItems(id: string): Promise<TimelineItem[]> {
    return this.routed(id, async (api) => {
      const page = await api.agents.ref(id).timeline.refetch({ direction: "tail", limit: TAIL_LIMIT, projection: "projected" });
      return [...page.entries].sort((x, y) => x.seqStart - y.seqStart).map((e) => e.item);
    });
  }

  async send(id: string, text: string): Promise<void> {
    await this.routed(id, (api) => api.agents.ref(id).send(text, { activeTurnBehavior: "steer" }), this.o.sendTimeoutMs ?? REMOTE_SEND_MS);
  }

  async appendTimelineRow(agentId: string, rowId: string, data: CommentRowData): Promise<boolean> {
    await this.routed(agentId, async (api) => { await api.agents.ref(agentId).timeline.append({ type: "plugin", id: rowId, kind: COMMENT_ROW_KIND, version: COMMENT_ROW_VERSION, data }); });
    return true;
  }
}

// ---------- the selector ----------

export class PortSelector {
  readonly cli: PaseoPort;
  private sdk: SdkPort | null = null;
  private handle: PaseoApi | null = null;
  private log: (m: string) => void;
  private makeSdk: (api: PaseoApi) => SdkPort;
  /** Called once, when the very first handle arrives. */
  onFirstHandle?: () => void;
  /** Called for every new handle (the first one too), after `sdkPort()` moved to it. */
  onHandle?: () => void;
  /** The first-mate checkout, for the SdkPort's record of other hosts' crews (the deck sets it). */
  root?: () => string;

  constructor(cli: PaseoPort, log: (m: string) => void = () => {}, makeSdk?: (api: PaseoApi) => SdkPort) {
    this.cli = cli;
    this.log = log;
    this.makeSdk = makeSdk ?? ((api) => new SdkPort(api, { root: () => this.root?.() ?? "", log: this.log }));
  }

  /** Remember the handle a hook or RPC callback was given (the latest one wins). `source` names the callback, for the log. */
  capture(ctx: { paseo?: PaseoApi | null } | null | undefined, source: string): void {
    const api = ctx?.paseo;
    if (!api || api === this.handle) return;
    const first = !this.handle;
    this.handle = api;
    const old = this.sdk;
    this.sdk = this.makeSdk(api);
    if (old && old !== this.sdk) old.hosts?.stop();
    if (first) this.log(`SDK handle captured (from ${source}); using the SDK from now on`);
    this.onHandle?.();
    if (first) this.onFirstHandle?.();
  }

  get hasHandle(): boolean {
    return !!this.sdk;
  }

  /** The SdkPort, or null before any handle was captured. */
  sdkPort(): SdkPort | null {
    return this.sdk;
  }

  /** The SdkPort when there is a handle, else the CliPort. */
  current(): PaseoPort {
    return this.sdk ?? this.cli;
  }

  /** Send through the current port; an SDK failure falls back to the CLI once. Resolves to the port that delivered. */
  async send(id: string, text: string): Promise<"sdk" | "cli"> {
    const t0 = Date.now();
    const port = this.current();
    try {
      await port.send(id, text);
    } catch (e) {
      // not through the CLI for an agent on another host: the first send may have arrived
      if (port.kind === "cli" || (port as SdkPort).hostOf?.(id)) throw e;
      this.log(`send to ${id} via sdk failed (${(e as Error).message}); retrying via cli`);
      await this.cli.send(id, text);
      this.log(`send to ${id} via cli took ${Date.now() - t0} ms`);
      return "cli";
    }
    this.log(`send to ${id} via ${port.kind} took ${Date.now() - t0} ms`);
    return port.kind;
  }
}

// ---------- the first mate ----------

export { claimedId, projectClaimedId };
export type FirstMate = { id: string; status: string };

/** The first mate runs on this daemon: an agent of another host is never one. */
export const isLocal = (a: PortAgent): boolean => !a.serverId && !a.host;

export const NO_CLAIM_MESSAGE = "No first mate claimed this checkout: run bin/page claim in the first mate's session";

/** Thrown when there is nobody to deliver to: no project claim, no checkout claim and no usable label. The banner says how to fix it. */
export class NoFirstMateError extends Error {
  constructor() { super(NO_CLAIM_MESSAGE); this.name = "NoFirstMateError"; }
}

/** Agent ids that fleet.json or the archive lists as crew: they are never the first mate. */
export function crewAgentIds(root: string): Set<string> {
  const ids = new Set<string>();
  const state = join(root, "state");
  try {
    for (const t of JSON.parse(readFileSync(join(state, "fleet.json"), "utf8"))?.tasks ?? []) if (t?.agentId) ids.add(String(t.agentId));
  } catch {}
  try {
    for (const line of readFileSync(join(state, "fleet-archive.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); if (t?.agentId) ids.add(String(t.agentId)); } catch {}
    }
  } catch {}
  return ids;
}

const warnedCrewClaims = new Set<string>();

/**
 * The first mate of `project`, decided by explicit facts only (no guessing from working directories). The first usable of:
 *   1. the agent `bin/page claim <project>` recorded in that project's claim.json;
 *   2. the checkout-wide agent `bin/page claim` recorded in state/firstmate.json (the fallback for a project with no
 *      claim of its own, and where a checkout from before per-project claims keeps working);
 *   3. the newest live agent carrying the first-mate label, EXCLUDING every agent id fleet.json or the archive lists as crew.
 * A claim is usable when its agent still exists, is not archived and is not listed as crew (a claim held by a crew agent
 * is ignored, with a log line). Without `project`, only 2 and 3 apply. Never writes a label. Re-resolved on every use.
 */
export async function resolveFirstMate(port: PaseoPort, label: string, root?: string, log?: (msg: string) => void, project?: string): Promise<FirstMate | null> {
  const crew = root ? crewAgentIds(root) : new Set<string>();
  const claims = root ? [project ? projectClaimedId(root, project) : null, claimedId(root)] : [];
  let agents: Awaited<ReturnType<PaseoPort["listAgents"]>> | null = null;
  for (const claim of claims) {
    if (!claim) continue;
    if (crew.has(claim)) {
      // A claim held by an agent that fleet.json (or the archive) lists as crew is wrong: crew never become the first mate.
      if (!warnedCrewClaims.has(claim)) { warnedCrewClaims.add(claim); log?.(`ignoring the first-mate claim on ${claim}: fleet.json lists it as crew`); }
      continue;
    }
    agents ??= await port.listAgents({ local: true });
    const hit = agents.find((a) => a.id === claim && !a.archived && isLocal(a)); // archived agents are not live
    if (hit) return { id: hit.id, status: hit.status };
  }
  const list = (await port.listAgents({ label, local: true })).filter((a) => !crew.has(a.id) && isLocal(a));
  if (!list.length) return null;
  // A closed agent is a worse target than a live one, whatever its age.
  const rated = list.map((a) => ({ a, created: Date.parse(a.createdAt ?? "") || 0 }));
  rated.sort((x, y) => Number(y.a.status !== "closed") - Number(x.a.status !== "closed") || y.created - x.created);
  return { id: rated[0].a.id, status: rated[0].a.status };
}

/**
 * Deliver `message` to the first mate; resolves to the agent id used.
 * `early` is a first-mate lookup started a moment ago (while the batch window was open); if sending to it
 * fails, the first mate is resolved afresh and the send retried once.
 */
export async function sendToFirstMate(ports: PortSelector, label: string, message: string, early?: Promise<FirstMate | null>, root?: string, log?: (msg: string) => void, project?: string): Promise<string> {
  let fm: FirstMate | null = null;
  if (early) { try { fm = await early; } catch {} }
  if (fm) {
    try {
      await ports.send(fm.id, message);
      return fm.id;
    } catch {}
  }
  fm = await resolveFirstMate(ports.current(), label, root, log, project);
  if (!fm) throw new NoFirstMateError();
  await ports.send(fm.id, message);
  return fm.id;
}
