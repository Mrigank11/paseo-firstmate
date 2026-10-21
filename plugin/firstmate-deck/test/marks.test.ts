// Read marks: hash keying, rendering of the unread group, the CORS endpoint, order/provider rendering, markdown hard breaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardHash, cleanUi, mergeUi } from "../server/marks.ts";
import { MarksServer, readUi } from "../server/marks-server.ts";
import { renderProject } from "../server/render.ts";
import { loadProject } from "../server/state.ts";
import { markdown } from "../server/markdown.ts";
import { pageScript } from "../server/page-script.ts";

function world() {
  const root = mkdtempSync(join(tmpdir(), "marks-"));
  const p = join(root, "state", "projects", "demo");
  mkdirSync(join(p, "sections"), { recursive: true });
  mkdirSync(join(root, "state", "tasks", "a"), { recursive: true });
  mkdirSync(join(root, "state", "tasks", "b"), { recursive: true });
  writeFileSync(join(p, "project.json"), JSON.stringify({ title: "Demo", sections: [] }));
  writeFileSync(join(root, "state", "tasks", "a", "card.md"), "Card **A**\n");
  writeFileSync(join(root, "state", "tasks", "b", "card.md"), "Card B\n");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ tasks: [
    { id: "a", intent: "a", status: "done", project: "demo", order: 2, provider: "Sonnet 5", agentId: "ag1" },
    { id: "b", intent: "b", status: "done", project: "demo", order: 1 },
    { id: "c", intent: "c", status: "done", project: "demo" },
    { id: "q", intent: "q", status: "queued", project: "demo", provider: "Sonnet 5.5", agentId: "ag2" },
  ] }));
  return root;
}
const opts = { now: new Date("2026-10-21T10:00:00Z"), paseoAgentUrl: (id: string) => `http://p/${id}`, tickSeconds: 1 };

test("the hash is the first 8 hex of the sha1 of the card text, so editing a card changes it", () => {
  assert.equal(cardHash("abc"), "a9993e36");
  assert.notEqual(cardHash("Card B\n"), cardHash("Card B!\n"));
});

test("done tasks with a card go under Done, unread (ordered, hashed, with buttons); the rest under Done", () => {
  const root = world();
  const r = renderProject(loadProject(root, "demo"), {}, opts);
  const u = r.live.slice(r.live.indexOf('id="g-doneu"'), r.live.indexOf('id="g-done"'));
  assert.ok(u.indexOf('id="t-b"') < u.indexOf('id="t-a"'), "order=1 before order=2");
  assert.match(u, new RegExp(`id="t-a" data-i="1" data-h="${cardHash("Card **A**\n")}"`));
  assert.equal(u.split('class="mr"').length - 1, 2);
  assert.match(u, /Mark all read/);
  const d = r.live.slice(r.live.indexOf('id="g-done"'));
  assert.ok(d.includes('id="t-c"') && !d.includes('class="mr"'));
  assert.match(r.live, /class="sum c-done" data-k="u">2 done, unread/);
});

test("without Paseo's record the task's provider is the label", () => {
  const root = world();
  const r = renderProject(loadProject(root, "demo"), {}, opts);
  assert.match(r.live, /Sonnet 5\.5/);
  const m = loadProject(root, "demo");
  assert.equal(m.tasks.find((t) => t.id === "q")!.provider, "Sonnet 5.5");
});

test("the page script carries the endpoint URL and degrades silently without fetch", () => {
  const js = pageScript("demo", "page.live.js", 1, "http://h:4398/demo/state");
  assert.match(js, /http:\/\/h:4398\/demo\/state/);
  assert.doesNotThrow(() => new Function(js));
  assert.ok(renderProject(loadProject(world(), "demo"), {}, { ...opts, marksUrl: "http://h:4398/demo/state" }).page.includes("http://h:4398/demo/state"));
});

test("cleanUi / mergeUi: only valid keys survive; marks add", () => {
  const u = cleanUi({ o: { "g-done": 1, bad: 7 }, r: { "t-a": "abcd1234", x: "zz", "t-b": 5 } });
  assert.deepEqual(u, { o: { "g-done": 1 }, r: { "t-a": "abcd1234" } });
  assert.deepEqual(mergeUi(u, { o: {}, r: { "t-b": "00" } }).r, { "t-a": "abcd1234", "t-b": "00" });
});

