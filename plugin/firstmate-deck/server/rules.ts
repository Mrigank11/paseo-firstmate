// The auto-approve rules (S5): parse the fenced ```json fm-permission-rules block in state/decisions.md and classify one
// permission request against it. Pure apart from reading the file and resolving real paths. It only ever says "allow" or
// "escalate": nothing here denies. A missing or unparsable block escalates everything (fail closed).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type PermissionMode = "shadow" | "enforce";

export type Rules = {
  mode: PermissionMode;
  allowKinds: string[];
  read: boolean;
  /** Path templates (`$WORKTREE`, `$ROOT`, `$TASK`) a write or edit may land in. */
  writeWithin: string[];
  shell: { allow: RegExp[]; denyChars: string };
  fetchHosts: string[];
  /** Where a crew agent's cwd counts as its own worktree (default `<paseo home>/worktrees`). */
  worktreeRoots?: string[];
};

export type RulesState = { rules: Rules; error: null } | { rules: null; error: string };

/** The request fields the classifier reads (a structural subset of the SDK's AgentPermissionRequest). */
export type PermissionRequestLike = {
  id: string;
  kind: string;
  name: string;
  title?: string;
  detail?: { type: string; [k: string]: unknown };
  input?: unknown;
};

export type RuleContext = { cwd: string | null; root: string; task: string; paseoHome: string | null };

export type Classification = { decision: "allow" | "escalate"; rule: string };

const FENCE = /^```json[ \t]+fm-permission-rules[ \t]*\n([\s\S]*?)^```[ \t]*$/m;

const strings = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${what} must be an array of strings`);
  return v as string[];
};

/** Parse decisions.md text. Any problem comes back as an error string; the caller escalates everything. */
export function parseRules(text: string): RulesState {
  const m = FENCE.exec(text);
  if (!m) return { rules: null, error: "no ```json fm-permission-rules block in state/decisions.md" };
  try {
    const j = JSON.parse(m[1]);
    if (typeof j !== "object" || j === null || Array.isArray(j)) throw new Error("the block must be a JSON object");
    if (j.mode !== "shadow" && j.mode !== "enforce") throw new Error('mode must be "shadow" or "enforce"');
    const shell = j.shell ?? {};
    const allow = strings(shell.allow, "shell.allow").map((r) => new RegExp(r));
    const denyChars = shell.denyChars === undefined ? "" : String(shell.denyChars);
    return {
      error: null,
      rules: {
        mode: j.mode,
        allowKinds: strings(j.allowKinds, "allowKinds"),
        read: j.read === true,
        writeWithin: strings(j.writeWithin, "writeWithin"),
        shell: { allow, denyChars },
        fetchHosts: strings(j.fetchHosts, "fetchHosts"),
        ...(j.worktreeRoots !== undefined ? { worktreeRoots: strings(j.worktreeRoots, "worktreeRoots") } : {}),
      },
    };
  } catch (e) {
    return { rules: null, error: `fm-permission-rules: ${(e as Error).message}` };
  }
}

/** Reads state/decisions.md and re-parses only when its mtime moved. */
export class RulesFile {
  private cached: { mtimeMs: number; size: number; state: RulesState } | null = null;
  private path: () => string;
  constructor(path: () => string) {
    this.path = path;
  }
  get(): RulesState {
    const p = this.path();
    try {
      const st = statSync(p);
      if (this.cached && this.cached.mtimeMs === st.mtimeMs && this.cached.size === st.size) return this.cached.state;
      const state = parseRules(readFileSync(p, "utf8"));
      this.cached = { mtimeMs: st.mtimeMs, size: st.size, state };
      return state;
    } catch (e) {
      this.cached = null;
      return { rules: null, error: `state/decisions.md unreadable (${(e as Error).message})` };
    }
  }
}

/** Resolve symlinks of the longest existing prefix of `p`, then re-append the rest (a file to be written may not exist yet). */
export function realPathLoose(p: string): string {
  const parts: string[] = [];
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    parts.unshift(basename(cur));
    cur = up;
  }
  let base = cur;
  try { base = realpathSync(cur); } catch {}
  return join(base, ...parts);
}

