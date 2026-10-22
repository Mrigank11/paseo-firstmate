process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../server/state.ts";
import { groupOf, liveJs, renderProject } from "../server/render.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "fixtures", "root");
const agents = JSON.parse(readFileSync(join(here, "fixtures", "agents.json"), "utf8"));
const opts = { now: new Date("2026-10-21T10:15:30Z"), paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 20 };
const model = loadProject(root, "deck-demo");
const r = renderProject(model, agents, opts);

test("snapshot matches fixtures/expected.html", () => {
  const exp = join(here, "fixtures", "expected.html");
  if (process.env.UPDATE_SNAPSHOT || !existsSync(exp)) writeFileSync(exp, r.page);
  assert.equal(r.page, readFileSync(exp, "utf8"));
});

test("each task appears exactly once; Needs you wins", () => {
  for (const id of ["pick-db", "ship-api", "write-docs", "polish-ui", "done-live", "broke-build", "arch-schema", "arch-recon"]) {
    assert.equal(r.live.split(`id="t-${id}"`).length - 1, 1, id);
  }
  assert.ok(!r.live.includes("other-thing") && !r.live.includes("arch-other"));
  const you = r.live.slice(r.live.indexOf('id="g-you"'), r.live.indexOf('id="g-fm"'));
  assert.ok(you.includes('id="t-pick-db"'));
  assert.equal(you.split("Your call:").length - 1, 2);
  assert.ok(!you.includes('id="t-ask-fm"'));
});

test("replied ask: state loading, muted card, With the first mate group", () => {
  const t = model.tasks.find((x) => x.id === "ask-fm")!;
  assert.equal(t.asks[0].repliedAt, "2026-10-21T09:10:00Z");
  assert.equal(t.asks[0].replyText, "show me both in detail");
  const fm = r.live.slice(r.live.indexOf('id="g-fm"'), r.live.indexOf('id="g-running"'));
  assert.ok(fm.includes('id="t-ask-fm"'));
  assert.match(fm, /You replied 09:10: “show me both in detail” · the first mate is on it/);
  assert.ok(fm.includes("Layout A or B?") && !fm.includes("Your call:") && !fm.includes("waiting on you"));
  assert.ok(r.live.indexOf('id="g-you"') < r.live.indexOf('id="g-fm"'));
  assert.ok(!r.live.slice(r.live.indexOf('id="g-you"'), r.live.indexOf('id="g-fm"')).includes('id="t-ask-fm"'));
  assert.match(r.live, /<a href="#g-you" class="sum c-you">1 needs you<\/a><a href="#g-fm" class="sum c-fm">1 with the first mate<\/a>/);
});

test("a task with one replied and one open ask stays in Needs you", () => {
  const m = structuredClone(model);
  const t = m.tasks.find((x) => x.id === "ask-fm")!;
  t.asks.push({ id: "a2", text: "Second?", contextMd: "" });
  const live = renderProject(m, agents, opts).live;
  assert.ok(live.slice(live.indexOf('id="g-you"'), live.indexOf('id="g-fm"')).includes('id="t-ask-fm"'));
  assert.ok(!live.includes('id="g-fm"'));
  assert.equal(groupOf(t, true), "you");
  t.asks[1].repliedAt = "2026-10-21T09:30:00Z";
  assert.equal(groupOf(t, true), "fm");
});

test("replying changes the signature", () => {
  const m = structuredClone(model);
  delete m.tasks.find((x) => x.id === "ask-fm")!.asks[0].repliedAt;
  assert.notEqual(renderProject(m, agents, opts).signature, r.signature);
});

test("failed marker, done collapsed, dependency across the archive", () => {
  assert.match(r.live, /<article class="task s-done s-failed" id="t-broke-build"[^>]*>/);
  assert.match(r.live, /<details class="grp" id="g-done">/);
  assert.match(r.live, /after <a href="#t-arch-schema">Draft the schema<\/a>/);
  assert.match(r.live, /then <a href="#t-pick-db">Choose the &lt;b&gt;database&lt;\/b&gt; for the demo<\/a>, <a href="#t-done-live">/);
});

