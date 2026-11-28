// Page gate, server side: the deck code of THIS checkout over a copy of the LH project data, a fake agent-canvas carrying
// the crews' real saved canvases, fake crews that change every 1-3 s, served by a scratch Lavish 0.1.95 (the live version)
// on its own port and state dir. Never touches the live Paseo, Lavish (4387, ~/.lavish-axi) or the first mate's state.
// Churn is switched by the file <dir>/churn-<run>, so the gate can idle the page and restart this process (KEEP=1) to look like a
// plugin restart without losing the Lavish session: "off", "on" (a running crew writes to its canvas) or "mixed" (also asks
// opening and closing, agents stopping, tasks parked and brought back, new comments: cards move between groups and counts change).
// <dir>/poke-<run> names one task that is never moved and gets a canvas write on every second tick (the card a gate has selected).
// <dir>/canvas-<run> containing "down" makes the fake agent-canvas answer 503.
// PG_SERVER runs another checkout's server directory (to see a gate fail on an older build).
// usage: PG_DIR=<scratch dir> node serve.ts   (env: PG_RUN name of this copy, PG_LPORT, PG_MPORT, PG_CPORT, KEEP)
import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, rmSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.PG_SERVER ?? join(here, "..", "..", "server");
const TEST = join(here, "..");
const DIR = process.env.PG_DIR ?? "/home/mrigank/projects/llm-exp/paseo-firstmate/.isolated/deck-page-firstprinciples-build";
const LPORT = process.env.PG_LPORT ?? "4521", MPORT = +(process.env.PG_MPORT ?? 4522), CPORT = +(process.env.PG_CPORT ?? 4523);
const LAV = "/home/mrigank/projects/.lavish-axi-deck-bin/node_modules/lavish-axi/dist/cli.mjs"; // 0.1.95, same as live
const RUN = process.env.PG_RUN ?? "demo";
const root = join(DIR, `root-${RUN}`), lavDir = join(DIR, `lavish-${RUN}`), churnFile = join(DIR, `churn-${RUN}`), urlFile = join(DIR, `url-${RUN}.txt`);
const pokeFile = join(DIR, `poke-${RUN}`), canvasFile = join(DIR, `canvas-${RUN}`);
const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim() : "");
if (["4387", "4389"].includes(LPORT) || DIR.includes(".lavish-axi")) throw new Error("the gate never runs on the live Lavish");
process.env.TZ = "Asia/Kolkata"; process.env.FM_DECK_POLL_MODE = "http";
Object.assign(process.env, { LAVISH_AXI_PORT: LPORT, LAVISH_AXI_STATE_DIR: lavDir, LAVISH_AXI_IDLE_TIMEOUT_MS: "off", LAVISH_AXI_NO_OPEN: "1", LAVISH_AXI_TELEMETRY: "0" });
const t0 = Date.now(); const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ((Date.now() - t0) / 1000).toFixed(1).padStart(7), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!process.env.KEEP) { rmSync(root, { recursive: true, force: true }); cpSync(join(DIR, "data"), root, { recursive: true }); writeFileSync(churnFile, "on"); for (const f of [pokeFile, canvasFile]) rmSync(f, { force: true }); }
const pj = join(root, "state/projects/longitudehealth/project.json");
const proj = JSON.parse(readFileSync(pj, "utf8")); proj.page = join(root, "lh-project-page.html"); writeFileSync(pj, JSON.stringify(proj, null, 2));

const { Deck } = await import(join(SERVER, "runtime.ts"));
const { FakeWorld, fakePaseo, shell } = await import(join(TEST, "fake-paseo.ts"));
const { CliPort } = await import(join(SERVER, "paseo-cli.ts"));
const { PortSelector } = await import(join(SERVER, "paseo-port.ts"));

// crews: one running agent per active LH task
const fleet = JSON.parse(readFileSync(join(root, "state/fleet.json"), "utf8"));
const active: string[] = Object.values<any>(fleet.tasks ?? fleet).filter((t) => t && t.project === "longitudehealth" && t.state === "active").map((t) => t.id);
const world = new FakeWorld();
for (const id of active) world.add({ id: "ag-" + id, status: "running", labels: { "fm.task": id, "fm.project": "longitudehealth" }, createdAt: "2026-11-26T08:00:00Z", updatedAt: "2026-11-26T10:05:00Z", model: "claude-sonnet-5-5", items: Array.from({ length: 6 }, (_, k) => shell(`make step-${k}`)) });
world.add({ id: "fm-1", status: "idle", labels: { firstmate: "true" } });