test("the endpoint: CORS, GET/POST per project, merge, 404, bad body", async () => {
  const root = world();
  const srv = new MarksServer(() => root);
  const ok = await srv.listen(["127.0.0.1"], 0 + 43980 + Math.floor(Math.random() * 500));
  assert.equal(ok.length, 1);
  const base = `http://${ok[0]}/demo/state`;
  try {
    const g = await fetch(base);
    assert.equal(g.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await g.json(), { o: {}, r: {} });
    const pre = await fetch(base, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    const post = await fetch(base, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ r: { "t-a": "1234abcd" }, o: { "g-done": 0 } }) });
    assert.equal(post.status, 200);
    await fetch(base, { method: "POST", body: JSON.stringify({ r: { "t-b": "deadbeef" } }) });
    assert.deepEqual(readUi(root, "demo").r, { "t-a": "1234abcd", "t-b": "deadbeef" });
    assert.deepEqual(JSON.parse(readFileSync(join(root, "state/projects/demo/ui-state.json"), "utf8")).o, { "g-done": 0 });
    assert.equal((await fetch(`http://${ok[0]}/nope/state`)).status, 404);
    assert.equal((await fetch(base, { method: "POST", body: "{{" })).status, 400);
  } finally { await srv.close(); }
});

test("a line ending in two spaces is a hard break; other lines join with a space", () => {
  assert.equal(markdown("one  \ntwo\nthree"), "<p>one<br> two three</p>");
});

test("Needs-you ask: BLUF text is the bold label, context is open and does not repeat the first sentence; done notes are collapsed", () => {
  const root = world();
  mkdirSync(join(root, "state", "tasks", "q", "asks"), { recursive: true });
  writeFileSync(join(root, "state", "tasks", "q", "asks", "1.md"), "**BLUF: pick one.**\n\n1. First\n2. Second\n");
  writeFileSync(join(root, "state", "tasks", "b", "card.md"), "Brief body\n\n## Notes\n\nSide notes\n");
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ tasks: [
    { id: "q", intent: "q", status: "needs-captain", project: "demo", asks: [{ id: "a1", text: "BLUF: pick one.", since: "2026-10-21T09:00:00Z", context: "tasks/q/asks/1.md" }] },
    { id: "b", intent: "b", status: "done", project: "demo" },
  ] }));
  const live = renderProject(loadProject(root, "demo"), {}, opts).live;
  assert.match(live, /<div class="ask"><b>BLUF: pick one\.<\/b><\/div>/);
  assert.ok(!live.includes("Your call:"));
  assert.match(live, /<details class="actx" id="x-q-a1" open><summary>Context<\/summary><div><ol>/);
  assert.equal(live.split("BLUF: pick one.").length - 1, 1, "the sentence appears once");
  assert.match(live, /<p>Brief body<\/p><details class="cnotes" id="n-b"><summary>Notes<\/summary><p>Side notes<\/p><\/details>/);
});

test("stored marks put read cards under Done on the first paint", () => {
  const root = world();
  writeFileSync(join(root, "state/projects/demo/ui-state.json"), JSON.stringify({ o: {}, r: { "t-a": cardHash("Card **A**\n") } }));
  const r = renderProject(loadProject(root, "demo"), {}, opts);
  assert.match(r.live, /data-k="u">1 done, unread/);
  const d = r.live.slice(r.live.indexOf('id="g-done"'));
  assert.ok(d.includes('id="t-a"'));
});

test("a 160-char title renders in full and the title cell wraps", async () => {
  const { CSS } = await import("../server/style.ts");
  const root = world();
  const long = ("A very long task title with words " + "and-an-unbreakable-" + "x".repeat(40) + " ").repeat(1).padEnd(160, "y").slice(0, 160);
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ tasks: [{ id: "lt", intent: "lt", title: long, status: "queued", project: "demo" }] }));
  const live = renderProject(loadProject(root, "demo"), {}, opts).live;
  assert.ok(live.includes(long));
  assert.match(CSS, /\.tt\{flex-wrap:wrap\}\.ttl\{min-width:0;overflow-wrap:anywhere\}/);
});