test("live block shape", () => {
  assert.ok(r.live.includes("{TS}"));
  assert.ok(!r.page.includes("{TS}"));
  assert.ok(r.page.includes("<div id=\"live\"><!--LIVE-START-->" + r.live.replace("{TS}", "10:15:30") + "<!--LIVE-END--></div>"));
  assert.match(liveJs("a\"b"), /^window\.__fdLive&&window\.__fdLive\("a\\"b"\);\n$/);
  assert.match(r.page, /page\.live\.js/);
  assert.match(r.page, /last update <b>2026-10-21 10:15 UTC<\/b>/);
});

test("sections and nav", () => {
  assert.match(r.page, /<section id="endpoints" data-section="endpoints"><h2>Endpoints &amp; creds<\/h2>/);
  assert.match(r.page, /<h2>Feature flags<\/h2>/);
  assert.match(r.page, /<h2>Extra Notes<\/h2>/);
  assert.match(r.page, /<a href="#how">How it runs<\/a>/);
});

test("signature ignores step text, tracks status and task data", () => {
  const a2 = structuredClone(agents);
  a2["ag-api"].recent = ["Something else entirely"];
  a2["ag-api"].stepCount = 99;
  assert.equal(renderProject(model, a2, opts).signature, r.signature);
  a2["ag-api"].status = "idle";
  assert.notEqual(renderProject(model, a2, opts).signature, r.signature);
  const m2 = structuredClone(model);
  m2.tasks[0].notes = "changed";
  assert.notEqual(renderProject(m2, agents, opts).signature, r.signature);
});

test("agent step text is escaped; banner renders", () => {
  const a2 = structuredClone(agents);
  a2["ag-api"].recent = ["<script>x</script>"];
  const out = renderProject(model, a2, { ...opts, banner: { kind: "plugin-down", text: "Plugin <down>" } });
  assert.ok(!out.live.includes("<script>x"));
  assert.match(out.live, /&lt;script&gt;x/);
  assert.match(out.page, /<div class="banner b-bad" role="status">Plugin &lt;down&gt;<\/div>/);
});

test("loader: missing is empty; a broken fleet.json is reported, not thrown; a broken archive line is skipped", () => {
  const empty = loadProject(join(here, "fixtures", "nonexistent"), "nothing");
  assert.deepEqual([empty.tasks, empty.archive, empty.sections, empty.title], [[], [], [], "nothing"]);
  assert.equal(renderProject(empty, {}, opts).live.includes("No tasks"), true);
  assert.equal(model.archive.length, 2);
  const bad = loadProject(join(here, "fixtures", "bad"), "x");
  assert.match(bad.fleetError?.message ?? "", /^invalid JSON/);
  assert.equal(bad.fleetError?.file, "fleet.json");
  assert.deepEqual(bad.tasks, [], "the caller keeps its last good model; the loader hands back no tasks");
  const dir = mkdtempSync(join(tmpdir(), "deck-load-"));
  mkdirSync(join(dir, "state", "projects", "p"), { recursive: true });
  writeFileSync(join(dir, "state", "projects", "p", "project.json"), "{}");
  writeFileSync(join(dir, "state", "fleet.json"), "  \n");
  assert.equal(loadProject(dir, "p").fleetError?.message, "file is empty", "an empty fleet.json is an error, not zero tasks");
  writeFileSync(join(dir, "state", "fleet.json"), '{"tasks":[]}');
  writeFileSync(join(dir, "state", "fleet-archive.jsonl"), '{"id":"a","project":"p","status":"done"}\n{"id":"half","proj\nnot json at all\n{"id":"b","project":"p","status":"done"}\n');
  const m = loadProject(dir, "p");
  assert.deepEqual([m.archive.map((t) => t.id), m.archiveSkipped, m.fleetError], [["a", "b"], 2, undefined]);
});

test("Done sorts by last update, newest first, live and archived together", () => {
  // done-live has a card, so it sits in "Done, unread"; the other two are read-less and sort within Done
  const done = r.live.slice(r.live.indexOf('id="g-done"'));
  assert.ok(done.indexOf('id="t-arch-recon"') > 0 && done.indexOf('id="t-arch-recon"') < done.indexOf('id="t-arch-schema"'));
  const noCard = renderProject(structuredClone({ ...model, tasks: model.tasks.map((t) => (t.id === "done-live" ? { ...t, card: "" } : t)) }), agents, opts).live;
  const dn = noCard.slice(noCard.indexOf('id="g-done"'));
  assert.ok(dn.indexOf('id="t-arch-schema"') < dn.indexOf('id="t-done-live"'));
  // an archived task that is updated later moves up; an explicit order still pins
  const m = structuredClone(model);
  m.archive.find((t) => t.id === "arch-schema")!.updatedMs = Date.parse("2026-10-21T09:30:00Z");
  const d2 = renderProject(m, agents, opts).live;
  assert.ok(d2.indexOf('id="t-arch-schema"') < d2.indexOf('id="t-arch-recon"'));
});

test("an archived task keeps its answered ask, its context and a report pointer", () => {
  const t = model.archive.find((x) => x.id === "arch-schema")!;
  assert.deepEqual(t.answered.map((a) => [a.id, a.text]), [["a1", "Postgres or SQLite?"]]);
  assert.ok(t.hasReport);
  const card = r.live.slice(r.live.indexOf('id="t-arch-schema"'), r.live.indexOf('id="t-broke-build"'));
  assert.match(card, /Answered/);
  assert.match(card, /Postgres or SQLite\?/);
  assert.match(card, /<b>wins<\/b> on concurrent writes/);
  assert.match(card, /state\/tasks\/arch-schema\/report\.md/);
});

test("a context file with no answer record (answered before records existed) still shows; notes survive next to a card", () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-"));
  mkdirSync(join(dir, "state", "tasks", "old", "asks"), { recursive: true });
  writeFileSync(join(dir, "state", "tasks", "old", "asks", "1.md"), "Old context body");
  writeFileSync(join(dir, "state", "tasks", "old", "card.md"), "Brief text");
  writeFileSync(join(dir, "state", "fleet-archive.jsonl"), '{"id":"old","project":"p","status":"done","notes":"Extra notes kept","lastEvent":"2026-10-21T01:00:00Z"}\n');
  const live = renderProject(loadProject(dir, "p"), {}, opts).live;
  assert.match(live, /Old context body/);
  assert.match(live, /Extra notes kept/);
});

test("blocked task: its own Blocked group between Running and Next up, with what it waits on", () => {
  const g = r.live.slice(r.live.indexOf('id="g-blocked"'), r.live.indexOf('id="g-next"'));
  assert.ok(r.live.indexOf('id="g-running"') < r.live.indexOf('id="g-blocked"'));
  assert.ok(g.includes('id="t-await-key"') && g.includes("Blocked on:</b> Nemath: Trigger Prod API key"));
  assert.ok(r.live.includes('href="#g-blocked" class="sum c-blocked">1 blocked'));
  assert.ok(!r.live.slice(r.live.indexOf('id="g-parked"'), r.live.indexOf("<div hidden data-tn>")).includes("await-key"));
});
