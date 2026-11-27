// The auto-approve rules (S5): parse the fenced ```json fm-permission-rules block in state/decisions.md and classify one
// permission request against it. Pure apart from reading the file and resolving real paths. It only ever says "allow" or
// "escalate": nothing here denies. A missing or unparsable block escalates everything (fail closed). For a crew on another host
// (`remote`) only checks on the request's own text apply: anything that would look at files here, or means "that machine"
// (loopback), escalates.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { redact } from "./redact.ts";

export type PermissionMode = "shadow" | "enforce";

export type Rules = {
  mode: PermissionMode;
  allowKinds: string[];
  read: boolean;
  /** Path templates (`$WORKTREE`, `$ROOT`, `$TASK`) a write or edit may land in. */
  writeWithin: string[];
  shell: {
    allow: RegExp[];
    /** Extra characters refused anywhere in a command (the parser already refuses expansion and subshell syntax). */
    denyChars: string;
    /** Transparent wrappers stripped from the head of a command before matching: regexes over the space-joined words. */
    wrappers: RegExp[];
    /** Leading `NAME=value` assignments whose NAME matches are never stripped: the command escalates. */
    envDeny: RegExp;
  };
  fetchHosts: string[];
  /** Where a crew agent's cwd counts as its own worktree (default `<paseo home>/worktrees`). */
  worktreeRoots?: string[];
};

export const DEFAULT_WRAPPERS = ["^rtk ", "^time ", "^command ", "^nohup ", "^nice( -n -?\\d+)? ", "^timeout( -[-\\w=]+)* \\d+[smhd]? ", "^env( -i)? "];
export const DEFAULT_ENV_DENY = "^(PATH|LD_\\w*|DYLD_\\w*|NODE_\\w*|GIT_\\w*|BASH_ENV|ENV|IFS|SHELL|PAGER|EDITOR|VISUAL|PYTHON\\w*|RUBY\\w*|PERL\\w*|HOME)$";

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

export type RuleContext = { cwd: string | null; root: string; task: string; paseoHome: string | null; remote?: boolean };

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
        shell: {
          allow,
          denyChars,
          wrappers: strings(shell.wrappers ?? DEFAULT_WRAPPERS, "shell.wrappers").map((r) => new RegExp(r)),
          envDeny: new RegExp(typeof shell.envDeny === "string" ? shell.envDeny : DEFAULT_ENV_DENY),
        },
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
const DANGEROUS_FLAG = /(^|\s)--(output|exec|ext-diff|open-files-in-pager|pre|pre-glob)(=|\s|$)/;


// ---------- shell commands ----------

type Redirect = { op: "write"; target: string };
type Segment = { words: string[]; redirects: Redirect[] };

/**
 * A deliberately small shell reader, not a shell. It splits a command into segments at `&& || ; |` and each segment into
 * words (quotes removed), and collects output redirections. Anything it cannot read with certainty returns an error, which
 * escalates: expansion (`$`, backticks), subshells and groups (`(`), a lone `&`, here-docs, comments, newlines, unterminated
 * quotes. Input redirections are reads and are dropped.
 */
export function splitShell(cmd: string): { segments: Segment[] } | { error: string } {
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let cur: string | null = null; // the word being built (null: between words)
  let pending: "write" | "read" | null = null; // a redirection waiting for its target word
  const endWord = (): string | null => {
    if (cur === null) return null;
    const w = cur;
    cur = null;
    if (pending === "write") redirects.push({ op: "write", target: w });
    else if (pending !== "read") words.push(w);
    pending = null;
    return null;
  };
  const endSegment = (): string | null => {
    endWord();
    if (pending) return "redirection without a target";
    if (!words.length && !redirects.length) return "empty command around an operator";
    segments.push({ words, redirects });
    words = [];
    redirects = [];
    return null;
  };
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return { error: "unterminated quote" };
      cur = (cur ?? "") + cmd.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let buf = "";
      for (; j < n && cmd[j] !== '"'; j++) {
        if (cmd[j] === "$" || cmd[j] === "`") return { error: "expansion inside double quotes" };
        if (cmd[j] === "\\" && j + 1 < n && /["\\]/.test(cmd[j + 1])) j++;
        buf += cmd[j];
      }
      if (j >= n) return { error: "unterminated quote" };
      cur = (cur ?? "") + buf;
      i = j + 1;
    } else if (c === "\\") {
      if (i + 1 >= n) return { error: "trailing backslash" };
      cur = (cur ?? "") + cmd[i + 1];
      i += 2;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "$" || c === "`" || c === "(" || c === ")") {
      return { error: `unsupported shell syntax ${JSON.stringify(c)}` };
    } else if (c === "#" && cur === null) {
      return { error: "comment" };
    } else if (c === "&") {
      if (cmd[i + 1] === "&") { const e = endSegment(); if (e) return { error: e }; i += 2; }
      else if (cmd[i + 1] === ">") return { error: "&> redirection" };
      else return { error: "background job" };
    } else if (c === "|") {
      const e = endSegment();
      if (e) return { error: e };
      i += cmd[i + 1] === "|" ? 2 : 1;
      if (cmd[i] === "&") return { error: "|& pipe" };
    } else if (c === ";") {
      const e = endSegment();
      if (e) return { error: e };
      i++;
    } else if (c === ">" || c === "<") {
      // an fd number glued to the operator (`2>`) belongs to it, not to the words
      if (cur !== null && /^\d$/.test(cur) && !pending) cur = null;
      else endWord();
      if (pending) return { error: "redirection without a target" };
      if (c === "<") {
        if (cmd[i + 1] === "<" || cmd[i + 1] === "(" || cmd[i + 1] === ">") return { error: "here-doc or process substitution" };
        pending = "read";
        i++;
      } else {
        if (cmd[i + 1] === "(") return { error: "process substitution" };
        if (cmd[i + 1] === "&") {
          // `2>&1`, `>&2`: a duplicate of an open fd, not a file
          const m = /^&(\d|-)(?=$|[\s;|&])/.exec(cmd.slice(i + 1));
          if (!m) return { error: "unsupported >& redirection" };
          i += 1 + m[0].length;
          continue;
        }
        if (cmd[i + 1] === ">") i++;
        if (cmd[i + 1] === "|") i++; // `>|`
        pending = "write";
        i++;
      }
    } else {
      cur = (cur ?? "") + c;
      i++;
    }
  }
  const e = endSegment();
  if (e) return { error: e };
  return { segments };
}

