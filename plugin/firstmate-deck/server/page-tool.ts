// Deterministic helper behind bin/page: scaffold, page.json, inbox and section-note edits.
//   page-tool.ts scaffold <root> <project> [--repo R] [--title T] [--page P]
//   page-tool.ts page-path <root> <project>
//   page-tool.ts session <root> <project> <url>
//   page-tool.ts answered <root> <project>        (prints how many entries were marked)
//   page-tool.ts note <root> <project> <section> <text>
//   page-tool.ts status <root> [project]          (env PAGE_PLUGIN_STATUS names the plugin state)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { inboxPath, pageJsonPath, patchPageJson, projectDir, readInbox, readPageJson, updateInbox, writeAtomic } from "./store.ts";

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

function status(root: string, only?: string): void {
  const base = join(root, "state", "projects");
  const names = (only ? [only] : existsSync(base) ? readdirSync(base) : []).filter((n) => existsSync(join(base, n, "project.json")));
  const plugin = process.env.PAGE_PLUGIN_STATUS || "unknown";
  const rows = [["PROJECT", "SESSION", "URL", "UNDELIVERED", "LAST DELIVERY", "PLUGIN"]];
  for (const n of names) {
    const pj = readPageJson(pageJsonPath(root, n));
    const und = readInbox(inboxPath(root, n)).filter((e) => !e.delivered).length;
    rows.push([n, pj.session, pj.lavishUrl ?? "-", String(und), pj.lastDelivery ?? "-", plugin]);
  }
  if (rows.length === 1) { console.log(only ? `no such project '${only}'` : "no projects"); return; }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
}

const [cmd, root, ...rest] = process.argv.slice(2);
if (!cmd || !root) die("usage: page-tool.ts <scaffold|page-path|session|answered|note|status> <root> ...");

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
    patchPageJson(pageJsonPath(root, project), { lavishUrl: url, session: "open" });
    break;
  }
  case "answered": {
    const project = slug(rest[0]);
    console.log(updateInbox(inboxPath(root, project), (e) => { if (e.delivered && !e.answered) e.answered = true; }));
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
    appendFileSync(f, `- ${stamp()} ${text.replace(/\s*\n\s*/g, " ")}\n`);
    break;
  }
  case "status":
    status(root, rest[0]);
    break;
  default:
    die(`unknown command '${cmd}'`);
}
