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
// emitted, but its last-known state is kept (and saved in state/remote-turns.json, so a plugin restart keeps it too): on reconnect
// a turn that ended meanwhile still produces exactly one turn_ended, for the latest such turn (also a whole turn that started and
// ended while offline: idle -> idle with a newer lastUserMessageAt). A failed subscription is released, its host client dropped,
// and both are rebuilt with backoff; a periodic re-list catches anything the stream missed.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hosts } from "./hosts.ts";
import { writeAtomic } from "./store.ts";

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
type ListResult = { entries: readonly { agent: RemoteAgent }[]; pageInfo: { hasMore: boolean; nextCursor?: string | null }; subscription?: RemoteSubscription };
type TimelineEntry = { seqStart: number; turnId?: string | null; timestamp?: string; item: { type: string; text?: string } };

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
export type HostSource = {
  clients(): Promise<HostClient[]>;
  onChange(cb: () => void): () => void;
  /** Forget a client whose link failed: the next `clients()` builds a new one. */
  drop?(serverId: string, api?: unknown): void;
};

/** What is remembered of one agent between runs. */
export type SavedAgent = {
  status: string;
  /** The last status seen (`status` stays behind while a turn's end cannot be told yet). */
  seen?: string;
  turnId: string | null;
  lastUserMessageAt: string | null;
  updatedAt: string | null;
  closed: boolean;
  archived: boolean;
  /** Turn ids already reported. */
  ended: string[];
};
export type SavedState = { version: 1; hosts: Record<string, Record<string, SavedAgent>> };
/** `load`: null = nothing saved yet; undefined = cannot tell yet (asked again shortly). */
export type StateStore = { load(): SavedState | null | undefined; save(s: SavedState): void };

/** state/remote-turns.json of the first-mate checkout. Derived data: deleting it only makes the next sighting a baseline. */
export function fileStore(root: () => string): StateStore {
  const path = () => join(root(), "state", "remote-turns.json");
  return {
    load() {
      if (!root()) return undefined;
      try {
        const s = JSON.parse(readFileSync(path(), "utf8"));
        return s?.version === 1 && s.hosts && typeof s.hosts === "object" ? (s as SavedState) : null;
      } catch {
        return null;
      }
    },
    save(s) {
      if (!root()) return;
      mkdirSync(join(root(), "state"), { recursive: true });
      writeAtomic(path(), JSON.stringify(s));
    },
  };
}

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
  /** The status it had in the snapshot the event came from. */
  status: string;
  serverId: string;
  hostLabel: string;
};

export type RemoteEventsOptions = {
  hosts: HostSource;
  emit: (name: HookName, event: unknown) => void;
  log: (m: string) => void;
  /** Where the last-known state survives a restart. Without one a restart starts from a new baseline. */
  store?: StateStore;
  /** How often the host list is asked again (a reconnect nothing announced). */
  syncMs?: number;
  /** Which agents matter. Default: those carrying an `fm.task` label. */
  /** Is that agent of that host ours (ownership.ts)? One that is not raises nothing and is never read. */
  owns: (serverId: string, agent: RemoteAgent) => Promise<boolean>;
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
  /** How long a crew that closed while working must stay closed, on a host still online, before that is reported. */
  closeGraceMs?: number;
  /** Timeline entries read for a turn_ended. */
  tailLimit?: number;
};

const PARENT_LABEL = "paseo.parent-agent-id";
const LIST_LIMIT = 200;
const MAX_PAGES = 10;
const ENDED_KEEP = 20;
export const CLOSE_GRACE_MS = 15_000;
const WORKING = new Set(["running", "initializing"]);
/** How often an unreadable tail is asked again before the turn is reported without it. */
const TAIL_TRIES = 3;
/** Timeline rows that say nothing about whether a message was answered. */
const NOT_A_REPLY = new Set(["plugin", "notification"]);

type Known = SavedAgent & { pending: Set<string>; tailFails: number };