const quoteWord = (w: string): string => (/[\s'"\\*?[\]{}~]/.test(w) || w === "" ? `'${w.replaceAll("'", "'\\''")}'` : w);

/** Strip leading env assignments and transparent wrappers; null when an assignment is denied or nothing is left. */
export function normalizeSegment(words: readonly string[], sh: Rules["shell"]): { text: string } | { error: string } {
  let w = [...words];
  for (let guard = 0; guard < 8; guard++) {
    let moved = false;
    while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) {
      const name = w[0].slice(0, w[0].indexOf("="));
      if (sh.envDeny.test(name)) return { error: `env assignment ${name} is not allowed` };
      w = w.slice(1);
      moved = true;
    }
    if (!w.length) break;
    const joined = w.map(quoteWord).join(" ");
    for (const re of sh.wrappers) {
      const m = re.exec(joined);
      if (!m || m.index !== 0 || !m[0].length) continue;
      // the match must end on a word boundary: count whole words consumed
      let used = 0, len = 0;
      while (used < w.length && len < m[0].length) { len += quoteWord(w[used]).length + 1; used++; }
      if (len !== m[0].length) continue;
      w = w.slice(used);
      moved = true;
      break;
    }
    if (!moved) break;
  }
  if (!w.length) return { error: "nothing to run after wrappers" };
  return { text: w.map(quoteWord).join(" ") };
}

function writeAllowed(rules: Rules, ctx: RuleContext, raw: string): { ok: boolean; target: string } {
  if (ctx.remote) return { ok: false, target: raw };
  const wt = worktreeOf(rules, ctx);
  const target = realPathLoose(isAbsolute(raw) ? raw : resolve(ctx.cwd ?? ".", raw));
  for (const t of rules.writeWithin) {
    const dir = expand(t, ctx, wt);
    if (dir && inside(target, realPathLoose(dir))) return { ok: true, target };
  }
  return { ok: false, target };
}

function classifyShell(rules: Rules, cmd: string, ctx: RuleContext): Classification {
  const esc = (why: string): Classification => ({ decision: "escalate", rule: `shell: ${why}` });
  if (!cmd.trim()) return esc("empty command");
  if (/[\n\r]/.test(cmd)) return esc("newline in command");
  const bad = [...rules.shell.denyChars].find((c) => cmd.includes(c));
  if (bad) return esc(`contains ${JSON.stringify(bad)}`);
  const parsed = splitShell(cmd);
  if ("error" in parsed) return esc(`unparseable (${parsed.error})`);
  const hits: string[] = [];
  for (const seg of parsed.segments) {
    for (const r of seg.redirects) {
      if (/[*?[\]{}]/.test(r.target) || r.target.startsWith("~") || r.target === "") return esc(`redirect target ${JSON.stringify(r.target)} is not a plain path`);
      if (r.target === "/dev/null") continue;
      const w = writeAllowed(rules, ctx, r.target);
      if (!w.ok) return esc(ctx.remote ? `redirect to ${w.target} on another host cannot be checked` : `redirect to ${w.target} outside writeWithin`);
    }
    if (!seg.words.length) return esc("redirection without a command");
    const n = normalizeSegment(seg.words, rules.shell);
    if ("error" in n) return esc(n.error);
    if (DANGEROUS_FLAG.test(n.text)) return esc(`write/exec flag in ${JSON.stringify(n.text)}`);
    const hit = rules.shell.allow.find((r) => r.test(n.text));
    if (!hit) return esc(`${JSON.stringify(n.text)} is not on the allowlist`);
    hits.push(hit.source);
  }
  return { decision: "allow", rule: `shell:${[...new Set(hits)].join(" + ")}` };
}

const LOOPBACK = /^((.*\.)?localhost\.?|127\..*|0\.0\.0\.0|\[::1?\]|\[::ffff:7f.*\])$/i;

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
      if (ctx.remote) return { decision: "escalate", rule: `${d.type}: files on another host cannot be checked (${raw})` };
      const w = writeAllowed(rules, ctx, raw);
      if (w.ok) return { decision: "allow", rule: `${d.type} within writeWithin` };
      const target = w.target;
      return { decision: "escalate", rule: `${d.type} outside writeWithin (${target})` };
    }
    case "shell":
      return classifyShell(rules, typeof d.command === "string" ? d.command : "", ctx);
    case "fetch": {
      let host = "";
      try { host = new URL(String(d.url)).hostname; } catch {}
      if (ctx.remote && LOOPBACK.test(host)) return { decision: "escalate", rule: `fetch: ${host} is the other host's own machine` };
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
  return redact(`${d?.type ?? req.kind}: ${text}`).replace(/\s+/g, " ").slice(0, 240);
}
