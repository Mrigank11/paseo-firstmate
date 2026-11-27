// Hook events for crews on remote Paseo hosts. The daemon's plugin hooks (agent.turn_started, agent.turn_ended, ...) fire only
// for local agents, so a crew on another host (the Mac) would never wake the first mate, nudge the enforcer or reach the
// permission hook. For every online host this module holds one agent-list subscription over the host link
// (`hosts.client(serverId).agents.list({ subscribe })`), diffs each agent snapshot against the last one it saw, and synthesizes
// the same hook payloads, which the caller feeds to the very handlers the local hooks use.
//
// Transitions (one emit each, `fm.task` agents only by default):
//   running -> idle             agent.turn_ended (completed; turnId = the activeTurn it had; timeline = that turn's tail)
//   running -> error            agent.turn_ended (failed, the agent's lastError)
//   running(t1) -> running(t2)  agent.turn_ended(t1) then agent.turn_started(t2)
//   idle -> running             agent.turn_started
//   pending permission appears  agent.permission_requested (the full request); disappears: agent.permission_resolved
//   status closed / archivedAt  agent.closed / agent.archived
// A first sighting is a baseline and emits nothing, except a permission already pending (nothing else would ever answer it;
// the permission hook dedups on its own log). An offline host is unknown, not closed: its subscription is dropped and nothing is
// emitted, but its last-known state is kept, so on reconnect a turn that ended meanwhile still produces exactly one turn_ended
// (also a whole turn that started and ended while offline: idle -> idle with a newer lastUserMessageAt). A failed subscription is
// released and recreated with backoff from a fresh host handle, and a periodic re-list catches anything the stream missed.

export type HookName =
  | "agent.turn_started"
  | "agent.turn_ended"
  | "agent.permission_requested"
  | "agent.permission_resolved"
  | "agent.archived"
  | "agent.closed";

/** A pending permission request as the snapshot carries it (AgentPermissionRequest: id, provider, name, kind, input, detail, ...). */
export type RemotePermission = { readonly id: string };

/** The fields of an agent snapshot (AgentSnapshotPayload) this module reads. */
export type RemoteAgent = {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  title: string | null;
  status: string;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  pendingPermissions?: readonly RemotePermission[];
  archivedAt?: string | null;
  updatedAt: string;
  lastUserMessageAt: string | null;
  lastError?: string;
  labels: Record<string, string>;
  metadata?: unknown;
  background?: boolean;
};

type Observer = { snapshot(s: any): void; update(m: any): void; error?(e: unknown): void };
type RemoteSubscription = { readonly ready: Promise<unknown>; subscribe(o: Observer): () => void; release(): Promise<void> };
type ListResult = { entries: readonly { agent: RemoteAgent }[]; pageInfo: { hasMore: boolean }; subscription?: RemoteSubscription };
type TimelineEntry = { seqStart: number; turnId?: string | null; item: { type: string; text?: string } };

/** The slice of a host's PaseoApi (`hosts.client(serverId)`) used here. */
export type RemoteApi = {
  agents: {
    list(o: any): Promise<ListResult>;
    ref(id: string): {
      timeline: { refetch(o?: any): Promise<{ entries: readonly TimelineEntry[] }> };
      refresh(): Promise<{ agent: RemoteAgent } | null>;
    };
  };
};

export type HostClient = { serverId: string; label: string; api: RemoteApi };
export type HostSource = { clients(): Promise<HostClient[]>; onChange(cb: () => void): () => void };

/** What the synthesized events carry as `agent`: the hook's PluginHookAgent plus the labels and the owning host. */
export type RemoteHookAgent = {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
  background: boolean;
  metadata: unknown;
  labels: Record<string, string>;
  serverId: string;
  hostLabel: string;
};

export type RemoteEventsOptions = {
  hosts: HostSource;
  emit: (name: HookName, event: unknown) => void;
  log: (m: string) => void;
  /** Which agents matter. Default: those carrying an `fm.task` label. */
  filter?: (agent: RemoteAgent) => boolean;
  /** Timer seam (tests). Returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** First retry delay after a failed subscription; doubles up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  /** How often each host is re-listed to catch updates the stream did not deliver. */
  resyncMs?: number;
  /** A remote call that has not answered by then counts as failed (a sleeping host can leave a request hanging). */
  callTimeoutMs?: number;
  /** Timeline entries read for a turn_ended. */
  tailLimit?: number;
};

const PARENT_LABEL = "paseo.parent-agent-id";
const LIST_LIMIT = 200;
const ENDED_KEEP = 20;

