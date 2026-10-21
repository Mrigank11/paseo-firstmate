// The deck's daemon-side brain: watches the first mate's state, renders each project page, owns each page's
// Lavish poll, and relays page comments to the first mate.
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, join, relative } from "node:path";
import type { DeckConfig } from "./config.ts";
import { killAllPolls, killStalePoll, lavishEnv, PagePoller, removePid, resolveLavishBin, spawnPoll, writePid } from "./lavish.ts";
import { decodePoll } from "./toon.ts";
import { AgentSource, resolveFirstMate, sendToFirstMate, type Exec, type FirstMate } from "./paseo-cli.ts";
import { Relay, newEntries } from "./relay.ts";
import { groupOf, liveJs, renderProject, type AgentView, type Banner } from "./render.ts";
import { loadProject, type ProjectModel, type Task } from "./state.ts";
import { appendInbox, inboxPath, pageJsonPath, patchPageJson, pidPath, projectDir, readInbox, readPageJson, updateInbox, writeAtomic, type InboxEntry } from "./store.ts";

export type Summary = {
  project: string; title: string; repo: string | null; pageUrl: string | null; session: "open" | "ended" | "unknown";
  needsYou: { taskId: string; taskTitle: string; text: string; since: string }[];
  running: { taskId: string; taskTitle: string; agentId: string | null; agentStatus: string; current: string; startedAt: string | null }[];
  counts: { needsYou: number; running: number; next: number; parked: number; done: number };
  undelivered: number;
  banner: string | null;
};

export type DeckOpts = {
  exec: Exec;
  home?: string;
  log?: (msg: string) => void;
  readConfig: () => Promise<DeckConfig>;
  /** Append the timeline row for delivered comments, if an SDK handle is available (else no-op). */
  timelineRow?: (agentId: string, rowId: string, data: { project: string; pageUrl: string | null; at: string; comments: { target: string; text: string }[]; replied: boolean }) => Promise<void>;
  batchMs?: number;
  tickMs?: number;
  rescanMs?: number;
};

const TICK_MS = 20_000;
const RESCAN_MS = 30_000;
const DEBOUNCE_MS = 150;
const IGNORED = /(^|\/)(\.[^/]*|[^/]*\.tmp|[^/]*\.lock|page\.html|[^/]*\.live\.js|inbox\.jsonl)$/;

const plainTitle = (t: Task) => t.title || t.intent || t.id;

