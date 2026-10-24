// The first mate's side of the crew canvas, behind bin/page (canvas-snippet, canvas-answer, canvas-snapshot) and bin/page claim.
//   canvas-cmd.ts snippet <root> <scout|ship>                      the "## Your canvas" brief section (stdout)
//   canvas-cmd.ts answer <root> <task> <askId> (<value> | --decline <why>) [--agent <id>]   deliver (or decline) a pick through agent-canvas
//   canvas-cmd.ts snapshot <root> <task> [--agent <id>]            state/tasks/<task>/canvas.final.html + canvas.final.tsx
//   canvas-cmd.ts relabel <root> <newFirstMate> [<project>]        the live crew agents whose canvas.relay is some other agent (one id per line)
// Where agent-canvas is: AGENT_CANVAS_URL, else the `canvasUrl` the deck stamped into page.json (default http://127.0.0.1:6790);
// its checkout AGENT_CANVAS_DIR, else the stamped `canvasDir`; the relay key AGENT_CANVAS_KEY_FILE, else <PASEO_HOME or ~/.paseo>/agent-canvas/relay.key.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canvasUrl, labelledAgents, type Rec } from "./stage-data.ts";
import { projectClaimedId } from "./claims.ts";
import { loadAllLive } from "./state.ts";
import { currentAgent } from "./stage.ts";

const DEFAULT_URL = "http://127.0.0.1:6790";

function die(msg: string): never {
  console.error(`page: ${msg}`);
  process.exit(1);
}

const baseUrl = (root: string) => (canvasUrl(root) || DEFAULT_URL).replace(/\/+$/, "");

function canvasDir(root: string): string {
  const env = (process.env.AGENT_CANVAS_DIR ?? "").trim();
  if (env) return env;
  try {
    for (const p of readdirSync(join(root, "state", "projects"))) {
      try {
        const d = JSON.parse(readFileSync(join(root, "state", "projects", p, "page.json"), "utf8")).canvasDir;
        if (typeof d === "string" && d) return d;
      } catch {}
    }
  } catch {}
  return "";
}

const keyFile = () => process.env.AGENT_CANVAS_KEY_FILE || join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "agent-canvas", "relay.key");

// ---------- the brief section ----------

const SHAPE: Record<string, string> = {
  ship: `<Canvas title="<what you are building>" status="working">
  <Bluf>Reading the brief.</Bluf>
  <Steps title="Plan">
    <Step id="understand" state="active">Understand the brief</Step>
    <Step id="implement" state="pending">Implement</Step>
    <Step id="test" state="pending">Test</Step>
    <Step id="ship" state="pending">Commit and report</Step>
  </Steps>
</Canvas>
Add <Diff file="path">…</Diff> once you have a change worth showing. Add an <Ask> only when you need the captain.`,
  scout: `<Canvas title="<what you are finding out>" status="working">
  <Bluf>Reading the brief.</Bluf>
  <Steps title="Plan">
    <Step id="read" state="active">Read</Step>
    <Step id="analyse" state="pending">Analyse</Step>
    <Step id="report" state="pending">Write the report</Step>
  </Steps>
  <Markdown id="findings">Findings so far, and the path of the report you will write (the deliverable named in this brief).</Markdown>
</Canvas>
Keep <Markdown id="findings"> current as you learn things (patch its text); finish by pointing it at the report file.`,
};

export function snippet(root: string, shape: string): string {
  if (!SHAPE[shape]) die("usage: bin/page canvas-snippet <scout|ship>");
  const dir = canvasDir(root);
  if (!dir) die("canvasDir is not set: put the agent-canvas checkout in the firstmate-deck settings (canvasDir) or AGENT_CANVAS_DIR, and let the plugin render once");
  const port = Number(new URL(baseUrl(root)).port) || 6790;
  let recipe: string;
  try { recipe = execFileSync("node", [join(dir, "server", "brief-snippet.ts"), String(port)], { encoding: "utf8", timeout: 20_000, env: { ...process.env, NODE_NO_WARNINGS: "1" } }).trimEnd(); }
  catch (e) { die(`could not run ${dir}/server/brief-snippet.ts: ${(e as Error).message.split("\n")[0]}`); }
  return `## Your canvas

${recipe}

### Set your canvas first

Your very first action, before reading anything else: \`set\` a canvas shaped like this, then patch it as each step moves. If a canvas from an earlier task is already there, replace it.

\`\`\`
${SHAPE[shape]}
\`\`\`

### Questions for the captain

A question for the captain goes on your canvas as \`<Ask id=… question=… blocking>\` with \`<Option>\`s, never only in chat. Then end your turn with \`BLOCKED: canvas ask <id>\`. The answer arrives as your next message.
`;
}

// ---------- agents ----------