type Known = {
  status: string;
  turnId: string | null;
  lastUserMessageAt: string | null;
  pending: Set<string>;
  closed: boolean;
  archived: boolean;
  ended: string[];
};

type Conn = {
  serverId: string;
  label: string;
  api: RemoteApi;
  gen: number;
  sub: RemoteSubscription | null;
  unobserve: (() => void) | null;
  cancelResync: (() => void) | null;
  cancelRetry: (() => void) | null;
  attempt: number;
};

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export function startRemoteEvents(o: RemoteEventsOptions): { stop(): void; flush(): Promise<void> } {
  const filter = o.filter ?? ((a: RemoteAgent) => typeof a.labels?.["fm.task"] === "string");
  const schedule = o.schedule ?? defaultSchedule;
  const retryMs = o.retryMs ?? 2000;
  const maxRetryMs = o.maxRetryMs ?? 60_000;
  const resyncMs = o.resyncMs ?? 5 * 60_000;
  const callTimeoutMs = o.callTimeoutMs ?? 20_000;
  const tailLimit = o.tailLimit ?? 60;

  let stopped = false;
  let gen = 0;
  const conns = new Map<string, Conn>();
  const known = new Map<string, Map<string, Known>>(); // serverId -> agentId -> last state (kept while a host is offline)
  const chains = new Map<string, Promise<unknown>>(); // per host: snapshot work is serial so emits keep their order
  let syncChain: Promise<unknown> = Promise.resolve();

  const enqueue = (serverId: string, fn: () => Promise<void>): void => {
    const run = (chains.get(serverId) ?? Promise.resolve()).then(fn).catch((e) => o.log(`remote events (${serverId}): ${(e as Error)?.stack ?? e}`));
    chains.set(serverId, run);
  };

  const timed = <T>(p: Promise<T>, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const cancel = schedule(() => reject(new Error(`${what} timed out after ${callTimeoutMs} ms`)), callTimeoutMs);
      p.then((v) => { cancel(); resolve(v); }, (e) => { cancel(); reject(e); });
    });

  const live = (c: Conn) => !stopped && conns.get(c.serverId) === c;

  // ---------- connections ----------

  const sync = (): void => {
    syncChain = syncChain.then(async () => {
      if (stopped) return;
      const clients = await o.hosts.clients().catch((e) => { o.log(`remote events: host list failed: ${e}`); return null; });
      if (!clients || stopped) return;
      const online = new Map(clients.map((c) => [c.serverId, c]));
      for (const [id, c] of conns) if (!online.has(id)) { o.log(`remote events: host ${c.label} offline, subscription dropped`); disconnect(c); }
      for (const c of clients) {
        const cur = conns.get(c.serverId);
        if (cur && cur.api === c.api) continue;
        if (cur) disconnect(cur);
        connect(c);
      }
    }).catch((e) => o.log(`remote events: sync failed: ${e}`));
  };

  const release = (c: Conn): void => {
    c.unobserve?.();
    c.unobserve = null;
    const s = c.sub;
    c.sub = null;
    if (s) void s.release().catch(() => {});
    c.cancelResync?.();
    c.cancelResync = null;
  };

  const disconnect = (c: Conn): void => {
    release(c);
    c.cancelRetry?.();
    c.cancelRetry = null;
    if (conns.get(c.serverId) === c) conns.delete(c.serverId);
  };

  const connect = (h: HostClient, attempt = 0): void => {
    const c: Conn = { serverId: h.serverId, label: h.label, api: h.api, gen: ++gen, sub: null, unobserve: null, cancelResync: null, cancelRetry: null, attempt };
    conns.set(h.serverId, c);
    enqueue(c.serverId, async () => {
      if (!live(c)) return;
      let r: ListResult;
      try {
        r = await timed(c.api.agents.list({ filter: { includeBackground: true }, page: { limit: LIST_LIMIT }, subscribe: {} }), "agent list");
      } catch (e) {
        return fail(c, e);
      }
      if (!live(c)) { void r.subscription?.release().catch(() => {}); return; }
      c.sub = r.subscription ?? null;
      c.unobserve = c.sub?.subscribe({
        snapshot: (s) => { if (live(c) && Array.isArray(s?.entries)) enqueue(c.serverId, () => diffAll(c, s.entries, !s.pageInfo?.hasMore)); },
        update: (m) => { if (live(c)) enqueue(c.serverId, () => onUpdate(c, m)); },
        error: (e) => { if (live(c)) fail(c, e); },
      }) ?? null;
      if (!c.sub) o.log(`remote events: host ${c.label} gave no subscription; relying on the re-list every ${resyncMs} ms`);
      if (r.pageInfo?.hasMore) o.log(`remote events: host ${c.label} lists more than ${LIST_LIMIT} agents; only the first page is watched`);
      c.attempt = 0;
      armResync(c);
      await diffAll(c, r.entries, !r.pageInfo?.hasMore);
    });
  };

  const armResync = (c: Conn): void => {
    c.cancelResync?.();
    c.cancelResync = schedule(() => {
      c.cancelResync = null;
      if (!live(c)) return;
      enqueue(c.serverId, async () => {
        if (!live(c)) return;
        let r: ListResult;
        try {
          r = await timed(c.api.agents.list({ filter: { includeBackground: true }, page: { limit: LIST_LIMIT } }), "agent re-list");
        } catch (e) {
          return fail(c, e);
        }
        if (!live(c)) return;
        armResync(c);
        await diffAll(c, r.entries, !r.pageInfo?.hasMore);
      });
    }, resyncMs);
  };

  /** Drop the subscription and recreate it later from a fresh handle, if the host is still online then. */
  const fail = (c: Conn, e: unknown): void => {
    if (!live(c)) return;
    release(c);
    const delay = Math.min(maxRetryMs, retryMs * 2 ** c.attempt);
    o.log(`remote events: host ${c.label} subscription failed (${(e as Error)?.message ?? e}); retry in ${delay} ms`);
    c.cancelRetry?.();
    c.cancelRetry = schedule(() => {
      c.cancelRetry = null;
      if (!live(c)) return;
      syncChain = syncChain.then(async () => {
        if (!live(c)) return;
        const fresh = (await o.hosts.clients().catch(() => [] as HostClient[])).find((x) => x.serverId === c.serverId);
        if (!live(c)) return;
        if (!fresh) { disconnect(c); return; } // offline: onChange reconnects when it is back
        connect(fresh, c.attempt + 1);
      }).catch((err) => o.log(`remote events: retry failed: ${err}`));
    }, delay);
  };

  // ---------- diffing ----------

  const state = (serverId: string) => {
    let m = known.get(serverId);
    if (!m) known.set(serverId, (m = new Map()));
    return m;
  };

  const onUpdate = async (c: Conn, m: any): Promise<void> => {
    const p = m?.type === "agent_update" ? m.payload : m;
    if (p?.kind === "upsert" && p.agent) return diffAgent(c, p.agent, false);
    if (p?.kind === "remove" && typeof p.agentId === "string") return onRemoved(c, p.agentId);
  };

  /** A full list: every agent diffed; a known agent missing from a complete list is looked up like a removal. */
  const diffAll = async (c: Conn, entries: readonly { agent: RemoteAgent }[], complete: boolean): Promise<void> => {
    const seen = new Set<string>();
    for (const e of entries) {
      if (!live(c)) return;
      seen.add(e.agent.id);
      await diffAgent(c, e.agent, true);
    }
    if (!complete) return;
    for (const id of [...state(c.serverId).keys()]) if (!seen.has(id) && live(c)) await onRemoved(c, id);
  };

  /** Gone from the live list: archived (the list hides archived agents), closed, or deleted. */
  const onRemoved = async (c: Conn, id: string): Promise<void> => {
    const k = state(c.serverId);
    const prev = k.get(id);
    if (!prev || prev.archived) return;
    const r = await timed(c.api.agents.ref(id).refresh(), "agent refresh").catch(() => undefined);
    if (r === undefined || !live(c)) return; // unknown: keep the last state, the next list decides
    if (r?.agent) return diffAgent(c, r.agent, false);
    k.delete(id); // deleted: nothing to report
  };

  const hookAgent = (c: Conn, a: RemoteAgent): RemoteHookAgent => ({
    id: a.id,
    workspaceId: a.workspaceId ?? null,
    parentAgentId: a.labels?.[PARENT_LABEL] ?? null,
    provider: a.provider,
    cwd: a.cwd,
    title: a.title ?? null,
    background: !!a.background,
    metadata: a.metadata ?? {},
    labels: a.labels ?? {},
    serverId: c.serverId,
    hostLabel: c.label,
  });

  const emit = (c: Conn, name: HookName, event: unknown): void => {
    if (!live(c)) return;
    try {
      o.emit(name, event);
    } catch (e) {
      o.log(`remote events: ${name} handler threw: ${(e as Error)?.stack ?? e}`);
    }
  };

  const diffAgent = async (c: Conn, a: RemoteAgent, full: boolean): Promise<void> => {
    const k = state(c.serverId);
    if (!filter(a)) { k.delete(a.id); return; }
    const turnId = a.activeTurn?.turnId ?? null;
    const pendingNow = new Map((a.pendingPermissions ?? []).map((p) => [p.id, p]));
    const closed = a.status === "closed";
    const archived = !!a.archivedAt;
    const prev = k.get(a.id);
    const agent = hookAgent(c, a);

    if (!prev) {
      const base: Known = { status: a.status, turnId, lastUserMessageAt: a.lastUserMessageAt ?? null, pending: new Set(), closed, archived, ended: [] };
      k.set(a.id, base);
      for (const [id, req] of pendingNow) { base.pending.add(id); emit(c, "agent.permission_requested", { agent, request: req }); }
      return;
    }

    const wasRunning = prev.status === "running";
    const nowRunning = a.status === "running";
    if (wasRunning && nowRunning && prev.turnId && turnId && turnId !== prev.turnId) {
      await endTurn(c, a, prev, prev.turnId, { kind: "completed" });
      emit(c, "agent.turn_started", { agent, turnId });
    } else if (wasRunning && !nowRunning) {
      if (a.status === "error") await endTurn(c, a, prev, prev.turnId, { kind: "failed", error: { message: a.lastError || "agent error" } });
      else if (!closed) await endTurn(c, a, prev, prev.turnId, { kind: "completed" });
    } else if (!wasRunning && nowRunning) {
      emit(c, "agent.turn_started", { agent, turnId });
    } else if (full && !wasRunning && a.status === "idle" && a.lastUserMessageAt && a.lastUserMessageAt !== prev.lastUserMessageAt) {
      // a whole turn while we were not watching (host offline, or updates missed): the tail names it
      await endTurn(c, a, prev, null, { kind: "completed" });
    }
    if (!live(c)) return;

    for (const [id, req] of pendingNow) if (!prev.pending.has(id)) emit(c, "agent.permission_requested", { agent, request: req });
    for (const id of prev.pending) if (!pendingNow.has(id)) emit(c, "agent.permission_resolved", { agent, requestId: id, resolution: null });
    if (closed && !prev.closed) emit(c, "agent.closed", { agent });
    if (archived && !prev.archived) emit(c, "agent.archived", { agent, archivedAt: a.archivedAt });

    prev.status = a.status;
    prev.turnId = turnId ?? (nowRunning ? prev.turnId : null);
    prev.lastUserMessageAt = a.lastUserMessageAt ?? prev.lastUserMessageAt;
    prev.pending = new Set(pendingNow.keys());
    prev.closed = closed;
    prev.archived = archived;
  };

  /** One turn_ended per turn id. `timeline` is the turn's own tail, read over the host link (the gate reads it from there). */
  const endTurn = async (c: Conn, a: RemoteAgent, prev: Known, turnId: string | null, outcome: unknown): Promise<void> => {
    if (turnId && prev.ended.includes(turnId)) return;
    let entries: TimelineEntry[] = [];
    try {
      const page = await timed(c.api.agents.ref(a.id).timeline.refetch({ direction: "tail", limit: tailLimit, projection: "projected" }), "timeline tail");
      entries = [...page.entries].sort((x, y) => x.seqStart - y.seqStart);
    } catch (e) {
      o.log(`remote events: tail of ${a.id} unreadable (${(e as Error)?.message ?? e}); turn_ended without a timeline`);
    }
    if (!live(c)) return;
    const tid = turnId ?? entries.at(-1)?.turnId ?? null;
    if (!turnId && (!tid || prev.ended.includes(tid))) return; // a missed turn we cannot name, or one already reported
    const own = tid ? entries.filter((e) => e.turnId === tid) : [];
    const timeline = (own.length ? own : entries).map((e) => e.item);
    if (tid) { prev.ended.push(tid); if (prev.ended.length > ENDED_KEEP) prev.ended.shift(); }
    emit(c, "agent.turn_ended", { agent: hookAgent(c, a), turnId: tid, outcome, timeline });
  };

  // ---------- lifecycle ----------

  const offChange = o.hosts.onChange(() => sync());
  sync();

  return {
    stop(): void {
      if (stopped) return;
      offChange();
      for (const c of [...conns.values()]) disconnect(c);
      stopped = true;
    },
    /** Resolves once every queued sync and snapshot diff has run (tests; also a clean shutdown). */
    async flush(): Promise<void> {
      for (;;) {
        const before = [syncChain, ...chains.values()];
        await Promise.all(before);
        const after = [syncChain, ...chains.values()];
        if (after.length === before.length && after.every((p, i) => p === before[i])) return;
      }
    },
  };
}
