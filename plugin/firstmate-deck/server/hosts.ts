// The other Paseo hosts this daemon is linked to (`paseo host ls`), through the SDK handle: `hosts.list()` for the directory and
// `hosts.client(serverId)` for a full API on one of them. A daemon without `hosts` has none, and everything behaves as before.
//
// Nothing here may stall the local daemon's work: every call has a timeout; a client whose call failed is disposed and built
// afresh on the next use; a host whose call hung is left alone for a cool-down.
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { readRemoteStore } from "./remote-store.ts";

type PaseoApi = PluginHandlerContext["paseo"];

export type HostInfo = { serverId: string; label: string; target?: string; enabled: boolean; online: boolean; lastOnlineAt: string | null };
export type HostClient = { serverId: string; label: string; api: PaseoApi };
export type HostRef = { serverId: string; label: string };

export type HostsOptions = {
  /** The first-mate checkout: its state/remote-agents.json says which host an agent lives on before any list call. */
  root?: () => string;
  log?: (m: string) => void;
  now?: () => number;
  /** How long a directory read is trusted without asking again (`observe` pushes changes sooner). */
  ttlMs?: number;
  /** Default timeout of a call to a host, and of building its client. */
  timeoutMs?: number;
  /** How long a host whose call hung is not tried again. */
  cooldownMs?: number;
};

export const HOSTS_TTL_MS = 10_000;
export const HOST_TIMEOUT_MS = 8000;
export const HOST_COOLDOWN_MS = 15_000;

export class HostTimeoutError extends Error {}

