process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../server/state.ts";
import { renderProject, canvasFragment } from "../server/render.ts";
import { extractTarget } from "../server/target.ts";
import { formatMessage, newEntries, parseChoice, parseTarget } from "../server/relay.ts";
import { summary } from "./fake-canvas.ts";
import type { CanvasData } from "../server/canvas-port.ts";

const NOW = new Date("2026-10-24T12:00:00Z");
const opts = { now: NOW, paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 20 };
const agent = { status: "running" as const, stepCount: 3, recent: ["ran npm test"], createdAt: "2026-10-24T11:00:00Z", updatedAt: "2026-10-24T11:59:00Z" };

function project(tasks: object[], inbox: object[] = []) {
  const root = mkdtempSync(join(tmpdir(), "deck-cv-"));
  const pdir = join(root, "state", "projects", "demo");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo", sections: [] }));
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks }));
  if (inbox.length) writeFileSync(join(pdir, "inbox.jsonl"), inbox.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return loadProject(root, "demo");
}
const T = { id: "t1", intent: "build the api", title: "Build the API", state: "active", since: "2026-10-24T10:00:00Z", project: "demo", shape: "ship" };
const labeled = { t1: [{ id: "ag-1", status: "running", archived: false, createdAt: "2026-10-24T11:00:00Z" }] };
const data = (over: Partial<CanvasData> = {}, s = summary("ag-1")): CanvasData => ({ status: "ok", css: ".acv .blk{color:red}", summaries: { "ag-1": s }, cards: { "ag-1": `<div class="blk">FULL</div>` }, ...over });
const render = (m: ReturnType<typeof project>, canvas?: CanvasData, ags: Record<string, any> = { "ag-1": agent }, lab: any = labeled) => renderProject(m, ags, { ...opts, labeled: lab, canvas });
const card = (live: string, id = "t1") => { const i = live.indexOf(`id="t-${id}"`); return live.slice(i, live.indexOf("</article>", i)); };

test("the card pulls in the canvas: verdict, BLUF, steps strip with the Now row, and the two links", () => {
  const html = card(render(project([T]), data()).live);
  assert.match(html, /class="cv-v cv-mut">Working</);
  assert.match(html, /class="cv-bluf">Building the API</);
  assert.match(html, /1\/4 steps/);
  assert.match(html, /<b>Now<\/b> implement/);
  assert.equal((html.match(/<i class="on">/g) ?? []).length, 1);
  assert.match(html, /<a class="cv-open" href="http:\/\/canvas\.test\/a\/ag-1">Open canvas ↗<\/a><a class="open" href="http:\/\/paseo\.test\/agent\/ag-1">Open in Paseo<\/a>/);
  assert.ok(html.indexOf('class="ag"') < html.indexOf('class="cv has-full"') && html.indexOf('class="cv has-full"') < html.indexOf("cv-links"));
  // the canvas's steps replace the recent-steps block, and there is no iframe
  assert.ok(!html.includes("stp") && !html.includes("<iframe"));
});

test("the full embed card rides along for the focus view only, and its stylesheet is inlined once in the page head", () => {
  const r = render(project([T]), data());
  const html = card(r.live);
  assert.match(html, /<div class="cv-f acv"><div class="blk">FULL<\/div><\/div>/);
  assert.equal(r.page.split(".acv .blk{color:red}").length - 1, 1);
  assert.ok(r.page.indexOf(".acv .blk") < r.page.indexOf("<body>"));
  assert.match(r.page, /body\.tn-focus \.task\.tn-sel \.cv\.has-full \.cv-f\{display:block\}/);
  assert.ok(!r.live.includes(".acv .blk{color:red}"), "css is page-level, not per card");
});

test("a canvas that moved changes live, and the css change moves the page signature", () => {
  const m = project([T]);
  const a = render(m, data()), b = render(m, data({}, summary("ag-1", { rev: 2, bluf: "Tests green" })));
  assert.notEqual(a.live, b.live);
  assert.equal(a.signature, b.signature, "card content rides in live.js, not in page.html");
  assert.notEqual(a.signature, render(m, data({ css: ".x{}" })).signature);
});

