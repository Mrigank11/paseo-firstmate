// A fake `context.paseo` shaped by the real SDK types (PaseoApi / PaseoAgent / the timeline page), recording calls.
import type { PaseoAgent, PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import type { TimelineItem } from "../server/paseo-port.ts";

export type FakeAgent = {
  id: string;
  status?: PaseoAgent["status"];
  labels?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
  model?: string | null;
  thinking?: string | null;
  archivedAt?: string | null;
  title?: string | null;
  items?: TimelineItem[];
  /** The page reports older entries beyond the tail. */
  hasOlder?: boolean;
  pendingPermissions?: unknown[];
  cwd?: string;
  /** A background agent (MCP `create_agent` from another agent): listed only when the filter says `includeBackground`. */
  background?: boolean;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  lastUserMessageAt?: string | null;
  /** Timeline entries carry this turn id. */
  turnId?: string;
};

type Observer = { snapshot(s: unknown): void; update(m: unknown): void; error?(e: unknown): void };

export type FakeSent = { id: string; text: string; options: unknown };
export type FakeRow = { agentId: string; item: unknown };

export class FakeWorld {
  agents = new Map<string, FakeAgent>();
  calls: string[] = [];
  sent: FakeSent[] = [];
  rows: FakeRow[] = [];
  sendFails = false;
  responded: { id: string; requestId: string; response: unknown }[] = [];
  respondFails = false;
  refetchFails = new Set<string>();
  listFails = false;
  /** Every call that reaches the daemon never answers (a sleeping host). */
  hang = false;
  observers = new Set<Observer>();
  /** Change an agent and push the upsert to the agent-list subscribers. */
  upsert(a: FakeAgent) { this.add(a); for (const o of [...this.observers]) o.update({ type: "agent_update", payload: { kind: "upsert", agent: snapshot(a) } }); return this; }
  add(...as: FakeAgent[]) { for (const a of as) this.agents.set(a.id, a); return this; }
  count(prefix: string) { return this.calls.filter((c) => c.startsWith(prefix)).length; }
}

export function snapshot(a: FakeAgent): PaseoAgent {
  return {
    id: a.id, provider: "claude", cwd: a.cwd ?? "/tmp", model: a.model === undefined ? "claude-sonnet-5-5" : a.model,
    createdAt: a.createdAt ?? "2026-10-21T10:00:00.000Z", updatedAt: a.updatedAt ?? "2026-10-21T10:05:00.000Z", lastUserMessageAt: a.lastUserMessageAt ?? null,
    status: a.status ?? "idle",
    capabilities: { supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: true, supportsMcpServers: true, supportsReasoningStream: true, supportsToolInvocations: true },
    currentModeId: null, availableModes: [], pendingPermissions: (a.pendingPermissions ?? []) as never[], persistence: null,
    ...(a.activeTurn !== undefined ? { activeTurn: a.activeTurn } : {}),
    title: a.title ?? null, labels: a.labels ?? {},
    effectiveThinkingOptionId: a.thinking ?? null, archivedAt: a.archivedAt ?? null,
  };
}

type Page = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>;

export type FakeHost = {
  serverId: string;
  label: string;
  world: FakeWorld;
  status?: "online" | "offline" | "connecting" | "error" | "disabled";
  enabled?: boolean;
  lastOnlineAt?: string | null;
  /** `hosts.client()` fails. */
  clientFails?: boolean;
  /** Clients handed out, and how many of them were disposed. */
  built?: number;
  disposed?: number;
};

/** The local daemon's host directory: `hosts.list()` and `hosts.client(serverId)`, each client a fakePaseo over that host's world. */
export class FakeHosts {
  self = "srv_local";
  hosts: FakeHost[];
  lists = 0;
  listFails = false;
  constructor(...hosts: FakeHost[]) { this.hosts = hosts; }
  actions() {
    return {
      list: async () => {
        this.lists++;
        if (this.listFails) throw new Error("hosts unsupported");
        return {
          self: { serverId: this.self, label: "linux" },
          hosts: this.hosts.map((h) => ({
            registrationId: `r-${h.serverId}`, serverId: h.serverId, label: h.label, source: { id: "s", key: "k" }, metadata: {}, enabled: h.enabled ?? true,
            status: h.status ?? "online", targetDescription: `tcp://${h.label}:6767`, lastOnlineAt: h.lastOnlineAt ?? null, nextRetryAt: null, error: null,
          })),
        };
      },
      client: async (serverId: string) => {
        const h = this.hosts.find((x) => x.serverId === serverId);
        if (!h || h.clientFails || (h.status ?? "online") !== "online") throw new Error(`Host ${serverId} is offline`);
        h.built = (h.built ?? 0) + 1;
        return { ...fakePaseo(h.world), dispose: async () => { h.disposed = (h.disposed ?? 0) + 1; } } as unknown as PaseoApi;
      },
    };
  }
}

export function fakePaseo(world: FakeWorld, hosts?: FakeHosts): PaseoApi {
  const reach = () => (world.hang ? new Promise<never>(() => {}) : Promise.resolve());
  const handle = (id: string) => {
    const get = () => world.agents.get(id);
    const h = {
      id,
      current: () => (get() ? snapshot(get()!) : null),
      refresh: async () => { world.calls.push(`refresh:${id}`); await reach(); return get() ? { agent: snapshot(get()!), project: null } : null; },
      send: async (text: string, options?: unknown) => {
        world.calls.push(`send:${id}`);
        await reach();
        if (world.sendFails) throw new Error("daemon down");
        if (!get()) throw new Error(`agent ${id} not found`);
        world.sent.push({ id, text, options });
      },
      respondToPermission: async (o: { requestId: string; response: unknown }) => {
        world.calls.push(`respond:${id}`);
        await reach();
        if (world.respondFails) throw new Error("no such request");
        world.responded.push({ id, requestId: o.requestId, response: o.response });
      },
      timeline: {
        append: async (item: unknown) => { world.calls.push(`append:${id}`); world.rows.push({ agentId: id, item }); return { seq: 1, epoch: "e" }; },
        refetch: async (opts?: { limit?: number; direction?: string; projection?: string }): Promise<Page> => {
          world.calls.push(`refetch:${id}`);
          await reach();
          const a = get();
          if (!a || world.refetchFails.has(id)) throw new Error(`agent ${id} unavailable`);
          const items = (a.items ?? []).slice(-(opts?.limit ?? 200));
          return {
            requestId: "r", agentId: id, agent: snapshot(a), direction: "tail", projection: "projected", epoch: "e", reset: true, staleCursor: false, gap: false,
            window: { minSeq: 1, maxSeq: items.length, nextSeq: items.length + 1 }, startCursor: null, endCursor: null, hasOlder: !!a.hasOlder, hasNewer: false, error: null,
            entries: items.map((item, i) => ({ provider: "claude", item, ...(a.turnId ? { turnId: a.turnId } : {}), timestamp: "2026-10-21T10:00:00.000Z", seqStart: i + 1, seqEnd: i + 1, sourceSeqRanges: [], collapsed: [] })),
          };
        },
      },
    };
    return h as unknown as PaseoAgentHandle;
  };
  const agents = {
    ref: (id: string | PaseoAgent) => handle(typeof id === "string" ? id : id.id),
    list: async (o?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean; includeBackground?: boolean }; subscribe?: object }) => {
      world.calls.push(`list${o?.filter?.labels ? ":" + JSON.stringify(o.filter.labels) : ""}`);
      await reach();
      if (world.listFails) throw new Error("list failed");
      const want = Object.entries(o?.filter?.labels ?? {});
      const entries = [...world.agents.values()]
        .filter((a) => (o?.filter?.includeArchived || !a.archivedAt) && (o?.filter?.includeBackground || !a.background) && want.every(([k, v]) => a.labels?.[k] === v))
        .map((a) => ({ agent: snapshot(a), project: null }));
      let mine: Observer | null = null;
      const subscription = o?.subscribe ? {
        ready: Promise.resolve({}),
        subscribe: (ob: Observer) => { mine = ob; world.observers.add(ob); return () => { world.observers.delete(ob); }; },
        release: async () => { if (mine) world.observers.delete(mine); },
      } : undefined;
      return { requestId: "r", entries, pageInfo: { nextCursor: null, prevCursor: null, hasMore: false }, ...(subscription ? { subscription } : {}) };
    },
  };
  return { agents, ...(hosts ? { hosts: hosts.actions() } : {}) } as unknown as PaseoApi;
}

// timeline item builders
export const tool = (detail: Extract<TimelineItem, { type: "tool_call" }>["detail"], name = "x") =>
  ({ type: "tool_call", callId: name + Math.random(), name, detail, status: "completed", error: null }) as TimelineItem;
export const shell = (command: string) => tool({ type: "shell", command }, "Bash");
export const assistant = (text: string) => ({ type: "assistant_message", text }) as TimelineItem;
export const thought = (text: string) => ({ type: "reasoning", text }) as TimelineItem;
