// The agent pills' data. Views come only from the SDK; with no handle (yet) the last-known views are shown,
// marked stale. A view of an agent that is not running is kept until an event says its status changed.
import type { SdkPort } from "./paseo-port.ts";
import type { AgentView } from "./render.ts";

const ACTIVE = new Set(["running", "initializing"]);

type Entry = {
  view: AgentView;
  /** Came from the SDK in this process (not read back from page.json). */
  live: boolean;
  /** An event said something moved: ask again. */
  dirty: boolean;
  /** The last refresh failed. */
  failed: boolean;
};

export class AgentViews {
  private entries = new Map<string, Entry>();
  private log: (m: string) => void;
  constructor(log: (m: string) => void = () => {}) {
    this.log = log;
  }

  /** Seed from what page.json remembers; never overwrites a view already known. */
  hydrate(saved: Record<string, AgentView> | undefined): void {
    for (const [id, view] of Object.entries(saved ?? {})) {
      if (!this.entries.has(id)) this.entries.set(id, { view, live: false, dirty: false, failed: false });
    }
  }

  /** An event touched this agent: its view needs refreshing. */
  markDirty(id: string): void {
    const e = this.entries.get(id);
    if (e) e.dirty = true;
  }

  /** Whether refresh() would ask the daemon about this agent. */
  needs(id: string): boolean {
    const e = this.entries.get(id);
    return !e || e.dirty || e.failed || !e.live || ACTIVE.has(e.view.status);
  }

  /** Last view known, flagged stale when it is not backed by a successful SDK read. */
  peek(id: string): AgentView | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    return e.live && !e.failed ? e.view : { ...e.view, stale: true };
  }

  status(id: string): string {
    return this.entries.get(id)?.view.status ?? "unknown";
  }

  /** The views as they should be remembered (no stale flag). */
  snapshot(ids: string[]): Record<string, AgentView> {
    const out: Record<string, AgentView> = {};
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) out[id] = e.view;
    }
    return out;
  }

  /** Refresh through the SDK those of `ids` that need it. */
  async refresh(ids: string[], sdk: SdkPort): Promise<void> {
    await Promise.all(ids.filter((id) => this.needs(id)).map(async (id) => {
      const e = this.entries.get(id);
      if (e) e.dirty = false; // an event during the fetch sets it again
      try {
        const view = await sdk.agentView(id);
        const cur = this.entries.get(id);
        if (cur) Object.assign(cur, { view, live: true, failed: false });
        else this.entries.set(id, { view, live: true, dirty: false, failed: false });
      } catch (err) {
        this.log(`agent ${id}: ${(err as Error).message}`);
        const cur = this.entries.get(id);
        if (cur) cur.failed = true;
      }
    }));
  }
}