const inside = (child: string, dir: string): boolean => child === dir || child.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The agent's worktree: its cwd, but only when that cwd sits under one of the Paseo worktree roots. */
export function worktreeOf(rules: Rules, ctx: RuleContext): string | null {
  if (!ctx.cwd) return null;
  const roots = rules.worktreeRoots?.length
    ? rules.worktreeRoots
    : [...(ctx.paseoHome ? [join(ctx.paseoHome, "worktrees")] : []), join(homedir(), ".paseo", "worktrees")];
  const cwd = realPathLoose(ctx.cwd);
  const ok = roots.some((r) => {
    const root = realPathLoose(r.replace(/^~(?=\/|$)/, homedir()));
    return cwd !== root && inside(cwd, root);
  });
  return ok ? cwd : null;
}

const SAFE_TASK = /^[A-Za-z0-9][\w.-]*$/;

function expand(t: string, ctx: RuleContext, worktree: string | null): string | null {
  if (t.includes("$WORKTREE") && !worktree) return null;
  if (t.includes("$TASK") && !SAFE_TASK.test(ctx.task)) return null;
  return t.replaceAll("$WORKTREE", worktree ?? "").replaceAll("$ROOT", ctx.root).replaceAll("$TASK", ctx.task);
}

// Flags that make an otherwise read-only allowlisted command write or run something.
const DANGEROUS_FLAG = /(^|\s)--(output|exec|ext-diff|open-files-in-pager)(=|\s|$)/;

/** Decide one request. `detail`-less or unknown-shaped requests always escalate. */
export function classify(rules: Rules, req: PermissionRequestLike, ctx: RuleContext): Classification {
  if (!rules.allowKinds.includes(req.kind)) return { decision: "escalate", rule: `kind:${req.kind} not in allowKinds` };
  const d = req.detail;
  if (!d) return { decision: "escalate", rule: "no tool detail" };
  switch (d.type) {
    case "read":
    case "search":
      return rules.read ? { decision: "allow", rule: `read:${d.type}` } : { decision: "escalate", rule: "read not allowed" };
    case "edit":
    case "write": {
      const raw = typeof d.filePath === "string" ? d.filePath : "";
      if (!raw) return { decision: "escalate", rule: `${d.type}: no filePath` };
      const wt = worktreeOf(rules, ctx);
      const target = realPathLoose(isAbsolute(raw) ? raw : resolve(ctx.cwd ?? ".", raw));
      for (const t of rules.writeWithin) {
        const dir = expand(t, ctx, wt);
        if (dir && inside(target, realPathLoose(dir))) return { decision: "allow", rule: `${d.type} within ${t}` };
      }
      return { decision: "escalate", rule: `${d.type} outside writeWithin (${target})` };
    }
    case "shell": {
      const cmd = typeof d.command === "string" ? d.command : "";
      if (!cmd.trim()) return { decision: "escalate", rule: "shell: empty command" };
      if (/[\n\r]/.test(cmd)) return { decision: "escalate", rule: "shell: newline in command" };
      const bad = [...rules.shell.denyChars].find((c) => cmd.includes(c));
      if (bad) return { decision: "escalate", rule: `shell: contains ${JSON.stringify(bad)}` };
      if (DANGEROUS_FLAG.test(cmd)) return { decision: "escalate", rule: "shell: write/exec flag" };
      const hit = rules.shell.allow.find((r) => r.test(cmd));
      return hit ? { decision: "allow", rule: `shell:${hit.source}` } : { decision: "escalate", rule: "shell: not on the allowlist" };
    }
    case "fetch": {
      let host = "";
      try { host = new URL(String(d.url)).hostname; } catch {}
      return host && rules.fetchHosts.includes(host) ? { decision: "allow", rule: `fetch:${host}` } : { decision: "escalate", rule: `fetch: host ${host || "?"} not in fetchHosts` };
    }
    default:
      return { decision: "escalate", rule: `detail:${d.type} has no rule` };
  }
}

/** A one-line description of a request, for the log and the wake message. */
export function summarize(req: PermissionRequestLike): string {
  const d = req.detail as Record<string, unknown> | undefined;
  const pick = d ? (typeof d.command === "string" ? d.command : typeof d.filePath === "string" ? d.filePath : typeof d.url === "string" ? d.url : typeof d.query === "string" ? d.query : "") : "";
  const text = pick || req.title || req.name;
  return `${d?.type ?? req.kind}: ${text}`.replace(/\s+/g, " ").slice(0, 240);
}
