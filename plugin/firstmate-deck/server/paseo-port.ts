// The daemon API the deck needs, behind one small interface. Two implementations:
//   SdkPort  wraps the `context.paseo` handle (fast, typed; only exists once a hook or RPC has fired)
//   CliPort  shells out to the `paseo` CLI (server/paseo-cli.ts); the cold-start fallback for delivery
// PortSelector picks between them: the SdkPort once any hook or RPC callback has handed us a handle.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import { COMMENT_ROW_KIND, COMMENT_ROW_VERSION } from "../shared/contract.ts";
import { human } from "./humanize.ts";
import type { AgentView } from "./render.ts";

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
};

export type CommentRowData = { project: string; pageUrl: string | null; at: string; comments: { target: string; text: string }[]; replied: boolean };

export interface PaseoPort {
  readonly kind: "sdk" | "cli";
  /** Live (non-archived) agents, optionally only those carrying `label` ("key=value"). */
  listAgents(o?: { label?: string }): Promise<PortAgent[]>;
  agentView(id: string): Promise<AgentView>;
  /** Send `text` to the agent, steering it if it is mid-turn (never interrupting). */
  send(id: string, text: string): Promise<void>;
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

export class SdkPort implements PaseoPort {
  readonly kind = "sdk" as const;
  private api: PaseoApi;
  constructor(api: PaseoApi) {
    this.api = api;
  }

  async listAgents(o: { label?: string } = {}): Promise<PortAgent[]> {
    const [key, value] = o.label ? parseLabel(o.label) : ["", null];
    const out: PortAgent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.api.agents.list({
        filter: key && value !== null ? { labels: { [key]: value } } : undefined,
        page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      for (const { agent: a } of r.entries) {
        if (key && value === null && !(key in a.labels)) continue;
        out.push({
          id: a.id, status: a.status, labels: a.labels, createdAt: a.createdAt, updatedAt: a.updatedAt,
          model: a.model, thinking: a.effectiveThinkingOptionId ?? a.thinkingOptionId ?? null, title: a.title, archived: !!a.archivedAt,
        });
      }
      if (!r.pageInfo.hasMore || !r.pageInfo.nextCursor) break;
      cursor = r.pageInfo.nextCursor;
    }
    return out;
  }

  async agentView(id: string): Promise<AgentView> {
    const h = this.api.agents.ref(id);
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
  }

  async send(id: string, text: string): Promise<void> {
    await this.api.agents.ref(id).send(text, { activeTurnBehavior: "steer" });
  }

  async appendTimelineRow(agentId: string, rowId: string, data: CommentRowData): Promise<boolean> {
    await this.api.agents.ref(agentId).timeline.append({ type: "plugin", id: rowId, kind: COMMENT_ROW_KIND, version: COMMENT_ROW_VERSION, data });
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

  constructor(cli: PaseoPort, log: (m: string) => void = () => {}, makeSdk: (api: PaseoApi) => SdkPort = (a) => new SdkPort(a)) {
    this.cli = cli;
    this.log = log;
    this.makeSdk = makeSdk;
  }

  /** Remember the handle a hook or RPC callback was given (the latest one wins). `source` names the callback, for the log. */
  capture(ctx: { paseo?: PaseoApi | null } | null | undefined, source: string): void {
    const api = ctx?.paseo;
    if (!api || api === this.handle) return;
    const first = !this.handle;
    this.handle = api;
    this.sdk = this.makeSdk(api);
    if (first) {
      this.log(`SDK handle captured (from ${source}); using the SDK from now on`);
      this.onFirstHandle?.();
    }
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
      if (port.kind === "cli") throw e;
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

export type FirstMate = { id: string; status: string };

export const NO_CLAIM_MESSAGE = "No first mate claimed this checkout: run bin/page claim in the first mate's session";

/** Thrown when there is nobody to deliver to: no claim and no usable label. The banner says how to fix it. */
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

/** The agent id `bin/page claim` recorded in state/firstmate.json, if any. */
export function claimedId(root: string): string | null {
  try {
    const id = JSON.parse(readFileSync(join(root, "state", "firstmate.json"), "utf8"))?.agentId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * The first mate, decided by explicit facts only (no guessing from working directories):
 *   1. the agent `bin/page claim` recorded in state/firstmate.json, if it still exists and is not archived;
 *   2. else the newest live agent carrying the first-mate label, EXCLUDING every agent id fleet.json or the
 *      archive lists as crew;
 *   3. else null.
 * Never writes a label. Re-resolved on every use.
 */
export async function resolveFirstMate(port: PaseoPort, label: string, root?: string): Promise<FirstMate | null> {
  const claim = root ? claimedId(root) : null;
  if (claim) {
    const hit = (await port.listAgents()).find((a) => a.id === claim && !a.archived); // archived agents are not live
    if (hit) return { id: hit.id, status: hit.status };
  }
  const crew = root ? crewAgentIds(root) : new Set<string>();
  const list = (await port.listAgents({ label })).filter((a) => !crew.has(a.id));
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
export async function sendToFirstMate(ports: PortSelector, label: string, message: string, early?: Promise<FirstMate | null>, root?: string): Promise<string> {
  let fm: FirstMate | null = null;
  if (early) { try { fm = await early; } catch {} }
  if (fm) {
    try {
      await ports.send(fm.id, message);
      return fm.id;
    } catch {}
  }
  fm = await resolveFirstMate(ports.current(), label, root);
  if (!fm) throw new NoFirstMateError();
  await ports.send(fm.id, message);
  return fm.id;
}