test("without a canvas the card is exactly the registry-and-Paseo card (recent steps, no fragment)", () => {
  const html = card(render(project([T])).live);
  assert.ok(html.includes("stp") && !html.includes('class="cv'));
  assert.equal(render(project([T])).live, render(project([T]), { status: "off", css: "", summaries: {}, cards: {} }).live);
});

test("canvas unreachable: a soft badge, the card falls back, nothing is blocked", () => {
  const r = render(project([T]), { status: "down", css: "", summaries: {}, cards: {} });
  assert.match(r.live, /class="fl cv-down"[^>]*>canvas unavailable</);
  assert.ok(card(r.live).includes("stp"));
  assert.ok(!render(project([T]), data()).live.includes("canvas unavailable"));
});

test("a raw canvas ask shows at once with buttons on the option-click path (target t-<task>#c-<id>)", () => {
  const s = summary("ag-1", { openAsks: [{ id: "db", question: "Postgres or SQLite?", blocking: true, options: [{ value: "pg", label: "Postgres" }, { value: "sqlite", label: "SQLite" }] }] });
  const r = render(project([T]), data({}, s));
  const html = card(r.live);
  assert.match(html, /<div class="askbox raw" id="a-t1-c-db"><div class="ask-tag">Uncurated · from the crew<\/div>/);
  assert.match(html, /Postgres or SQLite\?/);
  assert.match(html, /<button type="button" class="opt" id="o-t1-c-db-1" data-task="t1" data-ask="c-db" data-opt="pg" data-title="Build the API" aria-pressed="false">Postgres<\/button>/);
  assert.match(html, /data-key="ask-t1-c-db"/);
  // the stage: running + an open question
  assert.match(html, /class="stg">Running · 1 question</);
  assert.ok(r.live.indexOf('id="g-running"') >= 0);
  // the ask block's element id is what a Lavish comment on it resolves to
  assert.equal(extractTarget("#a-t1-c-db > .opts > button", { tasks: ["t1"] }), "t-t1#c-db");
  assert.equal(extractTarget("#x-t1-a2", { tasks: ["t1"] }), "t-t1#a2");
});

