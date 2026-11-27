// The first mate's side of the crew canvas, behind bin/page (canvas-snippet, canvas-answer, canvas-snapshot) and bin/page claim.
//   canvas-cmd.ts snippet <root> <scout|ship> [--kind <k>]                   the "## Your canvas" brief section (stdout)
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
import { inlineImages } from "./canvas-images.ts";

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
  <Bluf>Starting: <one-line goal in plain words>.</Bluf>
  <Steps title="Plan">  (replace these with your real 3-6 step plan within your first few minutes)
    <Step id="understand" state="active">Understand the brief</Step>
    <Step id="implement" state="pending">Implement</Step>
    <Step id="test" state="pending">Test</Step>
    <Step id="ship" state="pending">Commit and report</Step>
  </Steps>
  <Markdown id="findings">What you know so far, current only (rewrite it, do not append).</Markdown>
  <Collapse id="done" title="Done so far">one line per finished thing</Collapse>
</Canvas>
Add <Diff file="path">…</Diff> inside a closed <Collapse> once you have a change worth showing. To ask the captain, switch to the asking shape below.`,
  scout: `<Canvas title="<what you are finding out>" status="working">
  <Bluf>Starting: <one-line goal in plain words>.</Bluf>
  <Steps title="Plan">
    <Step id="read" state="active">Read</Step>
    <Step id="analyse" state="pending">Analyse</Step>
    <Step id="report" state="pending">Write up findings and recommendation</Step>
  </Steps>
  <Markdown id="findings">Findings so far: the answer, the evidence behind it, the recommendation and what you did not verify. Current only.</Markdown>
  <Collapse id="done" title="Done so far">one line per finished thing</Collapse>
</Canvas>
Keep <Markdown id="findings"> current as you learn things (patch its text, never append below it); finish with the complete findings, evidence, recommendation and a "Not verified" list on the canvas itself: it is your only deliverable, so never a path to a report file or any other file in its place. To ask the captain, switch to the asking shape below.`,
};

// What a canvas looks like the moment it asks the captain something or finishes. The section ids are what agent-canvas checks
// (strict crews), and what `bin/fleet ask-template` mirrors for a task ask; keep the two in step.
export const ASK_SHAPE = `<Canvas title="<the issue in a few words>" status="waiting">
  <Bluf>The outcome in one or two plain sentences, then the one decision you need from the captain.</Bluf>
  <Markdown id="recap">**You asked:** the captain's latest request, in their terms (1-2 lines)

**I did:** what you did about it (1-2 lines; 500 characters in all)</Markdown>
  <Markdown id="issue">## Issue
What is wrong or undecided, in 2-4 plain lines.</Markdown>
  <Markdown id="impact">## Impact
Who or what is affected and what it costs if nothing is done.</Markdown>
  <Markdown id="context">## Context and components
The parts involved and how they relate, a short list. Name components, not files.</Markdown>
  <Markdown id="changes">## Changes by component
One line per component: what changes in behaviour. No code, no diffs.</Markdown>
  <Markdown id="fix">## Fix plan
3-6 numbered steps, in order, each with its cost or risk when it has one.</Markdown>
  <Ask id="q1" question="<the decision, one line>" blocking><Option value="a">Recommended: …</Option><Option value="b">…</Option></Ask>
  <Collapse id="done" title="Done so far">one line per finished thing; the Steps list, Ruled out, evidence and any Diff go in closed folds like this</Collapse>
</Canvas>`;

/** The canvas kinds (label canvas.kind). Only `issue` keeps the strict needs-you structure; the rest are free-form. An unlabelled crew is an issue crew. */
export const KINDS = ["issue", "plan", "research", "explainer", "review"];

/** One extra writing line per free-form kind, only where it earns its place. */
const KIND_HINT: Record<string, string> = {
  plan: "- **For a plan:** the steps and who does what, as a short flow or table, with the recommendation first.\n",
  research: "- **For research:** the finding first, then a table of the evidence with sources; keep the full notes folded.\n",
  explainer: "- **For an explainer:** one picture of the mechanism before any prose about it.\n",
  review: "- **For a review:** the verdict and the few things that must change first; the rest of the findings in a table or fold.\n",
};

/** The brief text for a free-form canvas (any kind but issue): the same recipe and starting canvas, no required structure. */
function freeSnippet(recipe: string, shape: string, kind: string): string {
  return `## Your canvas

${recipe}

### What your canvas must say

