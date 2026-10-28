// bin/fleet stage(s) go through stage-cli.ts: the same stage engine as the page, now reading the crew's canvases too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeCanvas, summary } from "./fake-canvas.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "stage-cli.ts");
const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  const p = spawn("node", [cli, ...args], { env: { ...process.env, ...env } });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => resolve({ code, out, err }));
});

function rig() {
  const root = mkdtempSync(join(tmpdir(), "deck-cli-"));
  mkdirSync(join(root, "state", "projects", "demo"), { recursive: true });
  writeFileSync(join(root, "state", "projects", "demo", "project.json"), "{}");
  const ask = { id: "a1", text: "BLUF: pick", options: ["pg", "sqlite"], since: "2026-10-24T11:00:00Z", ref: { kind: "canvas", agentId: "ag-1", block: "db" } };
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: [
    { id: "t-run", intent: "x", state: "active", since: "2026-10-24T09:00:00Z", project: "demo" },
    { id: "t-ref", intent: "y", state: "active", since: "2026-10-24T09:00:00Z", project: "demo", asks: [ask] },
  ] }));
  const agents = join(root, "agents.json");
  const rec = (id: string, task: string) => ({ id, task, status: "running", archived: false, createdAt: "2026-10-24T10:00:00Z", lastActivityAt: new Date().toISOString(), pending: 0 });
  writeFileSync(agents, JSON.stringify([rec("ag-1", "t-run"), rec("ag-2", "t-ref")]));
  return { root, agents };
}

test("stages: the canvas verdict and BLUF ride on the row, a canvas ask is a question, a resolved curated ask is ref-closed", async () => {
  const fc = await new FakeCanvas().start();
  fc.set(summary("ag-1", { bluf: "Wiring the routes", openAsks: [{ id: "db", question: "q", blocking: true, options: [{ value: "a", label: "a" }, { value: "b", label: "b" }] }] }));
  fc.set(summary("ag-2")); // its canvas ask "db" is gone
  const r = rig();
  const env = { PASEO_HOME: r.root, STAGE_AGENTS_JSON: r.agents, AGENT_CANVAS_URL: fc.url };
  const rows = JSON.parse((await run(["stages", r.root], env)).out);
  const by = Object.fromEntries(rows.map((x: any) => [x.id, x]));
  assert.equal(by["t-run"].stage, "Running · 1 question");
  assert.deepEqual(by["t-run"].canvas, { verdict: "Working", bluf: "Wiring the routes", asks: 1 });
  // T3: its crew is still running, so the card is Running (not With the first mate) and carries the drift flag
  assert.deepEqual([by["t-ref"].stage, by["t-ref"].flags.map((f: any) => f.key)], ["Running", ["ref-closed"]]);
  const table = (await run(["stages", r.root, "--table"], env)).out;
  assert.match(table, /canvas · Working · Wiring the routes/);
  assert.equal((await run(["drift", r.root], env)).out.trim(), "1", "ref-closed is drift: the first mate must run bin/fleet answer");
  await fc.stop();
});

test("stages: no canvas, an unreachable canvas, or 'off' leave the rows as before", async () => {
  const r = rig();
  const base = { PASEO_HOME: r.root, STAGE_AGENTS_JSON: r.agents };
  for (const url of ["http://127.0.0.1:1", "off", ""]) {
    const res = await run(["stages", r.root], { ...base, AGENT_CANVAS_URL: url });
    assert.equal(res.code, 0, url);
    const rows = JSON.parse(res.out);
    assert.deepEqual(rows.map((x: any) => x.stage), ["Running", "Needs you"], url);
    assert.ok(rows.every((x: any) => !x.canvas));
  }
});

test("stages: the URL the deck stamped into page.json is used when the environment has none", async () => {
  const fc = await new FakeCanvas().start();
  fc.set(summary("ag-1", { bluf: "From the stamp" }));
  const r = rig();
  writeFileSync(join(r.root, "state", "projects", "demo", "page.json"), JSON.stringify({ canvasUrl: fc.url }));
  const res = await run(["stages", r.root], { PASEO_HOME: r.root, STAGE_AGENTS_JSON: r.agents, AGENT_CANVAS_URL: "" });
  assert.equal(JSON.parse(res.out).find((x: any) => x.id === "t-run").canvas.bluf, "From the stamp");
  await fc.stop();
});