export class Deck {
  private cfg: DeckConfig = { root: "", firstmateLabel: "firstmate=true" };
  private agents: AgentSource;
  private relay: Relay;
  private log: (m: string) => void;
  private watchers = new Map<string, FSWatcher>();
  private watchedDir = "";
  private timers: ReturnType<typeof setInterval>[] = [];
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private rendering = new Map<string, { again: boolean }>();
  private sigs = new Map<string, string>();
  private usedViews = new Map<string, string>();
  private agentProjects = new Map<string, Set<string>>();
  private pollers = new Map<string, { poller: PagePoller; child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean } | null }>();
  private stalePollsChecked = new Set<string>();
  private failing = new Map<string, number>();
  private webBase = "";
  private lavishBin: string | null = null;
  private fmCache: { at: number; id: string | null } | null = null;
  private stopped = false;
  private early: { at: number; p: Promise<FirstMate | null> } | null = null;

  private o: DeckOpts;

  constructor(o: DeckOpts) {
    this.o = o;
    this.log = o.log ?? (() => {});
    this.agents = new AgentSource(o.exec);
    this.relay = new Relay({
      send: (_p, msg) => {
        const early = this.early && Date.now() - this.early.at < 10_000 ? this.early.p : undefined;
        this.early = null;
        return sendToFirstMate(o.exec, this.cfg.firstmateLabel, msg, early);
      },
      markDelivered: (p, ids, at) => this.markDelivered(p, ids, at),
      onQueue: (p, queued, failing) => this.onQueue(p, queued, failing),
      afterSend: (p, entries, agentId) => this.afterSend(p, entries, agentId),
      batchMs: o.batchMs,
      log: (m) => this.log(m),
    });
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    await this.configure();
    this.timers.push(setInterval(() => void this.configure().catch((e) => this.log(`rescan failed: ${e}`)), this.o.rescanMs ?? RESCAN_MS));
    this.timers.push(setInterval(() => this.scheduleAll("tick", 0), this.o.tickMs ?? TICK_MS));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const t of this.debounce.values()) clearTimeout(t);
    this.relay.stop();
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const { poller, child } of this.pollers.values()) {
      poller.stop();
      try { child?.kill("SIGTERM"); } catch {}
    }
    this.pollers.clear();
    killAllPolls();
  }

  /** (Re)read settings, (re)attach the watcher, discover projects, reconcile pollers. Runs at start and every rescan. */
  async configure(): Promise<void> {
    if (this.stopped) return;
    const next = await this.o.readConfig();
    const rootChanged = next.root !== this.cfg.root;
    const lavishChanged = next.lavishPort !== this.cfg.lavishPort || next.lavishStateDir !== this.cfg.lavishStateDir;
    if (rootChanged || lavishChanged) {
      for (const { poller, child } of this.pollers.values()) { poller.stop(); try { child?.kill("SIGTERM"); } catch {} }
      this.pollers.clear();
    }
    this.cfg = next;
    if (rootChanged) {
      this.sigs.clear();
      this.stalePollsChecked.clear();
      this.log(next.root ? `first mate root: ${next.root}` : "no firstmateRoot configured (settings or FIRSTMATE_ROOT); idle");
    }
    if (!this.cfg.root) return;
    this.attachWatcher(rootChanged);
    const projects = this.projectNames();
    // Comments first: resend what an earlier run left undelivered and get the polls going before anything slow.
    for (const p of projects) {
      if (this.sigs.has(p)) continue;
      const pending = readInbox(inboxPath(this.cfg.root, p)).filter((e) => !e.delivered);
      if (pending.length) this.relay.enqueue(p, pending, 500);
    }
    await this.reconcilePollers(projects);
    if (!this.webBase) await this.detectWebBase(); // page links need the daemon's web address
    for (const p of projects) {
      if (this.sigs.has(p)) continue;
      this.sigs.set(p, "");
      this.scheduleRender(p, 0);
    }
  }

  private async detectWebBase(): Promise<void> {
    try {
      const st = JSON.parse(await this.o.exec(["status", "--json"]));
      const listen = String(st.listen ?? "").replace("0.0.0.0", st.hostname || "127.0.0.1");
      if (listen && st.serverId) this.webBase = `http://${listen}/h/${st.serverId}`;
    } catch (e) {
      this.log(`could not read daemon status for agent links: ${e}`);
    }
  }

  private agentUrl = (id: string) => `${this.webBase || "http://localhost:6767"}/agent/${id}`;

  // ---------- discovery + watching ----------

  projectNames(): string[] {
    const dir = join(this.cfg.root, "state", "projects");
    try {
      return readdirSync(dir).filter((d) => /^[a-z0-9][a-z0-9-]*$/.test(d) && existsSync(join(dir, d, "project.json"))).sort();
    } catch {
      return [];
    }
  }

  /**
   * One non-recursive watch per directory that matters. Node's recursive watcher on Linux loses track of a file
   * that is replaced by rename (bin/fleet's temp file + rename): after the first replacement it reports the
   * temp file's old name instead of `fleet.json`. A plain directory watch reports the real entry name.
   */
  private attachWatcher(force: boolean): void {
    if (this.stopped) return;
    const state = join(this.cfg.root, "state");
    if (force || this.watchedDir !== state) {
      for (const w of this.watchers.values()) w.close();
      this.watchers.clear();
      this.watchedDir = state;
    }
    const want = new Set<string>();
    const subdirs = (d: string) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d, e.name)); } catch { return []; } };
    if (existsSync(state)) {
      want.add(state);
      const tasks = join(state, "tasks");
      if (existsSync(tasks)) {
        want.add(tasks);
        for (const t of subdirs(tasks)) { want.add(t); for (const a of subdirs(t)) want.add(a); }
      }
      const projects = join(state, "projects");
      if (existsSync(projects)) {
        want.add(projects);
        for (const p of subdirs(projects)) { want.add(p); for (const sd of subdirs(p)) want.add(sd); }
      }
    }
    for (const [dir, w] of this.watchers) if (!want.has(dir)) { w.close(); this.watchers.delete(dir); }
    for (const dir of want) {
      if (this.watchers.has(dir)) continue;
      try {
        const w = watch(dir, (_ev, filename) => {
          const rel = filename ? relative(state, join(dir, String(filename))) : null;
          this.onFsEvent(rel);
          // a new directory (task, project, sections, asks) needs its own watch
          if (rel && !IGNORED.test(rel) && /^(tasks|projects)(\/[^/]+){0,2}$/.test(rel)) {
            let isDir = false;
            try { isDir = statSync(join(state, rel)).isDirectory(); } catch {}
            if (isDir) setTimeout(() => this.attachWatcher(false), 50);
          }
        });
        w.on("error", () => { w.close(); this.watchers.delete(dir); });
        this.watchers.set(dir, w);
      } catch (e) {
        this.log(`fs.watch ${dir} failed (${e}); relying on the rescan`);
      }
    }
  }

  private onFsEvent(rel: string | null): void {
    if (this.stopped) return;
    if (rel === null) return this.scheduleAll("fs", DEBOUNCE_MS);
    if (IGNORED.test(rel) && !rel.endsWith("/page.json")) return;
    if (rel === "fleet.json" || rel === "fleet-archive.jsonl") return this.scheduleAll("fleet", DEBOUNCE_MS);
    let m = /^tasks\/[^/]+\/(card\.md|asks\/.*)$/.exec(rel);
    if (m) return this.scheduleAll("task", DEBOUNCE_MS);
    m = /^projects\/([^/]+)\/(.*)$/.exec(rel);
    if (!m) return;
    const [, p, rest] = m;
    if (rest === "page.json") { void this.reconcilePollers(this.projectNames()).catch((e) => this.log(`reconcile failed: ${e}`)); return; }
    if (rest === "project.json" || rest.startsWith("sections/")) {
      if (!this.sigs.has(p)) void this.configure();
      this.scheduleRender(p, DEBOUNCE_MS);
    }
  }

  // ---------- rendering ----------

  private scheduleAll(why: string, delay: number): void {
    for (const p of this.projectNames()) this.scheduleRender(p, delay, why);
  }

  scheduleRender(project: string, delayMs = DEBOUNCE_MS, _why = ""): void {
    if (this.stopped) return;
    const t = this.debounce.get(project);
    if (t) clearTimeout(t);
    this.debounce.set(project, setTimeout(() => {
      this.debounce.delete(project);
      void this.render(project).catch((e) => this.log(`render ${project} failed: ${e}`));
    }, delayMs));
  }

  /** Agent lifecycle event: drop cached views, re-render the projects whose tasks use that agent. */
  onAgentEvent(agentId: string): void {
    this.agents.invalidate(agentId);
    for (const p of this.agentProjects.get(agentId) ?? []) this.scheduleRender(p, DEBOUNCE_MS, "agent");
  }

  pagePath(project: string): string {
    try {
      const cfg = JSON.parse(readFileSync(join(projectDir(this.cfg.root, project), "project.json"), "utf8"));
      if (typeof cfg.page === "string" && cfg.page) return cfg.page;
    } catch {}
    return join(projectDir(this.cfg.root, project), "page.html");
  }

  private bannerFor(project: string, session: string): Banner | undefined {
    const n = this.failing.get(project) ?? 0;
    if (n > 0) return { kind: "unreachable", text: `First mate unreachable, ${n} comment${n === 1 ? "" : "s"} queued` };
    if (session === "ended") return { kind: "ended", text: "This page session has ended. Ask the first mate to reopen it." };
    return undefined;
  }

  /** Render now from cached agent views (fast), then refresh the agents and render again if anything moved. */
  async render(project: string): Promise<void> {
    const flight = this.rendering.get(project);
    if (flight) { flight.again = true; return; }
    const state = { again: false };
    this.rendering.set(project, state);
    try {
      do {
        state.again = false;
        const model = this.load(project);
        if (!model) break;
        this.writePage(project, model);
        const ids = this.trackedAgents(project, model);
        if (!ids.length) continue;
        let listed;
        try { listed = await this.agents.list(); } catch (e) { this.log(`paseo ls failed: ${e}`); continue; }
        await Promise.all(ids.map((id) => this.agents.view(id, listed).catch((e) => this.log(`agent ${id}: ${e}`))));
        const key = JSON.stringify(ids.map((id) => this.agents.peek(id) ?? null));
        if (key !== this.usedViews.get(project)) this.writePage(project, this.load(project) ?? model);
      } while (state.again && !this.stopped);
    } finally {
      this.rendering.delete(project);
    }
  }

  private load(project: string): ProjectModel | null {
    try {
      return loadProject(this.cfg.root, project);
    } catch (e) {
      this.log(`cannot load ${project}: ${(e as Error).message}`);
      return null;
    }
  }

  private trackedAgents(project: string, model: ProjectModel): string[] {
    const ids = model.tasks.filter((t) => t.agentId && groupOf(t, true) !== "done").map((t) => t.agentId as string);
    for (const t of model.tasks) if (t.agentId) {
      const set = this.agentProjects.get(t.agentId) ?? new Set();
      set.add(project);
      this.agentProjects.set(t.agentId, set);
    }
    return [...new Set(ids)];
  }

  private writePage(project: string, model: ProjectModel): void {
    const ids = this.trackedAgents(project, model);
    const views: Record<string, AgentView> = {};
    for (const id of ids) {
      const v = this.agents.peek(id);
      if (v) views[id] = v;
    }
    this.usedViews.set(project, JSON.stringify(ids.map((id) => this.agents.peek(id) ?? null)));
    const pj = readPageJson(pageJsonPath(this.cfg.root, project));
    const target = this.pagePath(project);
    const now = new Date();
    const r = renderProject(model, views, {
      now, tickSeconds: 5, paseoAgentUrl: this.agentUrl, banner: this.bannerFor(project, pj.session), pageFile: basename(target),
    });
    const p2 = (n: number) => String(n).padStart(2, "0");
    const ts = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
    let rewrote = false;
    if (r.signature !== this.sigs.get(project) || !existsSync(target)) {
      writeAtomic(target, r.page);
      this.sigs.set(project, r.signature);
      rewrote = true;
    }
    writeAtomic(target.replace(/\.[^./]*$/, "") + ".live.js", liveJs(r.live.replace(/\{TS\}/g, ts)));
    patchPageJson(pageJsonPath(this.cfg.root, project), { lastRender: now.toISOString() });
    if (rewrote) this.log(`rendered ${project} (${r.signature.slice(0, 8)})`);
  }

  // ---------- Lavish polling ----------

  private async reconcilePollers(projects: string[]): Promise<void> {
    for (const p of projects) {
      const pj = readPageJson(pageJsonPath(this.cfg.root, p));
      const have = this.pollers.get(p);
      if (pj.session === "open" && !have) await this.startPoller(p);
      else if (pj.session !== "open" && have) {
        have.poller.stop();
        try { have.child?.kill("SIGTERM"); } catch {}
        this.pollers.delete(p);
      }
    }
    for (const p of [...this.pollers.keys()]) if (!projects.includes(p)) { this.pollers.get(p)!.poller.stop(); this.pollers.delete(p); }
  }

  private async startPoller(project: string): Promise<void> {
    const root = this.cfg.root;
    const page = this.pagePath(project);
    const pidFile = pidPath(root, project);
    if (!this.stalePollsChecked.has(project)) {
      this.stalePollsChecked.add(project);
      if (killStalePoll(pidFile, page)) this.log(`killed a stale poll for ${project}`);
    }
    try { this.lavishBin ??= await resolveLavishBin(); } catch (e) { this.log(`${e}`); patchPageJson(pageJsonPath(root, project), { listener: "error" }); return; }
    const bin = this.lavishBin;
    const env = lavishEnv({ LAVISH_AXI_PORT: this.cfg.lavishPort, LAVISH_AXI_STATE_DIR: this.cfg.lavishStateDir });
    const entry: { poller: PagePoller; child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean } | null } = { poller: null as any, child: null };
    entry.poller = new PagePoller({
      run: async () => {
        const sp = spawnPoll(bin, page, env, "firstmate-deck");
        entry.child = sp.child;
        writePid(pidFile, sp.child.pid);
        const res = await sp.result;
        removePid(pidFile, sp.child.pid);
        if (entry.child === sp.child) entry.child = null;
        return res;
      },
      decode: (out) => decodePoll(out, bin),
      onBatch: (prompts) => this.ingest(project, prompts),
      onEnded: () => {
        patchPageJson(pageJsonPath(root, project), { session: "ended", listener: "ok" });
        this.pollers.delete(project);
        this.log(`session for ${project} ended`);
        this.scheduleRender(project, 0);
      },
      onListener: (state) => { patchPageJson(pageJsonPath(root, project), { listener: state }); },
      log: (m) => this.log(`[poll ${project}] ${m}`),
    });
    this.pollers.set(project, entry);
    entry.poller.start();
    this.log(`polling ${page} for ${project}`);
  }

  // ---------- comments ----------

  ingest(project: string, prompts: { prompt: string; selector?: string }[]): void {
    let known = { tasks: [] as string[], sections: [] as string[] };
    const model = this.load(project);
    if (model) known = { tasks: [...model.tasks, ...model.archive].map((t) => t.id), sections: model.sections.map((s) => s.name) };
    const entries = newEntries(project, prompts as any, known);
    // Inbox first: if anything below fails, the comments are on disk and get retried at the next start.
    const file = inboxPath(this.cfg.root, project);
    appendInbox(file, entries);
    this.log(`${project}: ${entries.length} comment(s) -> inbox`);
    // Look the first mate up now, while the batch window is open, so the send itself is one CLI call.
    this.early = { at: Date.now(), p: resolveFirstMate(this.o.exec, this.cfg.firstmateLabel) };
    this.early.p.catch(() => {});
    this.relay.enqueue(project, entries);
  }

  private undelivered(project: string): number {
    return readInbox(inboxPath(this.cfg.root, project)).filter((e) => !e.delivered).length;
  }

  private onQueue(project: string, _queued: number, failing: boolean): void {
    const n = this.undelivered(project);
    const was = this.failing.get(project) ?? 0;
    if (failing) this.failing.set(project, n); else this.failing.delete(project);
    patchPageJson(pageJsonPath(this.cfg.root, project), { undelivered: n, banner: failing ? this.bannerFor(project, "")?.text ?? null : null });
    if (failing || was) this.scheduleRender(project, 0);
  }

  private markDelivered(project: string, ids: string[], at: string): void {
    const set = new Set(ids);
    updateInbox(inboxPath(this.cfg.root, project), (e) => { if (set.has(e.id)) e.delivered = true; });
    patchPageJson(pageJsonPath(this.cfg.root, project), { lastDelivery: at, undelivered: this.undelivered(project) });
    this.log(`${project}: delivered ${ids.length} comment(s)`);
  }

  private async afterSend(project: string, entries: InboxEntry[], agentId: string): Promise<void> {
    if (!this.o.timelineRow) return;
    const pj = readPageJson(pageJsonPath(this.cfg.root, project));
    await this.o.timelineRow(agentId, `pc-${entries[0].id}`, {
      project, pageUrl: pj.lavishUrl, at: entries[0].at, comments: entries.map((e) => ({ target: e.target, text: e.text })), replied: false,
    });
  }

  /** Send a project's queued comments now instead of waiting out the batch window. */
  flushNow(project: string): Promise<void> {
    return this.relay.flush(project);
  }

  // ---------- summary RPC ----------

  private async firstMateId(): Promise<string | null> {
    if (this.fmCache && Date.now() - this.fmCache.at < 10_000) return this.fmCache.id;
    let id: string | null = null;
    try { id = (await resolveFirstMate(this.o.exec, this.cfg.firstmateLabel))?.id ?? null; } catch {}
    this.fmCache = { at: Date.now(), id };
    return id;
  }

  async summary(only?: string): Promise<{ projects: Summary[]; firstmateAgentId: string | null }> {
    const firstmateAgentId = this.cfg.root ? await this.firstMateId() : null;
    const out: Summary[] = [];
    for (const p of this.cfg.root ? this.projectNames() : []) {
      if (only && p !== only) continue;
      const model = this.load(p);
      if (!model) continue;
      let repo: string | null = null;
      try { repo = JSON.parse(readFileSync(join(projectDir(this.cfg.root, p), "project.json"), "utf8")).repo ?? null; } catch {}
      const pj = readPageJson(pageJsonPath(this.cfg.root, p));
      const counts = { needsYou: 0, running: 0, next: 0, parked: 0, done: model.archive.filter((a) => !model.tasks.some((t) => t.id === a.id)).length };
      const needsYou: Summary["needsYou"] = [];
      const running: Summary["running"] = [];
      for (const t of model.tasks) {
        const g = groupOf(t, true);
        if (g === "you") {
          counts.needsYou++;
          if (t.asks.length) for (const a of t.asks) needsYou.push({ taskId: t.id, taskTitle: plainTitle(t), text: a.text, since: a.since ?? "" });
          else needsYou.push({ taskId: t.id, taskTitle: plainTitle(t), text: t.notes || "Needs your call", since: "" });
        } else if (g === "running") {
          counts.running++;
          const v = t.agentId ? this.agents.peek(t.agentId) : undefined;
          running.push({
            taskId: t.id, taskTitle: plainTitle(t), agentId: t.agentId ?? null,
            agentStatus: t.agentId ? (this.agents.peekStatus(t.agentId) || v?.status || "unknown") : "unknown",
            current: v ? (v.recent[v.recent.length - 1] ?? v.final ?? "") : "", startedAt: v?.createdAt ?? null,
          });
        } else if (g === "done") counts.done++;
        else if (g === "parked") counts.parked++;
        else counts.next++;
      }
      const n = this.failing.get(p) ?? 0;
      out.push({
        project: p, title: model.title, repo, pageUrl: pj.lavishUrl, session: pj.session,
        needsYou, running, counts, undelivered: this.undelivered(p),
        banner: n > 0 ? this.bannerFor(p, pj.session)!.text : null,
      });
    }
    return { projects: out, firstmateAgentId };
  }
}