type Conn = {
  serverId: string;
  label: string;
  api: RemoteApi;
  gen: number;
  sub: RemoteSubscription | null;
  unobserve: (() => void) | null;
  cancelResync: (() => void) | null;
  cancelRetry: (() => void) | null;
  /** A short re-list asked for by an unreadable tail. */
  cancelSoon: (() => void) | null;
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
  const syncMs = o.syncMs ?? 30_000;
  const callTimeoutMs = o.callTimeoutMs ?? 20_000;
  const tailLimit = o.tailLimit ?? 60;
  const closeGraceMs = o.closeGraceMs ?? CLOSE_GRACE_MS;

  let stopped = false;
  let gen = 0;
  const conns = new Map<string, Conn>();
  const known = new Map<string, Map<string, Known>>(); // serverId -> agentId -> last state (kept while a host is offline)
  const chains = new Map<string, Promise<unknown>>(); // per host: snapshot work is serial so emits keep their order
  let syncChain: Promise<unknown> = Promise.resolve();
  /** "serverId/agentId" -> cancel: crews that closed while working, waiting out their grace. */
  const closing = new Map<string, () => void>();
  const forgetClose = (key: string): void => { closing.get(key)?.(); closing.delete(key); };
  /** A close that cannot be confirmed now (host away, plugin stopping) is judged again when the crew is next seen. */
  const unsettle = (key: string): void => {
    forgetClose(key);
    const slash = key.indexOf("/");
    const k = known.get(key.slice(0, slash))?.get(key.slice(slash + 1));
    if (k) { k.closed = false; k.seen = "running"; }
  };

  const enqueue = (serverId: string, fn: () => Promise<void>): void => {
    const run = (chains.get(serverId) ?? Promise.resolve()).then(fn).catch((e) => o.log(`remote events (${serverId}): ${(e as Error)?.stack ?? e}`)).then(save);
    chains.set(serverId, run);
  };

  // ---------- the saved state ----------

  let loaded = !o.store;
  let saved = "";
  let cancelWait: (() => void) | null = null;

  const load = (): boolean => {
    if (loaded) return true;
    const s = o.store!.load();
    if (s === undefined) return false;
    for (const [serverId, agents] of Object.entries(s?.hosts ?? {})) {
      known.set(serverId, new Map(Object.entries(agents).map(([id, a]) => [id, { ...a, ended: a.ended ?? [], pending: new Set<string>(), tailFails: 0 }])));
    }
    return (loaded = true);
  };

  const save = (): void => {
    if (stopped || !o.store || !loaded) return;
    const hosts: SavedState["hosts"] = {};
    for (const [serverId, agents] of known) {
      hosts[serverId] = Object.fromEntries([...agents].map(([id, { pending: _p, tailFails: _t, ...a }]) => [id, a]));
    }
    const body = JSON.stringify(hosts);
    if (body === saved) return;
    try { o.store.save({ version: 1, hosts }); saved = body; }
    catch (e) { o.log(`remote events: could not save state: ${(e as Error).message}`); }
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
      if (!load()) {
        cancelWait?.();
        cancelWait = schedule(() => { cancelWait = null; sync(); }, retryMs);
        return;
      }
      const clients = await o.hosts.clients().catch((e) => { o.log(`remote events: host list failed: ${e}`); return null; });
      if (!clients || stopped) return;
      const online = new Map(clients.map((c) => [c.serverId, c]));
      // a host that went offline: what closed on it just before says nothing yet (quitting Paseo closes every agent first)
      for (const key of [...closing.keys()]) if (!online.has(key.slice(0, key.indexOf("/")))) unsettle(key);
      save();
      for (const [id, c] of conns) if (!online.has(id)) { o.log(`remote events: host ${c.label} offline, subscription dropped`); disconnect(c); }
      for (const c of clients) {
        const cur = conns.get(c.serverId);
        if (cur && (cur.api === c.api || cur.cancelRetry)) continue; // a pending retry keeps its backoff
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
    c.cancelSoon?.();
    c.cancelSoon = null;
  };

  const disconnect = (c: Conn): void => {
    release(c);
    c.cancelRetry?.();
    c.cancelRetry = null;
    if (conns.get(c.serverId) === c) conns.delete(c.serverId);
  };

  const query = (extra: object = {}, cursor?: string) => ({ filter: { includeBackground: true }, page: { limit: LIST_LIMIT, ...(cursor ? { cursor } : {}) }, ...extra });

  /** The pages after `first`. `complete` is false when the walk stopped early. */
  const rest = async (c: Conn, first: ListResult): Promise<{ entries: { agent: RemoteAgent }[]; complete: boolean }> => {
    const entries = [...first.entries];
    let page = first.pageInfo;
    for (let n = 1; n < MAX_PAGES && page?.hasMore && page.nextCursor; n++) {
      const r = await timed(c.api.agents.list(query({}, page.nextCursor)), "agent list");
      entries.push(...r.entries);
      page = r.pageInfo;
    }
    return { entries, complete: !page?.hasMore };
  };

  const connect = (h: HostClient, attempt = 0): void => {
    const c: Conn = { serverId: h.serverId, label: h.label, api: h.api, gen: ++gen, sub: null, unobserve: null, cancelResync: null, cancelRetry: null, cancelSoon: null, attempt };
    conns.set(h.serverId, c);
    enqueue(c.serverId, async () => {
      if (!live(c)) return;
      let r: ListResult;
      const asked = Promise.resolve().then(() => c.api.agents.list(query({ subscribe: {} })));
      try {
        r = await timed(asked, "agent list");
      } catch (e) {
        void asked.then((late) => late.subscription?.release()).catch(() => {}); // answered too late: do not keep it
        return fail(c, e);
      }
      if (!live(c)) { void r.subscription?.release().catch(() => {}); return; }
      c.sub = r.subscription ?? null;
      c.unobserve = c.sub?.subscribe({
        snapshot: (s) => {
          if (!live(c) || !Array.isArray(s?.entries)) return;
          enqueue(c.serverId, () => diffAll(c, s.entries, !s.pageInfo?.hasMore));
          if (s.pageInfo?.hasMore) enqueue(c.serverId, () => resync(c));
        },
        update: (m) => { if (live(c)) enqueue(c.serverId, () => onUpdate(c, m)); },
        error: (e) => { if (live(c)) fail(c, e); },
      }) ?? null;
      if (!c.sub) o.log(`remote events: host ${c.label} gave no subscription; relying on the re-list every ${resyncMs} ms`);
      let all: { entries: { agent: RemoteAgent }[]; complete: boolean };
      try { all = await rest(c, r); } catch (e) { return fail(c, e); }
      if (!live(c)) return;
      c.attempt = 0;
      armResync(c);
      await diffAll(c, all.entries, all.complete);
    });
  };

  const resync = async (c: Conn): Promise<void> => {
    if (!live(c)) return;
    let all: { entries: { agent: RemoteAgent }[]; complete: boolean };
    try {
      all = await rest(c, await timed(c.api.agents.list(query()), "agent re-list"));
    } catch (e) {
      return fail(c, e);
    }
    if (!live(c)) return;
    armResync(c);
    await diffAll(c, all.entries, all.complete);
  };

  const armResync = (c: Conn): void => {
    c.cancelResync?.();
    c.cancelResync = schedule(() => {
      c.cancelResync = null;
      if (live(c)) enqueue(c.serverId, () => resync(c));
    }, resyncMs);
  };

  const soon = (c: Conn): void => {
    c.cancelSoon ??= schedule(() => {
      c.cancelSoon = null;
      if (live(c)) enqueue(c.serverId, () => resync(c));
    }, retryMs);
  };

  /** Drop the subscription and the client, and recreate both later, if the host is still online then. */
  const fail = (c: Conn, e: unknown): void => {
    if (!live(c)) return;
    release(c);
    o.hosts.drop?.(c.serverId, c.api);
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
        if (!fresh) { disconnect(c); return; } // offline: onChange or the periodic sync reconnects when it is back
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
    status: a.status,
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

  /** agent.closed, once the grace has passed with the host still online and the agent still closed there. */
  const closeLater = (serverId: string, id: string): void => {
    const key = `${serverId}/${id}`;
    forgetClose(key);
    closing.set(key, schedule(() => enqueue(serverId, async () => {
      if (!closing.delete(key)) return;
      const h = (await o.hosts.clients()).find((x) => x.serverId === serverId);
      const r = h && (await timed(h.api.agents.ref(id).refresh(), "agent refresh").catch(() => undefined));
      const c = conns.get(serverId);
      if (!c || r === undefined) return unsettle(key);
      if (r?.agent?.status === "closed") emit(c, "agent.closed", { agent: hookAgent(c, r.agent) });
    }), closeGraceMs));
  };

  const diffAgent = async (c: Conn, a: RemoteAgent, full: boolean): Promise<void> => {
    const k = state(c.serverId);
    if (!filter(a)) { k.delete(a.id); return; }
    const ours = await o.owns(c.serverId, a).catch(() => null);
    if (ours === null || !live(c)) return; // could not be told: decides nothing
    if (!ours) { k.delete(a.id); return; }
    const turnId = a.activeTurn?.turnId ?? null;
    const pendingNow = new Map((a.pendingPermissions ?? []).map((p) => [p.id, p]));
    const closed = a.status === "closed";
    const archived = !!a.archivedAt;
    const prev = k.get(a.id);
    const agent = hookAgent(c, a);

    if (!prev) {
      const base: Known = { status: a.status, seen: a.status, turnId, lastUserMessageAt: a.lastUserMessageAt ?? null, updatedAt: a.updatedAt ?? null, pending: new Set(), closed, archived, ended: [], tailFails: 0 };
      k.set(a.id, base);
      for (const [id, req] of pendingNow) { base.pending.add(id); emit(c, "agent.permission_requested", { agent, request: req }); }
      return;
    }
    // the stream and a re-list can overtake each other: never step back
    if (prev.updatedAt && a.updatedAt && Date.parse(a.updatedAt) < Date.parse(prev.updatedAt)) return;

    // `status` waits for a turn's end to be told; `seen` is what the agent last was
    const was = prev.seen ?? prev.status;
    prev.seen = a.status;
    const wasRunning = prev.status === "running";
    const nowRunning = a.status === "running";
    const newMessage = !!a.lastUserMessageAt && a.lastUserMessageAt !== prev.lastUserMessageAt;
    const outcome = a.status === "error" ? { kind: "failed", error: { message: a.lastError || "agent error" } } : { kind: "completed" };
    const started = () => emit(c, "agent.turn_started", { agent, turnId, startedAt: a.activeTurn?.startedAt ?? undefined });
    // false: the turn's end could not be told yet, so the turn state is not moved on and this is looked at again
    let told = true;
    if (wasRunning && nowRunning && prev.turnId && turnId && turnId !== prev.turnId) {
      told = await endTurn(c, a, prev, { turnId: prev.turnId, outcome: { kind: "completed" }, newMessage });
      if (told) started();
    } else if (wasRunning && !nowRunning) {
      if (!closed) told = await endTurn(c, a, prev, { turnId: prev.turnId, outcome, newMessage });
    } else if (!wasRunning && nowRunning) {
      started();
    } else if (full && newMessage && (a.status === "idle" || (a.status === "error" && prev.status !== "error"))) {
      // a whole turn while we were not watching (host offline, or updates missed): the tail names it
      told = await endTurn(c, a, prev, { turnId: null, outcome, newMessage, missed: true });
    }
    if (!live(c)) return;

    for (const [id, req] of pendingNow) if (!prev.pending.has(id)) emit(c, "agent.permission_requested", { agent, request: req });
    for (const id of prev.pending) if (!pendingNow.has(id)) emit(c, "agent.permission_resolved", { agent, requestId: id, resolution: null });
    if (!closed) forgetClose(`${c.serverId}/${a.id}`);
    else if (!prev.closed && WORKING.has(was)) closeLater(c.serverId, a.id);
    if (archived && !prev.archived) emit(c, "agent.archived", { agent, archivedAt: a.archivedAt });

    prev.pending = new Set(pendingNow.keys());
    prev.closed = closed;
    prev.archived = archived;
    if (!told) return;
    prev.status = a.status;
    prev.turnId = turnId ?? (nowRunning ? prev.turnId : null);
    prev.lastUserMessageAt = a.lastUserMessageAt ?? prev.lastUserMessageAt;
    prev.updatedAt = a.updatedAt ?? prev.updatedAt;
    prev.tailFails = 0;
  };

  /**
   * One turn_ended per turn. `timeline` is the turn's own tail, read over the host link (the gate reads it from there). When the
   * agent has stopped and a later turn than the one we saw is in the tail, that later turn is the one reported. False = not now.
   */
  const endTurn = async (c: Conn, a: RemoteAgent, prev: Known, t: { turnId: string | null; outcome: unknown; newMessage: boolean; missed?: boolean }): Promise<boolean> => {
    let entries: TimelineEntry[] = [];
    try {
      const page = await timed(c.api.agents.ref(a.id).timeline.refetch({ direction: "tail", limit: tailLimit, projection: "projected" }), "timeline tail");
      entries = [...page.entries].sort((x, y) => x.seqStart - y.seqStart);
    } catch (e) {
      if (!live(c)) return false;
      o.log(`remote events: tail of ${a.id} unreadable (${(e as Error)?.message ?? e})`);
      if (++prev.tailFails < TAIL_TRIES) { soon(c); return false; }
      if (t.missed && !t.turnId) o.log(`remote events: reporting ${a.id}'s turn without a timeline`);
    }
    if (!live(c)) return false;
    const unread = prev.tailFails >= TAIL_TRIES;
    // a message nobody answered yet is not a finished turn
    if (t.missed && !unread && (entries.filter((e) => !NOT_A_REPLY.has(e.item.type)).at(-1)?.item.type ?? "user_message") === "user_message") return false;
    const named = [...entries].reverse().find((e) => e.turnId)?.turnId ?? null;
    let tid = t.turnId;
    const over = a.status !== "running" && a.status !== "initializing";
    if (!tid) tid = named;
    else if (over && named && named !== tid && (t.newMessage || entries.some((e) => e.turnId === tid))) tid = named;
    if (tid && prev.ended.includes(tid)) {
      if (t.missed || tid === t.turnId) return true; // already reported
      tid = null;
    }
    const own = tid ? entries.filter((e) => e.turnId === tid) : [];
    const timeline = (own.length ? own : named && tid ? [] : entries).map((e) => e.item);
    for (const id of new Set([t.turnId, tid])) if (id && !prev.ended.includes(id)) prev.ended.push(id);
    while (prev.ended.length > ENDED_KEEP) prev.ended.shift();
    // the gate tells this turn from an earlier one that ended in the same words by when it began
    const turnStartedAt = own[0]?.timestamp ?? a.lastUserMessageAt ?? undefined;
    emit(c, "agent.turn_ended", { agent: hookAgent(c, a), turnId: tid, turnStartedAt, outcome: t.outcome, timeline });
    return true;
  };

  // ---------- lifecycle ----------

  const offChange = o.hosts.onChange(() => sync());
  let cancelSync: (() => void) | null = null;
  const armSync = (): void => { cancelSync = schedule(() => { if (stopped) return; sync(); armSync(); }, syncMs); };
  sync();
  armSync();

  return {
    stop(): void {
      if (stopped) return;
      offChange();
      cancelSync?.();
      cancelWait?.();
      for (const key of [...closing.keys()]) unsettle(key);
      for (const c of [...conns.values()]) disconnect(c);
      save();
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

type Followed = {
  /** The selector's current SDK port: its `hosts` is what is watched, and it says which agents there are ours. */
  sdkPort(): { hosts: Hosts | null; owns(serverId: string, agent: { id: string; labels?: Record<string, string> }): Promise<boolean> } | null;
  onHandle?: () => void;
};

/** `startRemoteEvents` on whichever SDK handle the deck holds: it starts with the first one and moves to every new one. */
export function followRemoteEvents(ports: Followed, o: Omit<RemoteEventsOptions, "hosts" | "owns">): { stop(): void; flush(): Promise<void> } {
  let current: ReturnType<typeof startRemoteEvents> | null = null;
  let on: Hosts | null = null;
  let stopped = false;
  const follow = (): void => {
    const hosts = ports.sdkPort()?.hosts ?? null;
    if (stopped || hosts === on) return;
    current?.stop();
    on = hosts;
    current = hosts && hosts.supported ? startRemoteEvents({
      ...o,
      hosts: hosts as unknown as HostSource,
      owns: (serverId, a) => ports.sdkPort()?.owns(serverId, a) ?? Promise.resolve(false),
      emit: (name, event) => {
        const a = (event as { agent: RemoteHookAgent }).agent;
        hosts.note(a.id, a.serverId, a.hostLabel); // so the handlers' calls go to its host
        o.emit(name, event);
      },
    }) : null;
  };
  const before = ports.onHandle;
  ports.onHandle = () => { before?.(); follow(); };
  follow();
  return {
    stop(): void { stopped = true; current?.stop(); current = null; },
    flush: () => current?.flush() ?? Promise.resolve(),
  };
}
