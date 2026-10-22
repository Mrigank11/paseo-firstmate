// The task navigator: the live block's data-tn template (render.ts navHtml) and the page shell it is built into.
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadProject } from "../server/state.ts";
import { renderProject } from "../server/render.ts";
import { navScript } from "../server/nav-script.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agents = JSON.parse(readFileSync(join(here, "fixtures", "agents.json"), "utf8"));
const opts = { now: new Date("2026-10-21T10:15:30Z"), paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 20 };
const model = loadProject(join(here, "fixtures", "root"), "deck-demo");
const r = renderProject(model, agents, opts);
const tpl = r.live.slice(r.live.indexOf("<div hidden data-tn>"));
const stages = [...tpl.matchAll(/<div class="tn-st t-(\w+)" data-k="\1" data-n="(\d+)" data-ab="([^"]+)"/g)].map((m) => [m[1], +m[2], m[3]]);

test("the template lists every non-empty stage in page order, with its count and badge label", () => {
  assert.deepEqual(stages.map((s) => s[0]), ["you", "fm", "running", "blocked", "next", "parked", "done"]);
  const groups = [...r.live.matchAll(/class="grp" id="g-(\w+)"/g)].map((m) => m[1]).filter((k) => k !== "doneu");
  assert.deepEqual(stages.map((s) => s[0]), groups, "same stages, same order as the card groups");
  assert.deepEqual(stages.find((s) => s[0] === "blocked"), ["blocked", 1, "Block"]);
});

test("each task appears in the navigator once, linking to its own card", () => {
  const links = [...tpl.matchAll(/<a class="tn-a" href="#(t-[^"]+)" data-t="\1"/g)].map((m) => m[1]);
  const cards = [...r.live.matchAll(/<article class="task[^"]*" id="(t-[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...links].sort(), [...cards].sort());
  assert.equal(new Set(links).size, links.length);
  assert.equal(stages.reduce((n, s) => n + (s[1] as number), 0), links.length);
});

test("titles are escaped in the text and the title attribute", () => {
  const a = tpl.match(/<a class="tn-a" href="#t-pick-db"[^>]*>[^<]*<\/a>/)![0];
  assert.ok(!a.includes("<b>") && a.includes("&lt;b&gt;"), a);
});

test("a long stage is capped: data-cap and an 'N more' button; a short one is not", () => {
  const m = structuredClone(model);
  for (let i = 0; i < 9; i++) m.archive.push({ ...m.archive[0], id: `extra-${i}`, title: `Extra ${i}`, updatedMs: i });
  const t = renderProject(m, agents, opts).live;
  const done = t.slice(t.indexOf('<div class="tn-st t-done"'));
  assert.match(done, /^<div class="tn-st t-done" data-k="done" data-n="(\d+)"[^>]* data-cap>/);
  const n = +done.match(/data-n="(\d+)"/)![1];
  assert.ok(done.includes(`data-more="${n - 5} more">${n - 5} more</button>`));
  assert.ok(!tpl.slice(tpl.indexOf('<div class="tn-st t-you"'), tpl.indexOf('<div class="tn-st t-fm"')).includes("data-cap"));
});

test("a failed task is flagged in the navigator", () => {
  assert.match(tpl, /<li class="fail"><a class="tn-a" href="#t-broke-build"/);
});

test("no tasks: an empty template, and the shell stays hidden", () => {
  const empty = renderProject({ ...model, tasks: [], archive: [] }, {}, opts);
  assert.ok(empty.live.includes("<div hidden data-tn></div>"));
  assert.match(empty.page, /<aside class="tn" id="tn" aria-label="Tasks by stage" data-lavish-action hidden>/);
});

test("the page shell sits outside the live block and the nav script runs before the page script", () => {
  const live = r.page.indexOf('<div id="live">');
  for (const id of ['id="tn"', 'id="tn-fly"', 'id="tn-sheet"', 'id="tn-bar"']) {
    assert.ok(r.page.includes(id) && r.page.indexOf(id) < live, id);
  }
  assert.ok(r.page.indexOf("window.__tn=") < r.page.indexOf("window.__fdLive="));
});

test("the nav script bails out quietly on a page without the shell", () => {
  const ctx = vm.createContext({ document: { body: {}, getElementById: () => null }, window: {}, location: { hash: "" } });
  assert.doesNotThrow(() => vm.runInContext(navScript(), ctx));
  assert.equal((ctx as any).window.__tn, undefined);
});

test("the navigator stays clickable in Lavish's annotate mode: every part of it is inside a data-lavish-action element", () => {
  for (const id of ["tn", "tn-fly", "tn-sheet", "tn-back", "tn-bar"]) {
    assert.match(r.page, new RegExp(`id="${id}"[^>]* data-lavish-action[ >]`), id);
  }
});
