// Deterministic helper behind bin/page: scaffold, page.json, inbox and section-note edits.
//   page-tool.ts scaffold <root> <project> [--repo R] [--title T] [--page P]
//   page-tool.ts page-path <root> <project>
//   page-tool.ts session <root> <project> <url>
//   page-tool.ts answered <root> <project> [ids]  (prints how many entries were marked; ids = comma list, default every delivered one)
//   page-tool.ts delivered-ids <root> <project>   (comma list of the delivered, unanswered comment ids: what a reply is about to answer)
//   page-tool.ts choices <root> <project> [ids]   (one line per delivered, unanswered, non-stale option click: "<task> <askId> <commentId>")
//   page-tool.ts note <root> <project> <section> <text>
//   page-tool.ts status <root> [project]          (env PAGE_PLUGIN_STATUS names the plugin state)
//   page-tool.ts claim <root> <agentId>           (writes state/firstmate.json: THE first mate of this checkout)
//   page-tool.ts stalled <root> <seconds>        (prints the open projects the plugin has not rendered for that long; not those with a load error)
//   page-tool.ts load-errors <root>               (prints "<project>: <file>: <why>" for every project whose state files cannot be read)
//   page-tool.ts lavish-cfg <root> [project]      (prints the plugin's Lavish port/state dir as shell lines, if known)
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askIdOf, inboxPath, pageJsonPath, patchPageJson, projectDir, readInbox, readPageJson, updateInbox, writeAtomic } from "./store.ts";

const SECTIONS: Record<string, string> = {
  endpoints: "No endpoints or credentials recorded yet.",
  flags: "No flags recorded yet.",
  code: "No local code changes recorded yet.",
  decisions: "No decisions recorded yet.",
  how: "How this project runs is not written down yet.",
};

function die(msg: string): never {
  console.error(`page: ${msg}`);
  process.exit(1);
}