/** The task's current agent (newest live one, else the newest archived), or --agent. */
function agentOf(root: string, task: string, override?: string): string {
  if (override) return override;
  const mine = labelledAgents([task]).filter((r) => r.task === task);
  const cur = currentAgent(mine.map((r) => ({ ...r, id: r.id })));
  if (!cur) die(`no agent carries fm.task=${task}`);
  return cur.id;
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) die(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

const timeout = (ms: number): AbortSignal => { const ac = new AbortController(); setTimeout(() => ac.abort(), ms).unref(); return ac.signal; };

async function getText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const r = await fetch(url, { signal: timeout(8000) });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

// ---------- commands ----------

async function answer(root: string, args: string[]): Promise<void> {
  const decline = takeFlag(args, "--decline");
  const override = takeFlag(args, "--agent");
  const [task, rawAsk, value] = args;
  if (!task || !rawAsk || (decline === undefined && value === undefined)) die("usage: bin/page canvas-answer <task> <askId> <value> | --decline \"<why>\" [--agent <id>]");
  const askId = rawAsk.replace(/^c-/, ""); // the page's option target is t-<task>#c-<askId>
  const agentId = agentOf(root, task, override);
  let key = "";
  try { key = readFileSync(keyFile(), "utf8").trim(); } catch { die(`cannot read the relay key ${keyFile()}: is agent-canvas running on this daemon? (AGENT_CANVAS_KEY_FILE overrides)`); }
  const r = await fetch(`${baseUrl(root)}/api/fm/deliver`, {
    method: "POST", headers: { "content-type": "application/json", "x-canvas-key": key },
    body: JSON.stringify(decline !== undefined ? { agentId, askId, decline } : { agentId, askId, value }), signal: timeout(10_000),
  }).catch((e) => die(`agent-canvas unreachable at ${baseUrl(root)}: ${(e as Error).message}`));
  const text = await r.text();
  let body: any = {};
  try { body = JSON.parse(text); } catch {}
  if (!r.ok || body?.ok === false) die(`agent-canvas refused (${r.status}): ${body?.error ?? text.slice(0, 200)}`);
  console.log(`${decline !== undefined ? "declined" : "delivered"}: ${task} (agent ${agentId}) ask ${askId}${decline !== undefined ? `: ${decline}` : ` = ${value}`}`);
}

async function snapshot(root: string, args: string[]): Promise<void> {
  const override = takeFlag(args, "--agent");
  const task = args[0];
  if (!task) die("usage: bin/page canvas-snapshot <task> [--agent <id>]");
  const agentId = agentOf(root, task, override);
  const base = baseUrl(root);
  const enc = encodeURIComponent(agentId);
  let card = await getText(`${base}/api/fm/card/${enc}`).catch(() => null);
  if (card && !card.ok) card = await getText(`${base}/api/fm/card/${enc}?archived=1`).catch(() => null);
  if (!card || !card.ok) die(`agent-canvas has no canvas for agent ${agentId} (is it running at ${base}?)`);
  const css = await getText(`${base}/api/fm/css?theme=light`).catch(() => null);
  const src = await getText(`${base}/api/canvas/${enc}`).catch(() => null);
  const dir = join(root, "state", "tasks", task);
  mkdirSync(dir, { recursive: true });
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Canvas · ${task.replace(/[<>&"]/g, "")}</title>\n<style>\nbody{margin:0;background:#fff}\n.cv-snap{max-width:860px;margin:24px auto;padding:0 16px}\n${css?.ok ? css.text.replace(/<\/style/gi, "<\\/style") : ""}\n</style></head><body>\n<div class="cv-snap acv">${card.text}</div>\n</body></html>\n`;
  writeFileSync(join(dir, "canvas.final.html"), html);
  const tsx = src?.ok && src.text && !/^No canvas yet\.?$/.test(src.text.trim());
  if (tsx) writeFileSync(join(dir, "canvas.final.tsx"), src!.text.endsWith("\n") ? src!.text : `${src!.text}\n`);
  console.log(`snapshot: ${join(dir, "canvas.final.html")}${tsx ? ` and canvas.final.tsx` : " (no canvas source to keep)"} from agent ${agentId}`);
}

/** Live crew agents (of `project`'s open tasks, or all) whose `canvas.relay` label names some other agent. */
function relabel(root: string, newId: string, project?: string): void {
  // the checkout-wide first mate (no project) re-points only the crews of pages that have no claim of their own
  const tasks = loadAllLive(root).filter((t) => (project ? t.project === project : !t.project || !projectClaimedId(root, t.project)) && t.state !== "done" && t.state !== "failed");
  if (!tasks.length) return;
  const recs = labelledAgents(tasks.map((t) => t.id));
  const ids = new Set<string>();
  for (const t of tasks) {
    const mine: Rec[] = recs.filter((r) => r.task === t.id && !r.archived);
    for (const r of mine) {
      const to = r.labels?.["canvas.relay"];
      if (to && to !== newId) ids.add(r.id);
    }
  }
  for (const id of ids) console.log(id);
}

const [cmd, root, ...rest] = process.argv.slice(2);
if (!cmd || !root) die("usage: canvas-cmd.ts <snippet|answer|snapshot|relabel> <root> ...");
switch (cmd) {
  case "snippet": process.stdout.write(snippet(root, rest[0] ?? "")); break;
  case "answer": await answer(root, rest); break;
  case "snapshot": await snapshot(root, rest); break;
  case "relabel": if (!rest[0]) die("relabel needs the new first mate's agent id"); relabel(root, rest[0], rest[1]); break;
  default: die(`unknown command '${cmd}'`);
}
