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

let lastRoot = "";
function project(tasks: object[], inbox: object[] = []) {
  const root = lastRoot = mkdtempSync(join(tmpdir(), "deck-cv-"));
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

test("the full embed card sits in a collapsed fold (the focus view opens it), and its stylesheet is inlined once in the page head", () => {
  const r = render(project([T]), data());
  const html = card(r.live);
  assert.match(html, /<details class="cnotes cv-d" id="cvd-ag-1"><summary>Full canvas<\/summary><div class="cv-f acv"><div class="blk">FULL<\/div><\/div><\/details>/);
  assert.equal(r.page.split(".acv .blk{color:red}").length - 1, 1);
  assert.ok(r.page.indexOf(".acv .blk") < r.page.indexOf("<body>"));
  assert.match(r.page, /body\.tn-focus \.task\.tn-sel \.cv\.has-full \.cv-c\{display:none\}/);
  assert.match(r.page, /q\(t,"details\.cv-d"\)\.forEach\(function\(x\)\{x\.open=true\}\)/, "the focus view opens the fold");
  assert.ok(!r.live.includes(".acv .blk{color:red}"), "css is page-level, not per card");
});

test("Needs you: the whole canvas is open and the BLUF is uncut; a running card keeps the compact strip", () => {
  const long = "x".repeat(400);
  const ask = { id: "db", question: "Q?", blocking: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] };
  const idle = (bluf: string) => render(project([T]), data({}, summary("ag-1", { runState: "idle", bluf, openAsks: [ask] })), { "ag-1": { ...agent, status: "idle" } }, { t1: [{ ...labeled.t1[0], status: "idle" }] });
  const r = idle(long);
  assert.ok(r.live.indexOf('id="t-t1"') > r.live.indexOf('id="g-you"'));
  const html = card(r.live);
  assert.match(html, /<div class="cv has-full cv-whole"/);
  assert.match(html, /<details class="cnotes cv-d" id="cvd-ag-1" open><summary>Full canvas<\/summary><div class="cv-f acv"><div class="blk">FULL<\/div>/);
  assert.ok(!html.includes('class="cv-bluf"') && !html.includes('class="cv-steps"'), "the full card carries the BLUF and steps itself");
  assert.match(html, /class="cv-v cv-mut">Working</, "the verdict row stays");
  // no card fetched yet: the strip falls back, with the BLUF uncut
  const bare = card(render(project([T]), data({ cards: {} }, summary("ag-1", { runState: "idle", bluf: long, openAsks: [ask] })), { "ag-1": { ...agent, status: "idle" } }, { t1: [{ ...labeled.t1[0], status: "idle" }] }).live);
  assert.ok(bare.includes(`class="cv-bluf">${long}<`));
  // a running card is still compact and folded, its BLUF cut
  const run = card(render(project([T]), data({}, summary("ag-1", { bluf: long }))).live);
  assert.ok(run.includes("cv-bluf") && !run.includes(long) && !run.includes("cv-whole") && !/id="cvd-ag-1" open/.test(run));
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

test("a canvas ask without usable options is shown read-only: it says why and links the canvas", () => {
  const s = summary("ag-1", { openAsks: [{ id: "my-ask", question: "Free text?", blocking: false, options: [] }] });
  const html = card(render(project([T]), data({}, s)).live);
  assert.match(html, /Free text\?/);
  assert.match(html, /No buttons here: this question has no options\. <a href="http:\/\/canvas\.test\/a\/ag-1">Answer it on the canvas ↗<\/a>, or comment on this card\./);
  assert.ok(!html.includes("<button"));
  const one = summary("ag-1", { openAsks: [{ id: "q1", question: "Sure?", blocking: false, options: [{ value: "y", label: "Yes" }] }] });
  assert.match(card(render(project([T]), data({}, one)).live), /this question has only one option/);
});

test("a canvas ask whose id the page cannot carry says so; agent-canvas's own id rule decides (hyphens are fine)", () => {
  const two = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
  for (const id of ["9lives", "has space", "x".repeat(33), "a.b"]) {
    const html = card(render(project([T]), data({}, summary("ag-1", { openAsks: [{ id, question: "Q?", blocking: false, options: two }] }))).live);
    assert.ok(!html.includes("<button"), id);
    assert.match(html, /No buttons here: its id .* is not one the page can carry in a button\. <a href="http:\/\/canvas\.test\/a\/ag-1">/, id);
  }
  for (const id of ["merge-option", "q-1", "a_b-c", "x".repeat(32)]) {
    const html = card(render(project([T]), data({}, summary("ag-1", { openAsks: [{ id, question: "Q?", blocking: false, options: two }] }))).live);
    assert.equal((html.match(/<button type="button" class="opt"/g) ?? []).length, 2, id);
    assert.ok(!html.includes("No buttons here"), id);
  }
});

test("a hyphenated canvas ask id survives the whole path: button, comment target, relay, stored pick, stage", () => {
  const id = "merge-option";
  const s = summary("ag-1", { openAsks: [{ id, question: "How?", blocking: true, options: [{ value: "a-b", label: "A" }, { value: "b", label: "B" }] }] });
  const html = card(render(project([T]), data({}, s)).live);
  assert.match(html, /<div class="askbox raw" id="a-t1-c-merge-option">/);
  assert.match(html, /id="o-t1-c-merge-option-1" data-task="t1" data-ask="c-merge-option" data-opt="a-b"/);
  // a Lavish comment on the block, its button, or a stamped anchor inside it resolves to the ask (task ids hold hyphens and "-c-" too)
  assert.equal(extractTarget("#a-t1-c-merge-option > .opts > button", { tasks: ["t1"] }), "t-t1#c-merge-option");
  assert.equal(extractTarget("div#a-t1-c-merge-option > div.opts > div.opt-row > button#o-t1-c-merge-option-2", { tasks: ["t1"] }), "t-t1#c-merge-option");
  assert.equal(extractTarget("div#k_a-t1-c-merge-option_0-3 > p", { tasks: ["t1"] }), "t-t1#c-merge-option");
  assert.equal(extractTarget("#a-canvas-context-merge-plan-c-merge-option > div", { tasks: ["canvas-context-merge-plan"] }), "t-canvas-context-merge-plan#c-merge-option");
  assert.equal(extractTarget("#o-fix-c-thing-c-q-c-2-1", { tasks: ["fix-c-thing"] }), "t-fix-c-thing#c-q-c-2", "the split is the one that names a known task");
  assert.equal(extractTarget("#a-nope-c-merge-option", { tasks: ["t1"] }), "page");
  assert.deepEqual(parseTarget("t-canvas-fix#c-merge-option"), { task: "canvas-fix", ask: "c-merge-option" });
  // the click is parsed, kept as a pick, and named for the first mate (bin/page canvas-answer takes the id without the "c-")
  const prompt = { prompt: 'Picked: a-b\n\nContext data:\n{"kind":"ask-choice","task":"t1","ask":"c-merge-option","option":"a-b"}' };
  assert.deepEqual(parseChoice(prompt)?.choice, { task: "t1", ask: "c-merge-option", option: "a-b" });
  const lookup = (_t: string, ask: string) => (ask === "c-merge-option" ? { text: "How?", options: ["a-b", "b"] } : undefined);
  const [ok] = newEntries("demo", [prompt] as any, { tasks: ["t1"] }, NOW, lookup);
  assert.equal(ok.target, "t-t1#c-merge-option");
  assert.equal(ok.stale, undefined);
  const msg = formatMessage("demo", [{ ...ok, id: "c-1" }], (t) => (parseTarget(t) ? { title: "Build the API", asks: [] } : undefined));
  assert.match(msg, /picked option "a-b" for canvas ask merge-option \("How\?"\)/);
  // the stored pick moves the stage to "with the first mate" and the card shows it as sent
  const picked = card(render(project([T], [{ ...ok, id: "c-1", at: "2026-10-24T11:50:00Z", delivered: true, answered: false }]), data({}, s)).live);
  assert.match(picked, /Sent to the first mate/);
  assert.match(picked, /You picked <b>a-b<\/b>/);
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
  assert.match(b, /class="stg">Running</, "T3: the crew is still running, so the card is Running with the flag, not With the first mate");
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

test("a done card with a canvas.final.html shows it inline, minus the frozen run chrome; card.md folds below, and is the fallback when there is no snapshot", () => {
  const snap = `<!doctype html><html lang="en"><head><style>
body{margin:0;background:#fff}
.cv-snap{max-width:860px;margin:24px auto}
.acv .lede{color:red}
</style></head><body>
<div class="cv-snap acv"><div class="acv"><article class="canvas"><div class="sheet"><div class="statusline"><div class="l1">Done · Paseo: idle</div></div><div class="trow dimmable"><span class="title">T</span><a href="x">Open agent in Paseo ↗</a></div><div class="sheet dimmable"><p class="lede">FINAL "canvas"</p></div></div></article></div></div>
</body></html>
`;
  const withSnap = (files: Record<string, string>) => {
    project([{ ...T, state: "done" }]);
    const dir = join(lastRoot, "state", "tasks", "t1");
    mkdirSync(dir, { recursive: true });
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
    return loadProject(lastRoot, "demo");
  };
  const r = render(withSnap({ "canvas.final.html": snap, "card.md": "short card text" }));
  const both = withBodies(r).slice(withBodies(r).indexOf(`id="t-t1"`)); // the snapshot has its own <article>, so card() would cut short
  assert.match(both, /<details class="cnotes cv-d" id="cvf-t1" open><summary>Final canvas<\/summary><div class="cv-f cv-fin acv"><div class="acv"><article class="canvas"><div class="sheet">.*FINAL "canvas"/s);
  assert.ok(!both.includes("<iframe") && !both.includes("statusline") && !both.includes("Open agent in Paseo"), "inline, without the frozen status line and title row");
  assert.ok(both.indexOf("cv-fin") < both.indexOf("short card text"), "canvas first");
  assert.match(both, /<details class="cnotes" id="cd-t1"><summary>Card<\/summary>.*short card text/s);
  // its stylesheet is hoisted once, without the standalone document's body and wrapper rules
  assert.equal((withBodies(r).match(/<style data-cv-snap>/g) ?? []).length, 1);
  assert.match(withBodies(r), /<style data-cv-snap>\n\.acv \.lede\{color:red\}\n<\/style>/);
  const cardOnly = card(withBodies(render(withSnap({ "card.md": "short card text" }))));
  assert.ok(!cardOnly.includes("cv-fin") && /<div class="nt">.*short card text/s.test(cardOnly));
  // a snapshot that is not the expected shape still shows, in a sandboxed frame
  const odd = card(withBodies(render(withSnap({ "canvas.final.html": "<p>odd</p>" }))));
  assert.match(odd, /<iframe class="cv-final" title="Final canvas" sandbox srcdoc="&lt;p&gt;odd/);
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

// ---------- recap strip ----------
import { recapOfSource } from "../server/recap.ts";
import { withBodies } from "./bodies.ts";

const RECAP = { asked: "Use SQLite, keep the migration path open", did: "Switched the store to SQLite behind a flag" };
const recapData = (over: object = {}) => data({}, summary("ag-1", { recap: RECAP, updatedAt: Date.parse("2026-10-24T11:30:00Z"), ...over }));
const idleRender = (m: ReturnType<typeof project>, d: CanvasData) => render(m, d, { "ag-1": { ...agent, status: "idle" } }, { t1: [{ ...labeled.t1[0], status: "idle" }] });
const ASKING = { runState: "idle", verdict: { label: "Needs you", flags: [], needsYou: true }, openAsks: [{ id: "db", question: "Q?", blocking: true, options: [{ value: "a", label: "A" }] }] };
const stripOf = (html: string) => /<div class="recap[^"]*">[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? "";

test("recap strip: Needs you and With the first mate show You asked / Crew did above the canvas; Running does not", () => {
  const needs = card(idleRender(project([T]), recapData(ASKING)).live);
  assert.match(stripOf(needs), /You asked<\/span><span class="rc-v" title="Use SQLite[^"]*">Use SQLite, keep the migration path open/);
  assert.match(stripOf(needs), /Crew did · 11:30<\/span><span class="rc-v"[^>]*>Switched the store/);
  assert.ok(needs.indexOf('class="recap"') < needs.indexOf('class="ag"'), "strip comes before the agent line and canvas");
  assert.equal(stripOf(card(render(project([T]), recapData()).live)), "", "a running card has no strip");
  assert.equal(stripOf(card(render(project([T]), data()).live)), "", "no recap, no strip");
});

test("recap strip: a comment newer than the crew's last write replaces the pair with 'Not acted on yet'", () => {
  const c = { id: "c1", at: "2026-10-24T11:45:00Z", target: "t-t1", text: "Also add a restore <test>", delivered: false, answered: false };
  const html = card(idleRender(project([T], [c]), recapData(ASKING)).live);
  const s = stripOf(html);
  assert.match(s, /You asked · 11:45/);
  assert.match(s, /Also add a restore &lt;test&gt;/);
  assert.match(s, /Not acted on yet<\/i> · waiting on the first mate/);
  assert.ok(!s.includes("Switched the store"));
  assert.ok(!html.includes('class="trail"'), "the strip carries the card-level comment, so the trail line is dropped");
  // an older comment leaves the pair alone
  const old = { ...c, at: "2026-10-24T11:10:00Z" };
  assert.match(stripOf(card(idleRender(project([T], [old]), recapData(ASKING)).live)), /Switched the store/);
});

test("recap strip: a done card reads canvas.final.tsx; no file means no strip", () => {
  const tsx = `<Canvas title="T" status="done"><Bluf>Shipped.</Bluf><Markdown id="recap">**You asked:** Ship the API &amp; docs.\n\n**I did:** Shipped both.</Markdown></Canvas>`;
  assert.deepEqual(recapOfSource(tsx), { asked: "Ship the API & docs.", did: "Shipped both." });
  assert.equal(recapOfSource(`<Canvas title="T" status="done"><Bluf>x</Bluf></Canvas>`), null);
  assert.equal(recapOfSource(`<Markdown id="recap">**You asked:** only half</Markdown>`), null);
  const D = { ...T, state: "done" };
  const m = project([D]);
  const dir = join(lastRoot, "state", "tasks", "t1");
  mkdirSync(dir, { recursive: true });
  assert.equal(stripOf(card(withBodies(render(m)))), "");
  writeFileSync(join(dir, "canvas.final.tsx"), tsx);
  const m2 = loadProject(lastRoot, "demo");
  const html = card(withBodies(render(m2)));
  assert.match(stripOf(html), /Ship the API &amp; docs\./);
  assert.match(stripOf(html), /Shipped both\./);
});

// ---- one explanation per card: the crew canvas, or the first mate's context only when there is none ----
const SNAP = `<!doctype html><html lang="en"><head><style>
.acv .lede{color:red}
</style></head><body>
<div class="cv-snap acv"><div class="acv"><article class="canvas"><div class="sheet"><div class="statusline"><div class="l1">Done</div></div><div class="trow dimmable"><span class="title">T</span></div><div class="sheet dimmable"><p class="lede">CREW CANVAS</p></div></div></article></div></div>
</body></html>
`;
function askCard(files: Record<string, string>, ask: object, lab: any = labeled, canvas?: CanvasData, ags: Record<string, any> = { "ag-1": agent }) {
  project([{ ...T, asks: [{ id: "a1", text: "Merge?", since: "2026-10-24T11:00:00Z", options: ["Merge", "Hold"], context: "tasks/t1/asks/1.md", ...ask }] }]);
  const dir = join(lastRoot, "state", "tasks", "t1");
  mkdirSync(join(dir, "asks"), { recursive: true });
  writeFileSync(join(dir, "asks", "1.md"), "CONTEXT BODY");
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  const m = loadProject(lastRoot, "demo");
  const r = render(m, canvas, ags, lab);
  return r.live.slice(r.live.indexOf(`id="t-t1"`));
}

test("Needs you with a live canvas: the context folds, a note stays open under 'First mate adds'", () => {
  const full = askCard({}, {}, labeled, data());
  assert.match(full, /<details class="actx" id="x-t1-a1"><summary>Context<\/summary>/, "folded, not open");
  const note = askCard({}, { note: true }, labeled, data());
  assert.match(note, /<details class="actx note" id="x-t1-a1" open><summary>First mate adds<\/summary><div><p>CONTEXT BODY/);
});

test("Needs you with an archived crew: the ask-time snapshot and its recap show, the context folds", () => {
  const gone = { t1: [{ id: "ag-1", status: "closed", archived: true, createdAt: "2026-10-24T11:00:00Z" }] };
  const html = askCard({ "canvas.final.html": SNAP, "canvas.final.tsx": '<Canvas title="x" status="done">\n<Bluf>b</Bluf>\n<Markdown id="recap">**You asked:** merge it. **I did:** merged it.</Markdown>\n</Canvas>\n' }, {}, gone, { status: "ok", css: "", summaries: {}, cards: {} }, {});
  assert.match(html, /<details class="cnotes cv-d" id="cvf-t1" open><summary>Crew canvas<\/summary>.*CREW CANVAS/s);
  assert.match(html, /class="recap"[^>]*>.*merge it.*merged it/s);
  assert.ok(!html.includes("statusline"));
  assert.match(html, /<details class="actx" id="x-t1-a1"><summary>Context<\/summary>/);
});

test("Needs you with no canvas ever: the full Context stays open, as before", () => {
  const html = askCard({}, {}, {}, undefined, {});
  assert.match(html, /<details class="actx" id="x-t1-a1" open><summary>Context<\/summary>/);
  assert.ok(!html.includes("cvf-t1"));
});

test("Needs you with a saved snapshot and only an auto-drawn live canvas: the snapshot shows, the auto canvas does not", () => {
  const auto = data({}, summary("ag-1", { auto: true, bluf: "DONE: raw last message", runState: "idle" }));
  const html = askCard({ "canvas.final.html": SNAP, "canvas.final.tsx": '<Canvas title="x" status="done">\n<Bluf>b</Bluf>\n<Markdown id="recap">**You asked:** plan it. **I did:** planned it.</Markdown>\n</Canvas>\n' }, {}, labeled, auto);
  assert.match(html, /<details class="cnotes cv-d" id="cvf-t1" open><summary>Crew canvas<\/summary>.*CREW CANVAS/s);
  assert.ok(!html.includes("auto canvas") && !html.includes("DONE: raw last message"), "the timeline-drawn canvas is not shown");
  // a live canvas that is gone (store lost in a restart) leaves the snapshot too
  const gone = askCard({ "canvas.final.html": SNAP }, {}, labeled, { status: "ok", css: "", summaries: {}, cards: {} });
  assert.match(gone, /id="cvf-t1" open><summary>Crew canvas<\/summary>.*CREW CANVAS/s);
  // a canvas the crew wrote still wins over an older snapshot
  const written = askCard({ "canvas.final.html": SNAP }, {}, labeled, data());
  assert.match(written, /class="cv has-full/);
  assert.ok(!written.includes("cvf-t1"));
});