test("an idle agent with a raw ask is in Needs you", () => {
  const s = summary("ag-1", { runState: "idle", openAsks: [{ id: "db", question: "Q?", blocking: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] });
  const r = render(project([T]), data({}, s), { "ag-1": { ...agent, status: "idle" } }, { t1: [{ ...labeled.t1[0], status: "idle" }] });
  assert.ok(r.live.indexOf('id="t-t1"') > r.live.indexOf('id="g-you"') && !r.live.includes('id="g-running"'));
  assert.match(card(r.live), /class="stg">Needs you</);
});

test("a click on a raw ask moves it to 'sent to the first mate' and the stage to With the first mate", () => {
  const s = summary("ag-1", { openAsks: [{ id: "db", question: "Q?", blocking: true, options: [{ value: "pg", label: "Postgres" }, { value: "sqlite", label: "SQLite" }] }] });
  const click = { id: "c-1", at: "2026-10-24T11:59:00Z", target: "t-t1#c-db", text: "Build the API: pg", delivered: true, answered: false, choice: { task: "t1", ask: "c-db", option: "pg" } };
  const html = card(render(project([T], [click]), data({}, s)).live);
  assert.match(html, /Sent to the first mate/);
  assert.match(html, /You picked <b>pg<\/b> · the first mate is delivering it/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /class="stg">With the first mate</);
  assert.ok(!html.includes("Running · 1 question"));
});

test("a canvas-side pending pick (the captain picked in Paseo) reads the same", () => {
  const s = summary("ag-1", { openAsks: [{ id: "db", question: "Q?", blocking: false, pending: "sqlite", options: [{ value: "pg", label: "pg" }, { value: "sqlite", label: "sqlite" }] }] });
  const html = card(render(project([T]), data({}, s)).live);
  assert.match(html, /Sent to the first mate/);
  assert.match(html, /class="stg">With the first mate</);
});

test("a canvas ask without usable options or a safe id is shown read-only, pointing at the canvas", () => {
  const s = summary("ag-1", { openAsks: [{ id: "my-ask", question: "Free text?", blocking: false, options: [] }] });
  const html = card(render(project([T]), data({}, s)).live);
  assert.match(html, /Free text\?/);
  assert.match(html, /Answer this one on the canvas/);
  assert.ok(!html.includes("<button"));
});

test("a curated ask with a ref replaces the raw one; once the canvas ask is gone it says so", () => {
  const withRef = { ...T, asks: [{ id: "a1", text: "BLUF: pick a db", options: ["pg", "sqlite"], since: "2026-10-24T11:00:00Z", ref: { kind: "canvas", agentId: "ag-1", block: "db" } }] };
  const open = summary("ag-1", { openAsks: [{ id: "db", question: "raw q", blocking: true, options: [{ value: "pg", label: "pg" }, { value: "sqlite", label: "sqlite" }] }] });
  const a = card(render(project([withRef]), data({}, open)).live);
  assert.ok(a.includes("pick a db") && !a.includes("raw q") && !a.includes("askbox raw"), "curated shown, raw hidden");
  assert.match(a, /data-ask="a1"/);
  const b = card(render(project([withRef]), data({}, summary("ag-1"))).live);
  assert.match(b, /Resolved on canvas · the first mate will close this/);
  assert.match(b, /title="ref-closed"/);
  assert.match(b, /class="stg">With the first mate</);
});

test("Disputed and Stale show as the verdict chip and a non-drift flag", () => {
  const s = summary("ag-1", { verdict: { label: "Disputed", flags: [{ signal: "done-but-running", text: "says done, a job still runs" }], needsYou: false } });
  const html = card(render(project([T]), data({}, s)).live);
  assert.match(html, /cv-v cv-warn">Disputed</);
  assert.match(html, /says done, a job still runs/);
  assert.match(html, /title="canvas-disputed"/);
  assert.ok(!html.includes("fl-d"), "not drift");
});

test("a done card keeps its own shape: no live canvas, no links row", () => {
  const html = card(render(project([{ ...T, state: "done" }]), data()).live);
  assert.ok(!html.includes('class="cv') && !html.includes("cv-links"));
});

test("canvasFragment: long step lists are scaled, a missing BLUF or steps is simply absent, HTML is escaped", () => {
  const f = canvasFragment(summary("a", { bluf: "<b>x</b>", steps: { done: 30, total: 60, current: null } }));
  assert.ok(f.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.equal((f.match(/<i /g) ?? []).length, 24);
  assert.ok(!canvasFragment(summary("a", { bluf: "", steps: { done: 0, total: 0, current: null } })).includes("cv-"+"steps"));
});

test("relay: a click on a canvas ask is parsed, validated against the canvas, and named as a canvas ask for the first mate", () => {
  const prompt = { prompt: 'Picked: pg\n\nContext data:\n{"kind":"ask-choice","task":"t1","ask":"c-db","option":"pg"}' };
  assert.deepEqual(parseChoice(prompt)?.choice, { task: "t1", ask: "c-db", option: "pg" });
  assert.equal(parseChoice({ prompt: 'x\n\nContext data:\n{"kind":"ask-choice","task":"t1","ask":"c-d b","option":"pg"}' }), null);
  const lookup = (task: string, ask: string) => (ask === "c-db" ? { text: "Postgres or SQLite?", options: ["pg", "sqlite"] } : undefined);
  const [ok, bad] = newEntries("demo", [prompt, { prompt: 'x\n\nContext data:\n{"kind":"ask-choice","task":"t1","ask":"c-db","option":"mysql"}' }] as any, { tasks: ["t1"] }, NOW, lookup);
  assert.equal(ok.target, "t-t1#c-db");
  assert.equal(ok.stale, undefined);
  assert.equal(bad.stale, true, "an option the canvas ask does not offer is stale");
  const msg = formatMessage("demo", [{ ...ok, id: "c-1" }], (t) => (parseTarget(t) ? { title: "Build the API", asks: [] } : undefined));
  assert.match(msg, /picked option "pg" for canvas ask db \("Postgres or SQLite\?"\)/);
  assert.match(msg, /canvas ask is a question on the crew's own canvas/);
  assert.ok(!msg.includes("applied automatically"), "bin/page reply does not apply a canvas pick");
});