/** `p`, or a HostTimeoutError after `ms`. A result that arrives too late goes to `late` (to be disposed). */
export function within<T>(p: Promise<T>, ms: number, what: string, late?: (v: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { done = true; reject(new HostTimeoutError(`${what} timed out after ${ms} ms`)); }, ms);
    p.then(
      (v) => { if (done) return late?.(v); clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

type Directory = Awaited<ReturnType<NonNullable<PaseoApi["hosts"]>["list"]>>;

const dispose = (api: PaseoApi): void => { try { void api.dispose?.()?.catch(() => {}); } catch {} };

export class Hosts {
  private api: PaseoApi;
  private o: HostsOptions;
  private dir: HostInfo[] | null = null;
  private signature: string | null = null;
  private readAt: number | null = null;
  private reading: Promise<void> | null = null;
  private observer: { release(): Promise<void> } | null = null;
  private built = new Map<string, HostClient>();
  private building = new Map<string, Promise<HostClient | null>>();
  private cooling = new Map<string, number>();
  /** Hosts whose client was dropped: building the next one is a change others must hear about. */
  private dropped = new Set<string>();
  private owners = new Map<string, HostRef>();
  private listeners = new Set<() => void>();
  private lastError = "";
  private stopped = false;

  constructor(api: PaseoApi, o: HostsOptions = {}) {
    this.api = api;
    this.o = o;
  }

  /** False for a daemon (or SDK) without a host directory. */
  get supported(): boolean { return !!(this.api as Partial<PaseoApi>).hosts; }

  private now(): number { return (this.o.now ?? Date.now)(); }
  private timeout(): number { return this.o.timeoutMs ?? HOST_TIMEOUT_MS; }

  /** Every registered host but this daemon, from cache while it is fresh. Null when the directory was never read. */
  async list(): Promise<HostInfo[] | null> {
    if (this.stopped || !this.supported) return this.dir;
    if (this.readAt === null || this.now() - this.readAt >= (this.o.ttlMs ?? HOSTS_TTL_MS)) {
      this.reading ??= this.read().finally(() => { this.reading = null; });
      await this.reading;
    }
    return this.dir;
  }

  private async read(): Promise<void> {
    try {
      this.apply(await within(Promise.resolve().then(() => this.api.hosts.list()), this.timeout(), "host list"));
      this.lastError = "";
      this.observe();
    } catch (e) {
      const m = (e as Error).message;
      if (m !== this.lastError) this.o.log?.(`could not list Paseo hosts: ${m}`);
      this.lastError = m;
      this.readAt = this.now(); // not again before the TTL
    }
  }

  private observe(): void {
    if (this.observer || this.stopped || typeof (this.api.hosts as { observe?: unknown }).observe !== "function") return;
    try {
      const sub = this.api.hosts.observe();
      this.observer = sub;
      const drop = () => { if (this.observer === sub) this.observer = null; void sub.release().catch(() => {}); };
      sub.subscribe({
        snapshot: (d) => this.apply(d),
        update: (m) => { const x = m as { type?: string; payload?: { directory?: Directory } }; if (x.type === "hosts.changed" && x.payload?.directory) this.apply(x.payload.directory); },
        error: drop,
      });
    } catch (e) {
      this.observer = null;
      this.o.log?.(`could not observe Paseo hosts: ${(e as Error).message}`);
    }
  }

  private apply(d: Directory): void {
    if (this.stopped || !Array.isArray(d?.hosts)) return;
    const by = new Map<string, HostInfo>();
    for (const h of d.hosts) {
      if (!h.serverId || h.serverId === d.self?.serverId) continue;
      const info: HostInfo = {
        serverId: h.serverId, label: h.label || h.serverId, target: h.targetDescription, enabled: h.enabled,
        online: h.enabled && h.status === "online", lastOnlineAt: h.lastOnlineAt ?? null,
      };
      if (!by.get(h.serverId)?.online) by.set(h.serverId, info); // registered twice: the online one wins
    }
    this.dir = [...by.values()];
    this.readAt = this.now();
    for (const id of [...this.built.keys()]) if (!by.get(id)?.online) this.drop(id);
    const signature = JSON.stringify(this.dir.map((h) => [h.serverId, h.label, h.enabled, h.online]).sort());
    const changed = this.signature !== null && signature !== this.signature;
    this.signature = signature;
    if (changed) this.emit();
  }

  /** The online, enabled hosts, each with a live client (one whose client cannot be built is left out). */
  async clients(): Promise<HostClient[]> {
    const online = (await this.list())?.filter((h) => h.online) ?? [];
    return (await Promise.all(online.map((h) => this.client(h.serverId)))).filter((c): c is HostClient => !!c);
  }

  async client(serverId: string): Promise<HostClient | null> {
    const info = (await this.list())?.find((h) => h.serverId === serverId);
    if (this.stopped || !info?.online || this.now() < (this.cooling.get(serverId) ?? 0)) return null;
    const have = this.built.get(serverId);
    if (have) return have;
    let flight = this.building.get(serverId);
    if (!flight) {
      flight = this.build(info).finally(() => this.building.delete(serverId));
      this.building.set(serverId, flight);
    }
    return flight;
  }

  private async build(info: HostInfo): Promise<HostClient | null> {
    try {
      const api = await within(Promise.resolve().then(() => this.api.hosts.client(info.serverId)), this.timeout(), `connecting to ${info.label}`, dispose);
      if (this.stopped) { dispose(api); return null; }
      const c = { serverId: info.serverId, label: info.label, api };
      this.built.set(info.serverId, c);
      if (this.dropped.delete(info.serverId)) queueMicrotask(() => this.emit());
      return c;
    } catch (e) {
      this.cooling.set(info.serverId, this.now() + (this.o.cooldownMs ?? HOST_COOLDOWN_MS));
      this.o.log?.(`could not connect to host ${info.label}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Dispose a host's client (only if it is still `api`, when given): the next use builds a new one. */
  drop(serverId: string, api?: unknown): void {
    const c = this.built.get(serverId);
    if (!c || (api !== undefined && c.api !== api)) return;
    this.built.delete(serverId);
    this.dropped.add(serverId);
    dispose(c.api);
  }

  /** One call on a host's API, with a timeout. Any failure drops the client; a hang also starts the cool-down. */
  async call<T>(serverId: string, fn: (api: PaseoApi) => Promise<T>, ms: number = this.timeout()): Promise<T> {
    const c = await this.client(serverId);
    const label = c?.label ?? this.labelOf(serverId);
    if (!c) throw new Error(`host ${label} is unavailable`);
    try {
      return await within(Promise.resolve().then(() => fn(c.api)), ms, "call");
    } catch (e) {
      this.drop(serverId, c.api);
      if (e instanceof HostTimeoutError) this.cooling.set(serverId, this.now() + (this.o.cooldownMs ?? HOST_COOLDOWN_MS));
      throw new Error(`${label}: ${(e as Error).message}`, { cause: e });
    }
  }

  labelOf(serverId: string): string {
    const root = this.o.root?.();
    return this.dir?.find((h) => h.serverId === serverId)?.label ?? (root ? readRemoteStore(root).hosts[serverId]?.label : undefined) ?? serverId;
  }

  /** `agentId` was seen on that host. */
  note(agentId: string, serverId: string, label: string = this.labelOf(serverId)): void {
    this.owners.set(agentId, { serverId, label });
  }

  /** The remote host an agent lives on; undefined for a local (or unknown) one. */
  hostOf(agentId: string): HostRef | undefined {
    const known = this.owners.get(agentId);
    if (known) return known;
    const root = this.o.root?.();
    if (!root) return undefined;
    for (const [serverId, h] of Object.entries(readRemoteStore(root).hosts)) {
      if (h.agents.some((a) => a.id === agentId)) { this.note(agentId, serverId, h.label); return this.owners.get(agentId); }
    }
    return undefined;
  }

  offline(): HostInfo[] {
    return this.dir?.filter((h) => !h.online) ?? [];
  }

  /** The directory changed, or a dropped client was replaced. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private emit(): void {
    if (this.stopped) return;
    for (const cb of [...this.listeners]) { try { cb(); } catch (e) { this.o.log?.(`host listener failed: ${e}`); } }
  }

  stop(): void {
    if (this.stopped) return;
    for (const id of [...this.built.keys()]) this.drop(id);
    this.stopped = true;
    this.listeners.clear();
    void this.observer?.release().catch(() => {});
    this.observer = null;
  }
}
