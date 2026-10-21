// Stable ask ids through the loader and the renderer (C1), and the per-ask trail (m4).
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../server/state.ts";
import { renderProject } from "../server/render.ts";

const opts = { now: new Date("2026-10-21T10:15:30Z"), paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 1 };

function world(asks: object[], inbox: object[]) {
  const root = mkdtempSync(join(tmpdir(), "deck-ids-"));
  const pdir = join(root, "state", "projects", "p");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "P" }));
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ tasks: [{ id: "pick", intent: "x", title: "Pick", status: "needs-captain", project: "p", asks }] }));
  writeFileSync(join(pdir, "inbox.jsonl"), inbox.map((e) => JSON.stringify(e) + "\n").join(""));
  return loadProject(root, "p");
}
const ask = (id: string | undefined, text: string, options?: string[]) => ({ ...(id ? { id } : {}), text, since: "2026-10-21T09:00:00Z", ...(options ? { options } : {}) });
const entry = (o: object) => ({ id: "c1", at: "2026-10-21T10:00:00Z", project: "p", text: "hi", prompt: {}, delivered: true, answered: false, ...o });
const block = (html: string, ask: string) => { const i = html.indexOf(`id="a-pick-${ask}"`); const r = html.slice(i + 8); const j = r.search(/class="askbox"|<\/article>/); return j < 0 ? r : r.slice(0, j); };

test("the loader uses the ask's own id, and falls back to a<index> for an ask written before ids", () => {
  assert.deepEqual(world([ask("a2", "Second"), ask("a7", "Seventh")], []).tasks[0].asks.map((a) => a.id), ["a2", "a7"]);
  assert.deepEqual(world([ask(undefined, "Old one"), ask(undefined, "Old two")], []).tasks[0].asks.map((a) => a.id), ["a1", "a2"]);
});

test("a comment moves the ask it names by id, not the ask that happens to sit at that index", () => {
  const m = world([ask("a2", "Which CI?", ["Buildkite", "Actions"]), ask("a3", "Fly or Render?")], [
    entry({ target: "t-pick#a2", text: "Picked: Buildkite", choice: { task: "pick", ask: "a2", option: "Buildkite" } }),
  ]);
  const [a2, a3] = m.tasks[0].asks;
  assert.equal(a2.replyChoice, "Buildkite");
  assert.equal(a3.repliedAt, undefined, "the ask now at index 1 is untouched");
});

test("a stale click moves no ask; an old integer choice in the inbox reads as a<n>", () => {
  const m = world([ask("a1", "Q?", ["A", "B"])], [
    entry({ id: "s", target: "t-pick#a1", stale: true, choice: { task: "pick", ask: "a1", option: "A" } }),
    entry({ id: "old", at: "2026-10-21T10:05:00Z", target: "t-pick#a9", choice: { task: "pick", ask: 9, option: "A" } }),
  ]);
  assert.equal(m.tasks[0].asks[0].repliedAt, undefined);
  assert.equal(m.comments.find((c) => c.id === "old")!.choice!.ask, "a9");
  assert.equal(m.comments.find((c) => c.id === "s")!.stale, true);
});

test("each ask shows its own comment trail; the card trail holds only card-level and orphaned comments", () => {
  const m = world([ask("a1", "Postgres or SQLite?", ["Postgres", "SQLite"]), ask("a2", "Which CI?", ["Buildkite", "Actions"])], [
    entry({ id: "k1", target: "t-pick#a2", text: "Picked: Actions", delivered: false, choice: { task: "pick", ask: "a2", option: "Actions" } }),
    entry({ id: "k2", at: "2026-10-21T10:01:00Z", target: "t-pick", text: "card level remark" }),
    entry({ id: "k3", at: "2026-10-21T10:02:00Z", target: "t-pick#a5", text: "Picked: Foo", stale: true, choice: { task: "pick", ask: "a5", option: "Foo" } }),
    entry({ id: "k4", at: "2026-10-21T10:03:00Z", target: "t-pick#a1", text: "why not MySQL?" }),
  ]);
  const html = renderProject(m, {}, opts).live;
  const card = html.slice(html.indexOf('id="t-pick"'), html.indexOf('class="askbox"'));
  assert.match(card, /2 comments/, "the card-level remark and the orphaned click, summarised by the newest");
  assert.match(card, /clicked <b>Foo<\/b>/, "a click on a gone ask stays visible on the card, marked as not applied");
  assert.ok(!/Actions|why not MySQL/.test(card), "comments on live asks are not at the top of the card");
  assert.match(block(html, "a1"), /why not MySQL/);
  assert.ok(!/Picked|picked/.test(block(html, "a1")));
  assert.match(block(html, "a2"), /You picked <b>Actions<\/b>/);
  assert.match(block(html, "a2"), /aria-pressed="true"/);
});

test("an ask that was answered after a pick takes its trail with it, but the pick stays on the card trail", () => {
  const m = world([ask("a3", "Fly or Render?", ["Fly", "Render"])], [
    entry({ target: "t-pick#a2", text: "Picked: Buildkite", delivered: true, answered: true, choice: { task: "pick", ask: "a2", option: "Buildkite" } }),
  ]);
  const html = renderProject(m, {}, opts).live;
  assert.match(html, /picked <b>Buildkite<\/b>/);
  assert.match(block(html, "a3"), /Your call:/);
});

test("DOM ids, option ids and data attributes carry the ask id", () => {
  const m = world([ask("a4", "Q?", ["A", "B"])], []);
  const html = renderProject(m, {}, opts).live;
  assert.match(html, /id="a-pick-a4"/);
  assert.match(html, /data-key="ask-pick-a4"/);
  assert.match(html, /<button type="button" class="opt" id="o-pick-a4-1" data-task="pick" data-ask="a4" data-opt="A"[^>]* aria-pressed="false">/);
});

test("failed tasks are not counted as done in the page summary", () => {
  const root = mkdtempSync(join(tmpdir(), "deck-failed-"));
  const pdir = join(root, "state", "projects", "p");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "project.json"), "{}");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ tasks: [
    { id: "ok", intent: "ok", status: "done", project: "p" }, { id: "bad", intent: "bad", status: "failed", project: "p" }, { id: "bad2", intent: "bad2", status: "failed", project: "p" }] }));
  const html = renderProject(loadProject(root, "p"), {}, opts).live;
  assert.match(html, /class="sum c-done">1 done</);
  assert.match(html, /class="sum c-fail">2 failed</);
});
