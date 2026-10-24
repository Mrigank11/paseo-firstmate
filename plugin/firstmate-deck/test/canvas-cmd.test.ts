// bin/page canvas-snippet / canvas-answer / canvas-snapshot and the claim re-label list, through canvas-cmd.ts against a fake agent-canvas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "canvas-cmd.ts");
const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  const p = spawn("node", [cli, ...args], { env: { ...process.env, NODE_NO_WARNINGS: "1", ...env } });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => resolve({ code, out, err }));
});

const KEY = "k".repeat(40);

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "deck-cc-"));
  mkdirSync(join(root, "state", "projects", "demo"), { recursive: true });
  writeFileSync(join(root, "state", "projects", "demo", "project.json"), "{}");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: [
    { id: "t-one", intent: "x", state: "active", since: "2026-10-24T09:00:00Z", project: "demo" },
    { id: "t-two", intent: "y", state: "active", since: "2026-10-24T09:00:00Z", project: "demo" },
  ] }));
  const rec = (id: string, task: string, labels: Record<string, string>, over = {}) => ({ id, task, status: "running", archived: false, createdAt: "2026-10-24T10:00:00Z", lastActivityAt: null, pending: 0, labels, ...over });
  const agents = join(root, "agents.json");
  writeFileSync(agents, JSON.stringify([rec("ag-1", "t-one", { "canvas.relay": "fm-old" }), rec("ag-2", "t-two", { "canvas.relay": "fm-new" }), rec("ag-0", "t-one", { "canvas.relay": "fm-old" }, { archived: true })]));
  const keyFile = join(root, "relay.key");
  writeFileSync(keyFile, `${KEY}\n`);
  const hits: { path: string; key?: string; body?: any }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      hits.push({ path: u.pathname + u.search, key: req.headers["x-canvas-key"] as string | undefined, body: raw ? JSON.parse(raw) : undefined });
      const send = (code: number, type: string, body: string) => { res.writeHead(code, { "content-type": type }); res.end(body); };
      if (u.pathname === "/api/fm/deliver") return req.headers["x-canvas-key"] === KEY ? send(200, "application/json", JSON.stringify({ ok: true })) : send(403, "application/json", JSON.stringify({ ok: false, error: "wrong key" }));
      if (u.pathname === "/api/fm/css") return send(200, "text/css", ".acv .blk{color:red}");
      if (u.pathname === "/api/fm/card/ag-1") return send(200, "text/html", `<div class="blk">CANVAS ag-1</div>`);
      if (u.pathname === "/api/canvas/ag-1") return send(200, "text/plain", `<Canvas title="x" status="done"><Bluf>shipped</Bluf></Canvas>`);
      send(404, "text/plain", "no");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { STAGE_AGENTS_JSON: agents, AGENT_CANVAS_URL: url, AGENT_CANVAS_KEY_FILE: keyFile };
  return { root, env, hits, keyFile, stop: () => { server.closeAllConnections?.(); server.close(); } };
}

test("canvas-snippet: the agent-canvas recipe for the configured port, the shape's starting canvas, the ask contract", async () => {
  const r = await rig();
  const dir = join(r.root, "canvas"); // a stand-in agent-canvas checkout: only server/brief-snippet.ts is read
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "server", "brief-snippet.ts"), `console.log("RECIPE port " + process.argv[2]);`);
  const env = { ...r.env, AGENT_CANVAS_DIR: dir, AGENT_CANVAS_URL: "http://127.0.0.1:6791" };
  const ship = await run(["snippet", r.root, "ship"], env);
  assert.equal(ship.code, 0, ship.err);
  assert.match(ship.out, /^## Your canvas\n/);
  assert.match(ship.out, /RECIPE port 6791/);
  assert.match(ship.out, /<Step id="implement"/);
  assert.match(ship.out, /BLOCKED: canvas ask <id>/);
  const scout = await run(["snippet", r.root, "scout"], env);
  assert.match(scout.out, /<Markdown id="findings">/);
  assert.doesNotMatch(scout.out, /id="implement"/);
  assert.notEqual((await run(["snippet", r.root, "chore"], env)).code, 0, "an unknown shape is refused");
  assert.notEqual((await run(["snippet", r.root, "ship"], { ...r.env, AGENT_CANVAS_DIR: "" })).code, 0, "no canvasDir: say so");
  r.stop();
});

test("canvas-answer: delivers with the relay key to the task's current agent; --decline carries the reason; a wrong key is reported", async () => {
  const r = await rig();
  const ok = await run(["answer", r.root, "t-one", "c-db", "pg"], r.env);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /delivered: t-one \(agent ag-1\) ask db = pg/);
  assert.deepEqual(r.hits.find((h) => h.path === "/api/fm/deliver")?.body, { agentId: "ag-1", askId: "db", value: "pg" });
  const no = await run(["answer", r.root, "t-one", "db", "--decline", "out of scope"], r.env);
  assert.match(no.out, /declined: .*out of scope/);
  assert.deepEqual(r.hits.filter((h) => h.path === "/api/fm/deliver").at(-1)?.body, { agentId: "ag-1", askId: "db", decline: "out of scope" });
  writeFileSync(r.keyFile, "w".repeat(40));
  const bad = await run(["answer", r.root, "t-one", "db", "pg"], r.env);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /wrong key/);
  assert.notEqual((await run(["answer", r.root, "t-one", "db"], r.env)).code, 0, "a value or --decline is required");
  r.stop();
});

test("canvas-snapshot: writes the final canvas (standalone html + source) into the task's folder", async () => {
  const r = await rig();
  const out = await run(["snapshot", r.root, "t-one"], r.env);
  assert.equal(out.code, 0, out.err);
  const html = readFileSync(join(r.root, "state", "tasks", "t-one", "canvas.final.html"), "utf8");
  assert.match(html, /CANVAS ag-1/);
  assert.match(html, /\.acv \.blk\{color:red\}/);
  assert.match(readFileSync(join(r.root, "state", "tasks", "t-one", "canvas.final.tsx"), "utf8"), /<Bluf>shipped<\/Bluf>/);
  const none = await run(["snapshot", r.root, "t-two"], r.env);
  assert.notEqual(none.code, 0, "agent-canvas has no canvas for ag-2");
  assert.ok(!existsSync(join(r.root, "state", "tasks", "t-two", "canvas.final.html")));
  r.stop();
});

test("relabel: only live crews whose canvas.relay names another agent, per project", async () => {
  const r = await rig();
  const out = await run(["relabel", r.root, "fm-new", "demo"], r.env);
  assert.equal(out.out.trim(), "ag-1", "ag-2 already relays to fm-new; the archived ag-0 is not touched");
  assert.equal((await run(["relabel", r.root, "fm-old", "demo"], r.env)).out.trim(), "ag-2");
  r.stop();
});
