// The read-marks endpoint. The Lavish page lives in a sandboxed iframe (opaque origin, no localStorage), so it keeps
// its read marks here, shared by every browser:
//   GET  /<project>/state  -> {"o":{...},"r":{...}}
//   POST /<project>/state  body = the same shape (JSON, sent as text/plain to skip the CORS preflight) -> merged state
// Stored per project in state/projects/<p>/ui-state.json, a file the plugin owns (it never writes fleet.json).
// CORS is open: the only thing reachable is a list of "I have read this card" hashes on the tailnet.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { cleanUi, emptyUi, mergeUi, type UiState } from "./marks.ts";
import { projectDir, withLock, writeAtomic } from "./store.ts";

export const uiStatePath = (root: string, project: string) => join(projectDir(root, project), "ui-state.json");

export function readUi(root: string, project: string): UiState {
  try { return cleanUi(JSON.parse(readFileSync(uiStatePath(root, project), "utf8"))); } catch { return emptyUi(); }
}

/** Merge `inc` into a project's ui-state.json (atomic, locked). Returns the stored state. A write that changes nothing is skipped. */
export function updateUi(root: string, project: string, inc: UiState): UiState {
  const file = uiStatePath(root, project);
  return withLock(file, () => {
    const cur = readUi(root, project);
    const next = mergeUi(cur, inc);
    if (JSON.stringify(next) !== JSON.stringify(cur) || !existsSync(file)) writeAtomic(file, JSON.stringify(next) + "\n");
    return next;
  });
}

const MAX_BODY = 1 << 20;

export class MarksServer {
  private servers: Server[] = [];
  /** "host:port" each listener is bound to. */
  bound: string[] = [];
  private getRoot: () => string;
  private log: (m: string) => void;
  constructor(getRoot: () => string, log: (m: string) => void = () => {}) {
    this.getRoot = getRoot;
    this.log = log;
  }

  private send(res: ServerResponse, code: number, body = ""): void {
    res.writeHead(code, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  private handle = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      if (req.method === "OPTIONS") return this.send(res, 204);
      const m = /^\/([a-z0-9][a-z0-9-]*)\/state\/?$/.exec((req.url ?? "").split("?")[0]);
      const root = this.getRoot();
      if (!m || !root || !existsSync(join(projectDir(root, m[1]), "project.json"))) return this.send(res, 404, '{"error":"no such project"}');
      const project = m[1];
      if (req.method === "GET") return this.send(res, 200, JSON.stringify(readUi(root, project)));
      if (req.method !== "POST") return this.send(res, 405);
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) { this.send(res, 413); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (res.writableEnded) return;
        try {
          const inc = cleanUi(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          this.send(res, 200, JSON.stringify(updateUi(root, project, inc)));
        } catch { this.send(res, 400, '{"error":"bad body"}'); }
      });
    } catch { try { this.send(res, 500); } catch {} }
  };

  /** Listen on every host (127.0.0.1 and the tailnet IP). A host that cannot be bound is logged and skipped. Resolves with the hosts that worked. */
  async listen(hosts: string[], port: number): Promise<string[]> {
    await this.close();
    const ok: string[] = [];
    for (const host of [...new Set(hosts.filter(Boolean))]) {
      const srv = createServer(this.handle);
      const bound = await new Promise<boolean>((resolve) => {
        srv.once("error", (e) => { this.log(`read-marks endpoint: cannot listen on ${host}:${port} (${(e as Error).message})`); resolve(false); });
        srv.listen(port, host, () => resolve(true));
      });
      if (!bound) continue;
      srv.on("error", () => {});
      srv.unref();
      this.servers.push(srv);
      ok.push(`${host}:${port}`);
    }
    this.bound = ok;
    if (ok.length) this.log(`read-marks endpoint on ${ok.join(", ")}`);
    return ok;
  }

  async close(): Promise<void> {
    const all = this.servers;
    this.servers = [];
    this.bound = [];
    await Promise.all(all.map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); })));
  }
}