function slug(p: string | undefined): string {
  if (!p || !/^[a-z0-9][a-z0-9-]*$/.test(p)) die(`bad project slug '${p ?? ""}' (lowercase letters, digits, dashes)`);
  return p;
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) die(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

function pagePath(root: string, project: string): string {
  try {
    const cfg = JSON.parse(readFileSync(join(projectDir(root, project), "project.json"), "utf8"));
    if (typeof cfg.page === "string" && cfg.page) return cfg.page;
  } catch {}
  return join(projectDir(root, project), "page.html");
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function scaffold(root: string, project: string, args: string[]): void {
  const repo = takeFlag(args, "--repo");
  const title = takeFlag(args, "--title");
  const page = takeFlag(args, "--page");
  if (page && !page.startsWith("/")) die("--page must be an absolute path");
  const dir = projectDir(root, project);
  const cfgFile = join(dir, "project.json");
  mkdirSync(join(dir, "sections"), { recursive: true });
  let cfg: any;
  if (existsSync(cfgFile)) {
    try { cfg = JSON.parse(readFileSync(cfgFile, "utf8")); } catch (e) { die(`${cfgFile}: invalid JSON`); }
  } else {
    cfg = { title: project, sections: Object.keys(SECTIONS) };
    for (const [name, line] of Object.entries(SECTIONS)) {
      const f = join(dir, "sections", `${name}.md`);
      if (!existsSync(f)) writeFileSync(f, line + "\n");
    }
  }
  const before = JSON.stringify(cfg);
  if (title) cfg.title = title;
  if (repo) cfg.repo = repo;
  if (page) cfg.page = page;
  if (!existsSync(cfgFile) || JSON.stringify(cfg) !== before) writeAtomic(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
}

const ago = (iso: string | null | undefined): string => {
  const t = Date.parse(iso ?? "");
  if (isNaN(t)) return "-";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

function status(root: string, only?: string): void {
  const base = join(root, "state", "projects");
  const names = (only ? [only] : existsSync(base) ? readdirSync(base) : []).filter((n) => existsSync(join(base, n, "project.json")));
  const plugin = process.env.PAGE_PLUGIN_STATUS || "unknown";
  const mine = real(root);
  const rows = [["PROJECT", "SESSION", "LISTENER", "BANNER", "RENDERED", "PLUGIN ROOT", "UNDELIVERED", "LAST DELIVERY", "PLUGIN", "URL", "LOAD ERROR"]];
  for (const n of names) {
    const pj = readPageJson(pageJsonPath(root, n));
    const und = readInbox(inboxPath(root, n)).filter((e) => !e.delivered).length;
    const banner = pj.banner ? (pj.banner.length > 48 ? pj.banner.slice(0, 47) + "…" : pj.banner) : "-";
    const pr = pj.pluginRoot ? (real(pj.pluginRoot) === mine ? pj.pluginRoot : `${pj.pluginRoot} (NOT this checkout)`) : "-";
    rows.push([n, pj.session, pj.listener || "-", banner, ago(pj.lastRender), pr, String(und), pj.lastDelivery ?? "-", plugin, pj.lavishUrl ?? "-", pj.loadError ? `state file problem: ${pj.loadError}` : "-"]);
  }
  if (rows.length === 1) { console.log(only ? `no such project '${only}'` : "no projects"); return; }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
  untaggedWarnings(root, names);
}

/**
 * Live tasks with no project never show on a page. Warn (on stderr) about them while project pages exist: by name when
 * the task's workspace sits inside a project's repo, else as a count.
 */
function untaggedWarnings(root: string, projects: string[]): void {
  let tasks: any[] = [];
  try { tasks = JSON.parse(readFileSync(join(root, "state", "fleet.json"), "utf8"))?.tasks ?? []; } catch { return; }
  const repos = new Map<string, string>();
  const base = join(root, "state", "projects");
  for (const n of existsSync(base) ? readdirSync(base) : []) {
    try { const r = JSON.parse(readFileSync(join(base, n, "project.json"), "utf8")).repo; if (typeof r === "string" && r) repos.set(n, r.replace(/\/+$/, "")); } catch {}
  }
  if (!repos.size && !projects.length) return;
  const loose = tasks.filter((t) => t && !t.project && t.status !== "done" && t.status !== "failed");
  const rest: string[] = [];
  for (const t of loose) {
    const ws = typeof t.workspaceId === "string" ? t.workspaceId : "";
    const hit = ws.startsWith("/") ? [...repos].find(([, r]) => ws === r || ws.startsWith(r + "/") || ws.startsWith(r + "-")) : undefined;
    if (hit) console.error(`warning: live task ${t.id} has no project, but its workspace is in project ${hit[0]}'s repo (${hit[1]}): bin/fleet set ${t.id} project=${hit[0]}`);
    else rest.push(t.id);
  }
  if (rest.length) console.error(`warning: ${rest.length} live task${rest.length === 1 ? "" : "s"} ha${rest.length === 1 ? "s" : "ve"} no project while project pages exist (${rest.join(", ")}): they are invisible on every page; set project=<slug> if they belong on one`);
}

function loadErrors(root: string): string[] {
  const base = join(root, "state", "projects");
  return (existsSync(base) ? readdirSync(base) : [])
    .filter((n) => existsSync(join(base, n, "project.json")))
    .map((n) => [n, readPageJson(pageJsonPath(root, n)).loadError] as const)
    .filter(([, e]) => !!e)
    .map(([n, e]) => `${n}: ${e}`);
}

const [cmd, root, ...rest] = process.argv.slice(2);
if (!cmd || !root) die("usage: page-tool.ts <scaffold|page-path|session|answered|delivered-ids|choices|note|status|claim|stalled|load-errors|lavish-cfg> <root> ...");

switch (cmd) {
  case "scaffold": {
    const project = slug(rest.shift());
    scaffold(root, project, rest);
    break;
  }
  case "page-path":
    console.log(pagePath(root, slug(rest[0])));
    break;
  case "session": {
    const project = slug(rest[0]);
    const url = rest[1];
    if (!url) die("session needs a url");
    // listener "pending": the plugin must say "ok" again for this open (bin/page start waits for it)
    patchPageJson(pageJsonPath(root, project), { lavishUrl: url, session: "open", listener: "pending", listenerDetail: null });
    break;
  }
  case "answered": {
    const project = slug(rest[0]);
    const only = rest[1] ? new Set(rest[1].split(",").filter(Boolean)) : null; // a reply answers what was there when it started
    console.log(updateInbox(inboxPath(root, project), (e) => { if (e.delivered && !e.answered && (!only || only.has(e.id))) e.answered = true; }));
    break;
  }
  case "delivered-ids": {
    const project = slug(rest[0]);
    console.log(readInbox(inboxPath(root, project)).filter((e) => e.delivered && !e.answered).map((e) => e.id).join(","));
    break;
  }
  case "choices": {
    const project = slug(rest[0]);
    const only = rest[1] ? new Set(rest[1].split(",").filter(Boolean)) : null;
    for (const e of readInbox(inboxPath(root, project))) {
      const a = askIdOf(e.choice?.ask);
      if (e.choice && a && e.delivered && !e.answered && !e.stale && (!only || only.has(e.id))) console.log(`${e.choice.task} ${a} ${e.id}`);
    }
    break;
  }
  case "note": {
    const project = slug(rest[0]);
    const section = rest[1];
    const text = rest[2];
    if (!section || !/^[\w-]+$/.test(section)) die(`bad section name '${section ?? ""}'`);
    if (!text) die("note needs text");
    const f = join(projectDir(root, project), "sections", `${section}.md`);
    mkdirSync(join(projectDir(root, project), "sections"), { recursive: true });
    // the first real note replaces the scaffold's placeholder line instead of sitting under it
    const before = existsSync(f) ? readFileSync(f, "utf8") : "";
    const kept = before.split("\n").filter((l) => !Object.values(SECTIONS).includes(l.trim())).join("\n").replace(/^\n+/, "");
    const line = `- ${stamp()} ${text.replace(/\s*\n\s*/g, " ")}\n`;
    writeAtomic(f, (kept && !kept.endsWith("\n") ? kept + "\n" : kept) + line);
    break;
  }
  case "status":
    status(root, rest[0]);
    break;
  case "stalled": {
    const secs = Number(rest[0]);
    const base = join(root, "state", "projects");
    const late = (existsSync(base) ? readdirSync(base) : []).filter((n) => {
      if (!existsSync(join(base, n, "project.json"))) return false;
      const pj = readPageJson(pageJsonPath(root, n));
      if (pj.loadError) return false; // unreadable state is not a stall: reloading the plugin would change nothing
      const t = Date.parse(pj.lastRender ?? "");
      return pj.session === "open" && !isNaN(t) && Date.now() - t > secs * 1000;
    });
    console.log(late.join(" "));
    break;
  }
  case "load-errors":
    for (const l of loadErrors(root)) console.log(l);
    break;
  case "claim": {
    const agentId = rest[0];
    if (!agentId) die("claim needs an agent id");
    writeAtomic(join(root, "state", "firstmate.json"), JSON.stringify({ agentId, claimedAt: new Date().toISOString() }, null, 2) + "\n");
    break;
  }
  case "lavish-cfg": {
    // The plugin's effective Lavish config (page.json of this project, else of any project): shell lines for eval
    const base = join(root, "state", "projects");
    const order = [rest[0], ...(existsSync(base) ? readdirSync(base) : [])].filter((n): n is string => !!n);
    for (const n of order) {
      const f = pageJsonPath(root, n);
      if (!existsSync(f)) continue;
      const pj = readPageJson(f);
      if (!("lavishPort" in pj) && !("lavishStateDir" in pj)) continue;
      const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
      console.log(pj.lavishPort ? `export LAVISH_AXI_PORT=${q(String(pj.lavishPort))}` : "unset LAVISH_AXI_PORT");
      console.log(pj.lavishStateDir ? `export LAVISH_AXI_STATE_DIR=${q(String(pj.lavishStateDir))}` : "unset LAVISH_AXI_STATE_DIR");
      break;
    }
    break;
  }
  default:
    die(`unknown command '${cmd}'`);
}
