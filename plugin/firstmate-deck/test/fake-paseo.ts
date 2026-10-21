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
};

export type FakeSent = { id: string; text: string; options: unknown };
export type FakeRow = { agentId: string; item: unknown };

export class FakeWorld {
  agents = new Map<string, FakeAgent>();
  calls: string[] = [];
  sent: FakeSent[] = [];
  rows: FakeRow[] = [];
  sendFails = false;
  refetchFails = new Set<string>();
  add(...as: FakeAgent[]) { for (const a of as) this.agents.set(a.id, a); return this; }
  count(prefix: string) { return this.calls.filter((c) => c.startsWith(prefix)).length; }
}

export function snapshot(a: FakeAgent): PaseoAgent {
  return {
    id: a.id, provider: "claude", cwd: "/tmp", model: a.model === undefined ? "claude-sonnet-5-5" : a.model,
    createdAt: a.createdAt ?? "2026-10-21T10:00:00.000Z", updatedAt: a.updatedAt ?? "2026-10-21T10:05:00.000Z", lastUserMessageAt: null,
    status: a.status ?? "idle",
    capabilities: { supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: true, supportsMcpServers: true, supportsReasoningStream: true, supportsToolInvocations: true },
    currentModeId: null, availableModes: [], pendingPermissions: [], persistence: null,
    title: a.title ?? null, labels: a.labels ?? {},
    effectiveThinkingOptionId: a.thinking ?? null, archivedAt: a.archivedAt ?? null,
  };
}

type Page = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>;

export function fakePaseo(world: FakeWorld): PaseoApi {
  const handle = (id: string) => {
    const get = () => world.agents.get(id);
    const h = {
      id,
      current: () => (get() ? snapshot(get()!) : null),
      refresh: async () => { world.calls.push(`refresh:${id}`); return get() ? { agent: snapshot(get()!), project: null } : null; },
      send: async (text: string, options?: unknown) => {
        world.calls.push(`send:${id}`);
        if (world.sendFails) throw new Error("daemon down");
        world.sent.push({ id, text, options });
      },
      timeline: {
        append: async (item: unknown) => { world.calls.push(`append:${id}`); world.rows.push({ agentId: id, item }); return { seq: 1, epoch: "e" }; },
        refetch: async (opts?: { limit?: number; direction?: string; projection?: string }): Promise<Page> => {
          world.calls.push(`refetch:${id}`);
          const a = get();
          if (!a || world.refetchFails.has(id)) throw new Error(`agent ${id} unavailable`);
          const items = (a.items ?? []).slice(-(opts?.limit ?? 200));
          return {
            requestId: "r", agentId: id, agent: snapshot(a), direction: "tail", projection: "projected", epoch: "e", reset: true, staleCursor: false, gap: false,
            window: { minSeq: 1, maxSeq: items.length, nextSeq: items.length + 1 }, startCursor: null, endCursor: null, hasOlder: !!a.hasOlder, hasNewer: false, error: null,
            entries: items.map((item, i) => ({ provider: "claude", item, timestamp: "2026-10-21T10:00:00.000Z", seqStart: i + 1, seqEnd: i + 1, sourceSeqRanges: [], collapsed: [] })),
          };
        },
      },
    };
    return h as unknown as PaseoAgentHandle;
  };
  const agents = {
    ref: (id: string | PaseoAgent) => handle(typeof id === "string" ? id : id.id),
    list: async (o?: { filter?: { labels?: Record<string, string> } }) => {
      world.calls.push(`list${o?.filter?.labels ? ":" + JSON.stringify(o.filter.labels) : ""}`);
      const want = Object.entries(o?.filter?.labels ?? {});
      const entries = [...world.agents.values()]
        .filter((a) => !a.archivedAt && want.every(([k, v]) => a.labels?.[k] === v))
        .map((a) => ({ agent: snapshot(a), project: null }));
      return { requestId: "r", entries, pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } };
    },
  };
  return { agents } as unknown as PaseoApi;
}

// timeline item builders
export const tool = (detail: Extract<TimelineItem, { type: "tool_call" }>["detail"], name = "x") =>
  ({ type: "tool_call", callId: name + Math.random(), name, detail, status: "completed", error: null }) as TimelineItem;
export const shell = (command: string) => tool({ type: "shell", command }, "Bash");
export const assistant = (text: string) => ({ type: "assistant_message", text }) as TimelineItem;
export const thought = (text: string) => ({ type: "reasoning", text }) as TimelineItem;
