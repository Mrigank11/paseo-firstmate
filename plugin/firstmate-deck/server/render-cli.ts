// Deterministic renderer: node render-cli.ts <firstmateRoot> <project> [--out <file>] [--agents <agents.json>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadProject } from "./state.ts";
import { liveJs, renderProject, type AgentView } from "./render.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v) { console.error(`${name} needs a value`); process.exit(2); }
  args.splice(i, 2);
  return v;
};
const out = flag("--out");
const agentsFile = flag("--agents");
const [root, project] = args;
if (!root || !project || args.length > 2) {
  console.error("usage: render-cli.ts <firstmateRoot> <project> [--out <file>] [--agents <agents.json>]");
  process.exit(2);
}

try {
  const model = loadProject(resolve(root), project);
  const agents: Record<string, AgentView> = agentsFile ? JSON.parse(readFileSync(agentsFile, "utf8")) : {};
  const target = resolve(out ?? model.page ?? join(root, "state", "projects", project, "page.html"));
  const now = new Date();
  const r = renderProject(model, agents, {
    now,
    tickSeconds: 20,
    paseoAgentUrl: (id) => `${process.env.PASEO_WEB_URL ?? "http://localhost:6767/agent/"}${id}`,
    pageFile: basename(target),
  });
  const p2 = (n: number) => String(n).padStart(2, "0");
  const ts = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, r.page);
  writeFileSync(target.replace(/\.[^./]*$/, "") + ".live.js", liveJs(r.live.replace(/\{TS\}/g, ts)));
  console.log(`wrote ${target} (signature ${r.signature.slice(0, 12)})`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