// fake agent-canvas: the crews' real saved canvases (or a done task's as filler) and the real canvas stylesheet
const css = readFileSync(join(DIR, "canvas.css"), "utf8");
const bodyOf = (f: string) => { const h = readFileSync(f, "utf8"); const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(h); return m ? m[1] : h; };
const fillers = readdirSync(join(root, "state/tasks")).map((d) => join(root, "state/tasks", d, "canvas.final.html")).filter(existsSync).slice(0, 40);
const cards = new Map<string, { rev: number; html: string; title: string; ask?: boolean }>();
active.forEach((id, i) => { const f = join(root, "state/tasks", id, "canvas.final.html"); cards.set("ag-" + id, { rev: 1, title: id, html: bodyOf(existsSync(f) ? f : fillers[i % fillers.length]) }); });
const summary = (agentId: string) => { const c = cards.get(agentId)!; return { agentId, rev: c.rev, archived: false, title: c.title, verdict: { label: c.ask ? "Needs you" : "Working", flags: [], needsYou: !!c.ask }, bluf: `Working on ${c.title}, rev ${c.rev}`, recap: null, steps: { done: c.rev % 4, total: 4, current: "implement" }, openAsks: c.ask ? [{ id: "gq", question: "Gate question?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], blocking: true }] : [], updatedAt: 1795700000000 + c.rev, runState: "running", url: `http://canvas.test/a/${agentId}`, agentUrl: null, auto: false }; };
createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (read(canvasFile) === "down") { res.writeHead(503); return void res.end("down"); }
  if (u.pathname === "/api/fm/css") { res.writeHead(200, { "content-type": "text/css" }); return void res.end(css); }
  if (u.pathname === "/api/fm/summary") { const ids = (u.searchParams.get("agents") ?? "").split(",").filter(Boolean); res.writeHead(200, { "content-type": "application/json" }); return void res.end(JSON.stringify({ agents: ids.filter((i) => cards.has(i)).map(summary), missing: ids.filter((i) => !cards.has(i)) })); }
  const m = /^\/api\/fm\/card\/([\w-]+)$/.exec(u.pathname);
  if (m && cards.has(m[1])) { const c = cards.get(m[1])!; res.writeHead(200, { "content-type": "text/html" }); return void res.end(c.html + `<p class="demo-rev">demo rev ${c.rev}</p>`); }
  res.writeHead(404); res.end("no");
}).listen(CPORT, "127.0.0.1");

const exec = async (args: string[]) => {
  if (args[0] === "status") return JSON.stringify({ listen: "127.0.0.1:1", serverId: "srv" });
  if (args[0] === "ls") return JSON.stringify([...world.agents.values()].map((a: any) => ({ id: a.id, status: a.status })));
  if (args[0] === "inspect") return JSON.stringify({ CreatedAt: "2026-11-26T08:00:00Z" });
  return "";
};
const ports = new PortSelector(new CliPort(exec)); ports.capture({ paseo: fakePaseo(world) }, "demo");
const deck = new Deck({ exec, ports, batchMs: 30, readConfig: async () => ({ root, firstmateLabel: "firstmate=true", lavishPort: LPORT, lavishStateDir: lavDir, lavishBin: LAV, readMarksPort: MPORT, canvasUrl: `http://127.0.0.1:${CPORT}` }), log: (m: string) => log("[deck]", m) } as any);
await deck.configure();
await deck.start?.();
await deck.render("longitudehealth");
await sleep(8000); // canvases arrive
await deck.render("longitudehealth");

// the scratch Lavish session (it binds loopback and the tailnet)
const out = spawnSync("node", [LAV, proj.page], { env: process.env, encoding: "utf8" }).stdout;
const url = /url: "([^"]+)"/.exec(out)?.[1] ?? out.slice(0, 300);
writeFileSync(urlFile, url.replace("127.0.0.1", "manjaro.tail2e75.ts.net").replace("localhost", "manjaro.tail2e75.ts.net") + "\n");
log("URL", url);

let n = 0;
const rand = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const write = (id: string) => { const a = world.agents.get("ag-" + id) as any; a.updatedAt = new Date().toISOString(); a.items.push(shell(`make step-${n}`)); cards.get("ag-" + id)!.rev++; deck.onAgentEvent(a.id); };
const fleetFile = join(root, "state/fleet.json");
const parked = new Set<string>();
const park = (id: string) => {
  const f = JSON.parse(readFileSync(fleetFile, "utf8")), t = Object.values<any>(f.tasks ?? f).find((x) => x?.id === id);
  if (!t) return;
  if (parked.delete(id)) t.state = "active"; else { parked.add(id); t.state = "parked"; }
  writeFileSync(fleetFile + ".tmp", JSON.stringify(f, null, 2)); renameSync(fleetFile + ".tmp", fleetFile);
};
const comment = (id: string) => appendFileSync(join(root, "state/projects/longitudehealth/inbox.jsonl"), JSON.stringify({ id: `c-churn-${Date.now().toString(36)}-${n}`, at: new Date().toISOString(), project: "longitudehealth", prompt: { uid: String(9000 + n), prompt: `churn comment ${n}`, selector: `article#t-${id}`, tag: "article", text: "x" }, delivered: true, answered: false, target: `t-${id}`, text: `churn comment ${n}` }) + "\n");
for (;;) {
  await sleep(1000 + Math.random() * 2000);
  const mode = read(churnFile) || "on", poke = read(pokeFile);
  if (poke && cards.has("ag-" + poke) && (mode !== "off") && n % 2 === 0) write(poke);
  if (mode === "off") continue;
  const others = active.filter((x) => x !== poke), id = rand(others), r = Math.random();
  if (mode === "poke") { /* only the poked card changes */ }
  else if (mode !== "mixed" || r < 0.35) write(id);
  else if (r < 0.55) { const c = cards.get("ag-" + id)!; c.ask = !c.ask; write(id); }
  else if (r < 0.7) { const a = world.agents.get("ag-" + id) as any; a.status = a.status === "running" ? "idle" : "running"; write(id); }
  else if (r < 0.85) park(id);
  else comment(id);
  n++;
  if (n % 50 === 0) log("crew changes", n);
}
