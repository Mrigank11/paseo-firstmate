// A stand-in for agent-canvas's `/api/fm/*` (A1, crew/p5-a1-relay @ 706889f): the same paths and JSON shapes, served on loopback.
import { createServer, type Server } from "node:http";
import type { FmSummary } from "../server/canvas-port.ts";

export const summary = (agentId: string, over: Partial<FmSummary> = {}): FmSummary => ({
  agentId, rev: 1, archived: false, title: "A canvas",
  verdict: { label: "Working", flags: [], needsYou: false },
  bluf: "Building the API", steps: { done: 1, total: 4, current: "implement" }, openAsks: [],
  updatedAt: Date.now(), runState: "running", url: `http://canvas.test/a/${agentId}`, agentUrl: null, auto: false, ...over,
});

export class FakeCanvas {
  summaries = new Map<string, FmSummary>();
  hits: string[] = [];
  down = false;
  cssTheme: string | null = null;
  private server: Server;
  url = "";
  /** Card body per agent when a test wants something other than the stock text (e.g. one with pictures). */
  cardHtml = new Map<string, string>();
  assets = new Map<string, { mime: string; bytes: Buffer }>();

  constructor() {
    this.server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      this.hits.push(u.pathname + u.search);
      if (this.down) { res.writeHead(503); return void res.end("down"); }
      if (u.pathname === "/api/fm/css") { this.cssTheme = u.searchParams.get("theme"); res.writeHead(200, { "content-type": "text/css" }); return void res.end(".acv .blk{color:red}"); }
      if (u.pathname === "/api/fm/summary") {
        const ids = (u.searchParams.get("agents") ?? "").split(",").filter(Boolean);
        const agents = ids.map((i) => this.summaries.get(i)).filter(Boolean);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ agents, missing: ids.filter((i) => !this.summaries.has(i)) }));
      }
      const m = /^\/api\/fm\/card\/([\w-]+)$/.exec(u.pathname);
      if (m && this.summaries.has(m[1])) { res.writeHead(200, { "content-type": "text/html" }); return void res.end(this.cardHtml.get(m[1]) ?? `<div class="blk">FULL CANVAS ${m[1]} rev ${this.summaries.get(m[1])!.rev}</div>`); }
      const a = /^\/asset\/([0-9a-f]{32})$/.exec(u.pathname);
      if (a && this.assets.has(a[1])) { const f = this.assets.get(a[1])!; res.writeHead(200, { "content-type": f.mime }); return void res.end(f.bytes); }
      res.writeHead(404); res.end("no");
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  set(s: FmSummary): void { this.summaries.set(s.agentId, s); }
  count(prefix: string): number { return this.hits.filter((h) => h.startsWith(prefix)).length; }
  async stop(): Promise<void> { this.server.closeAllConnections?.(); await new Promise((r) => this.server.close(r)); }
}
