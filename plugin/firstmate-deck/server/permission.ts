// The permission hook (S5): `agent.permission_requested` of an `fm.task` agent is classified against the
// fm-permission-rules block in state/decisions.md (server/rules.ts). `mode: shadow` only logs; `enforce` answers safe requests
// with an allow through the SDK. It never denies: anything unsafe, unknown or unreadable is escalated, i.e. the first mate is
// woken with `## Crew PERMISSION · <task>` (plugin-notified crew) and the request stays pending for a human.
// Every decision is appended to state/permission-log.jsonl.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortSelector } from "./paseo-port.ts";
import { notifySwitchOn, wakeTarget } from "./gate.ts";
import { classify, RulesFile, summarize, type PermissionRequestLike, type RulesState } from "./rules.ts";

export type PermissionDecision = "would-allow" | "allow" | "escalate";
export type PermissionResult = "logged" | "responded" | "respond-failed" | "woke" | "wake-failed" | "no-target" | "no-wake";

export type PermissionEntry = {
  at: string;
  agentId: string;
  task: string;
  requestId: string;
  kind: string;
  name: string;
  summary: string;
  decision: PermissionDecision;
  rule: string;
  mode: string;
  /** True when the plugin answered the request or woke the first mate. */
  acted: boolean;
  result: PermissionResult;
  note?: string;
};

export type PermissionEvent = {
  agent: { id: string; parentAgentId?: string | null };
  request: PermissionRequestLike & Record<string, unknown>;
};

export type PermissionOptions = {
  ports: PortSelector;
  root: () => string;
  paseoHome: string | null;
  log: (m: string) => void;
  now?: () => number;
  retryDelayMs?: number;
};

const PARENT_LABEL = "paseo.parent-agent-id";
const SEND_ATTEMPTS = 3;
const BULKY = new Set(["content", "output", "oldString", "newString", "unifiedDiff", "result", "log"]);

/** The request as compact JSON for the wake message: bulky tool payloads dropped, the rest capped. */
export function requestJson(req: Record<string, unknown>): string {
  const slim = JSON.parse(JSON.stringify(req, (k, v) => (BULKY.has(k) ? undefined : v)));
  const s = JSON.stringify(slim);
  return s.length > 1500 ? s.slice(0, 1500) + "…" : s;
}

export class Permission {
  private o: PermissionOptions;
  private rules: RulesFile;
  private seen: Set<string> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lastError: string | null = null;

  constructor(o: PermissionOptions) {
    this.o = o;
    this.rules = new RulesFile(() => join(o.root(), "state", "decisions.md"));
  }

  private logPath(): string { return join(this.o.root(), "state", "permission-log.jsonl"); }

  /** Why the rules cannot be used right now (the deck banner), or null. */
  problem(): string | null {
    if (!this.o.root()) return null;
    const s = this.rules.get();
    return s.error ? `Permission rules unusable, every request escalates: ${s.error}` : null;
  }

  private load(): Set<string> {
    if (this.seen) return this.seen;
    const seen = new Set<string>();
    try {
      for (const l of readFileSync(this.logPath(), "utf8").split("\n")) {
        if (!l.trim()) continue;
        try { const e = JSON.parse(l) as PermissionEntry; seen.add(`${e.agentId}|${e.requestId}`); } catch {}
      }
    } catch {}
    return (this.seen = seen);
  }

  private append(e: Omit<PermissionEntry, "at">): void {
    const entry: PermissionEntry = { at: new Date((this.o.now ?? Date.now)()).toISOString(), ...e };
    this.load().add(`${e.agentId}|${e.requestId}`);
    try {
      mkdirSync(join(this.o.root(), "state"), { recursive: true });
      appendFileSync(this.logPath(), JSON.stringify(entry) + "\n");
    } catch (err) {
      this.o.log(`permission-log write failed: ${err}`);
    }
  }

  /** `agent.permission_requested`. Serialised so two requests never interleave their log lines and responses. */
  onRequested(ev: PermissionEvent): Promise<void> {
    const run = this.chain.then(() => this.handle(ev)).catch((e) => this.o.log(`permission hook failed: ${(e as Error)?.stack ?? e}`));
    this.chain = run;
    return run as Promise<void>;
  }

  private async handle(ev: PermissionEvent): Promise<void> {
    const root = this.o.root();
    if (!root) return;
    const sdk = this.o.ports.sdkPort();
    const info = sdk ? await sdk.agentInfo(ev.agent.id) : null;
    const task = info?.labels["fm.task"];
    if (!info || !task) return; // not crew
    const req = ev.request;
    if (this.load().has(`${ev.agent.id}|${req.id}`)) return;

    const state: RulesState = this.rules.get();
    const err = state.error;
    if (err && err !== this.lastError) this.o.log(`PROBLEM: ${err}`);
    this.lastError = err;

    const c = state.rules
      ? classify(state.rules, req, { cwd: info.cwd, root, task, paseoHome: this.o.paseoHome })
      : { decision: "escalate" as const, rule: `rules unusable (${err})` };
    const mode = state.rules?.mode ?? "shadow";
    const base = { agentId: ev.agent.id, task, requestId: req.id, kind: req.kind, name: req.name, summary: summarize(req), rule: c.rule, mode };

    if (c.decision === "allow") {
      if (mode !== "enforce") return this.append({ ...base, decision: "would-allow", acted: false, result: "logged" });
      try {
        await sdk!.respondToPermission(ev.agent.id, req.id, { behavior: "allow" });
        return this.append({ ...base, decision: "allow", acted: true, result: "responded" });
      } catch (e) {
        // the request stays pending; a human sees it through Paseo's own notification
        return this.append({ ...base, decision: "allow", acted: false, result: "respond-failed", note: String((e as Error).message).slice(0, 200) });
      }
    }

    // escalate: wake the first mate of a plugin-notified crew; anyone else is reached by Paseo's own permission notification
    if (info.labels["fm.notify"] !== "plugin" || !notifySwitchOn(root)) {
      return this.append({ ...base, decision: "escalate", acted: false, result: "no-wake", note: info.labels["fm.notify"] === "plugin" ? "switch off (decisions.md notify: plugin)" : "no fm.notify=plugin label" });
    }
    const message = [
      `## Crew PERMISSION · ${task}`,
      `${base.summary}`,
      `escalated by rule: ${c.rule}${mode === "shadow" ? " (shadow mode)" : ""}`,
      `agent ${ev.agent.id} · ${info.labels["fm.shape"] ?? "?"} · project ${info.labels["fm.project"] ?? "-"} · request ${req.id}`,
      requestJson(req),
    ].join("\n");
    let lastErr = "";
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      try {
        const target = await wakeTarget(this.o.ports, root, ev.agent.parentAgentId ?? info.labels[PARENT_LABEL] ?? null, info.labels["fm.project"]);
        if (!target) return this.append({ ...base, decision: "escalate", acted: false, result: "no-target", note: "no live parent and no first-mate claim" });
        await this.o.ports.send(target, message);
        return this.append({ ...base, decision: "escalate", acted: true, result: "woke", note: target });
      } catch (e) {
        lastErr = (e as Error).message;
        if (attempt < SEND_ATTEMPTS) await new Promise((r) => setTimeout(r, this.o.retryDelayMs ?? 2000));
      }
    }
    this.append({ ...base, decision: "escalate", acted: false, result: "wake-failed", note: lastErr.slice(0, 200) });
  }
}