This is a free-form ${kind} canvas: lay it out the way a good Lavish page would be. There are no required sections, no fixed order and no block count; figures, tables, sections and long prose may sit above an \`<Ask>\`. The captain still reads it *instead of* your chat, often days later, in under 30 seconds, so write for that reader: outcomes, decisions, status and what they must do, in plain language.

1. **BLUF first, always current.** One or two plain sentences: the outcome, then the one thing the captain must know or do.
2. **Replace the template plan** within your first few minutes with the real plan, named by outcome, or drop the Steps if they do not tell a story.
3. **Rewrite, never append.** Give sections an \`id\` and patch their text instead of adding a log at the bottom.
4. **Pick the visual before writing prose.** Numbers or pass/fail: \`<Metric>\` in a \`<Grid>\`. How parts fit or before/after: \`<Svg>\`. A trend: \`<Chart>\`. Tables and prose in \`<Markdown>\`.
5. **Recap, please.** Keep a top-level \`<Markdown id="recap">\` right after the BLUF with \`**You asked:** …\` (the brief's intent, or the captain's newest steer) and \`**I did:** …\`, at most 500 characters in all: the deck lifts it into the strip at the top of your card. Nothing refuses a canvas without it, but the card is blank without it.
6. **Final** (\`status="done"\`): rewrite it top to bottom so it reads as a summary of the outcome, with the PR link if there is one.

### Writing it well

- **No walls of text.** If a paragraph runs past four lines, split it, turn it into a list or table, or draw it.
- **Plain, concise words.** Short sentences, no jargon the captain would have to look up. Say it once.
- **Lead with the answer.** The first thing on screen is the conclusion or the recommendation; the how and why come after.
- **Show, don't tell.** Use a \`<Svg>\` for how parts fit, a table to compare options, \`<Metric>\` for numbers, \`<Chart>\` for a trend.
- **Fold the detail.** Evidence, long lists and raw output go in a closed \`<Collapse>\`, not in the main flow.
${KIND_HINT[kind] ?? ""}
### Set your canvas first

Your very first action, before reading anything else: \`set\` a canvas shaped like this, then patch it as each step moves. If a canvas from an earlier task is already there, replace it.

\`\`\`
${SHAPE[shape]}
\`\`\`

### Questions for the captain

A question for the captain goes on your canvas as \`<Ask id=… question=… blocking>\` with \`<Option>\`s, never only in chat. Put the recommended option first. Keep the rest of the canvas as it is: nothing about its layout is checked. Then end your turn with \`BLOCKED: canvas ask <id>\` and nothing else on that line. The answer arrives as your next message.
`;
}

export function snippet(root: string, shape: string, kind = "issue"): string {
  if (!SHAPE[shape]) die("usage: bin/page canvas-snippet <scout|ship> [--kind <issue|plan|research|explainer|review>]");
  if (!KINDS.includes(kind)) die(`unknown canvas kind '${kind}' (one of ${KINDS.join(", ")})`);
  const dir = canvasDir(root);
  if (!dir) die("canvasDir is not set: put the agent-canvas checkout in the firstmate-deck settings (canvasDir) or AGENT_CANVAS_DIR, and let the plugin render once");
  const port = Number(new URL(baseUrl(root)).port) || 6790;
  let recipe: string;
  try { recipe = execFileSync("node", [join(dir, "server", "brief-snippet.ts"), String(port), kind], { encoding: "utf8", timeout: 20_000, env: { ...process.env, NODE_NO_WARNINGS: "1" } }).trimEnd(); }
  catch (e) { die(`could not run ${dir}/server/brief-snippet.ts: ${(e as Error).message.split("\n")[0]}`); }
  if (kind !== "issue") return freeSnippet(recipe, shape, kind);
  return `## Your canvas

${recipe}

### What your canvas must say

The captain reads your canvas *instead of* your chat, often days later, in under 30 seconds. Write for that reader: outcomes, decisions, status and what they must do, in plain language.

1. **BLUF first, always current.** One or two plain sentences: the outcome, then the one thing the captain must know or do. No tool names, file paths, function names, hashes or narration.
   - Bad: \`Running colmena build; patched web/vite.config.ts at 3f2a1c.\`
   - Good: \`The bot is deployed to skylake and all 4 services are healthy. One config fix is needed and is not committed yet.\`
   - While running: \`Found why the web build fails (it skips the shared types); fixing now, about 2 steps left.\`
2. **Replace the template plan.** Within your first few minutes, rewrite the Steps with the real plan: 3-6 steps named by outcome ("Web build includes shared types"), not by activity or file.
3. **Rewrite, never append.** Each section of the canvas has an \`id\`; to change what it says, patch that id's text. Do not append a new block at the bottom or top of the canvas: that turns it into a log. When something is superseded, \`remove\` it or rewrite it. A finished item becomes one line in the "Done so far" fold; a dead end becomes one line there under "Ruled out" (what you tried, why it failed) or vanishes. The canvas shows the current truth, not a history.
4. **Pick the visual before writing prose.** Numbers or pass/fail: \`<Metric>\` in a \`<Grid>\`. A choice you made: \`<Decision>\`. How parts fit or before/after: \`<Svg>\` (a big graph: \`<Diagram>\`). A trend: \`<Chart>\`. \`<Markdown>\` is for the few sentences no component can carry; anything over about 5 lines or 6 items goes in a \`<Collapse>\`.
5. **Code detail only when it passes the audience test.** Show file paths, function names, diffs, line numbers, hashes or command output only if (a) the task is about the code itself (a code review, an API or design audit, a "which file / what changed exactly" question), or (b) the brief or the captain asked for those specifics. Even then it goes inside a closed \`<Collapse>\` (a key \`<Diff>\` hunk, not whole files), never in the BLUF, Steps or Metrics. Otherwise describe what changed in behaviour.
6. **Running vs asking vs final.** Running (\`status="working"\`): the BLUF, live Steps, what is in progress or blocking. Asking (\`status="waiting"\`, see "Questions for the captain"): the seven-part shape, in that order. Final (\`status="done"\`): rewrite it top to bottom: the BLUF, the recap, what changed in plain words, verification as Metrics, a short "Not verified" list and a short "Needs you" list (omit either when empty), one figure where it helps, and the PR link if there is one. Drop the Steps list unless it tells a story.
7. **Recap block, required.** On every canvas that asks the captain something or is final (\`status="done"\`), put a top-level \`<Markdown id="recap">\` right after the BLUF: \`**You asked:** …\` (the captain's latest request, in their terms: the brief's intent, or their newest steer) and \`**I did:** …\` (what you did about it), at most 500 characters in all. The deck lifts it out of the canvas into a strip at the top of your card, so the captain sees it before anything else. Rewrite it in place whenever a new steer arrives or you finish; agent-canvas refuses a strict crew's asking or done canvas without it.
8. **Your canvas is the only deliverable, and it is self-contained.** The captain gets no other write-up of your work and opens no files: the first mate adds only the question, the buttons and a short note beside your canvas. Put what they must decide, the full findings, the evidence, the recommendation, a "Not verified" list, the links and the outcome on the canvas itself. Do not write a report.md. A canvas that names report.md or a local file path outside a closed Collapse is refused when it asks or is done.
9. **Length test.** If the captain would have to scroll, or read code, to learn the outcome, cut until they don't.

### Set your canvas first

Your very first action, before reading anything else: \`set\` a canvas shaped like this, then patch it as each step moves. If a canvas from an earlier task is already there, replace it.

\`\`\`
${SHAPE[shape]}
\`\`\`

### Questions for the captain

A question for the captain goes on your canvas as \`<Ask id=… question=… blocking>\` with \`<Option>\`s, never only in chat. Before you add it, **rewrite the canvas into this order, top to bottom**: BLUF → recap → issue → impact → context and components → changes by component (behaviour, no code) → fix plan → the Ask, then only closed folds (Done so far, evidence). Use these section ids: \`recap\`, \`issue\`, \`impact\`, \`context\`, \`changes\`, \`fix\`. Move the Steps list and any code into a closed fold. Keep each section short: the captain reads the whole canvas open, in about 30 seconds.

\`\`\`
${ASK_SHAPE}
\`\`\`

If the write is refused, the error names what is missing or out of order: fix exactly that and write again. Put the recommended option first. Then end your turn with \`BLOCKED: canvas ask <id>\` and nothing else on that line. If the canvas has no such open question, you are sent back once with the error; the captain is not asked. The answer arrives as your next message.
`;
}

// ---------- agents ----------

/** The task's current agent (newest live one, else the newest archived), or --agent. */
async function agentOf(root: string, task: string, override?: string): Promise<string> {
  if (override) return override;
  const mine = (await labelledAgents(root, [task])).filter((r) => r.task === task);
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
  const agentId = await agentOf(root, task, override);
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
  const agentId = await agentOf(root, task, override);
  const base = baseUrl(root);
  const enc = encodeURIComponent(agentId);
  let card = await getText(`${base}/api/fm/card/${enc}`).catch(() => null);
  if (card && !card.ok) card = await getText(`${base}/api/fm/card/${enc}?archived=1`).catch(() => null);
  if (!card || !card.ok) die(`agent-canvas has no canvas for agent ${agentId} (is it running at ${base}?)`);
  card = { ...card, text: await inlineImages(card.text, async (h) => {
    const r = await fetch(`${base}/asset/${h}`, { signal: timeout(8000) });
    return r.ok ? { mime: r.headers.get("content-type") ?? "", bytes: new Uint8Array(await r.arrayBuffer()) } : null;
  }) };
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
async function relabel(root: string, newId: string, project?: string): Promise<void> {
  // the checkout-wide first mate (no project) re-points only the crews of pages that have no claim of their own
  const tasks = loadAllLive(root).filter((t) => (project ? t.project === project : !t.project || !projectClaimedId(root, t.project)) && t.state !== "done" && t.state !== "failed");
  if (!tasks.length) return;
  const recs = await labelledAgents(root, tasks.map((t) => t.id));
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
  case "snippet": { const kind = takeFlag(rest, "--kind"); process.stdout.write(snippet(root, rest[0] ?? "", kind ?? "issue")); break; }
  case "answer": await answer(root, rest); break;
  case "snapshot": await snapshot(root, rest); break;
  case "relabel": if (!rest[0]) die("relabel needs the new first mate's agent id"); await relabel(root, rest[0], rest[1]); break;
  default: die(`unknown command '${cmd}'`);
}
