process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../server/state.ts";
import { groupOf, liveJs, pageSigOf, renderProject } from "../server/render.ts";
import { withBodies } from "./bodies.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "fixtures", "root");
const agents = JSON.parse(readFileSync(join(here, "fixtures", "agents.json"), "utf8"));
// the agents Paseo finds by the fm.task label (the registry no longer names them)
const labeled = Object.fromEntries(Object.entries({ "pick-db": "ag-pick", "ship-api": "ag-api", "done-live": "ag-done", "broke-build": "ag-broke" })
  .map(([task, id]) => [task, [{ id, status: agents[id].status, archived: false, createdAt: agents[id].createdAt }]]));
const opts = { now: new Date("2026-10-21T10:15:30Z"), paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 20, labeled };
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

test("URLs in the ask line and its context markdown are clickable, in a new tab", () => {
  const m = structuredClone(model);
  const t = m.tasks.find((x) => x.id === "ask-fm")!;
  const url = "http://manjaro.tail2e75.ts.net:4387/session/abc";
  t.asks.push({ id: "a9", text: `Review ${url} please`, contextMd: `Open ${url}.\n\nAlso [docs](https://d.test/x) and \`${url}\`` });
  const live = renderProject(m, agents, opts).live;
  const a = (u: string, text = u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  assert.ok(live.includes(`Review ${a(url)} please`));
  assert.ok(live.includes(`Open ${a(url)}.`));
  assert.ok(live.includes(a("https://d.test/x", "docs")));
  assert.ok(live.includes(`<code>${url}</code>`));
});

test("replying changes the live payload, not the page file's signature", () => {
  const m = structuredClone(model);
  delete m.tasks.find((x) => x.id === "ask-fm")!.asks[0].repliedAt;
  const out = renderProject(m, agents, opts);
  assert.equal(out.signature, r.signature);
  assert.notEqual(out.live, r.live);
});

test("failed marker, done collapsed, dependency across the archive", () => {
  assert.match(r.live, /<article [^>]*class="task s-done s-failed" id="t-broke-build"[^>]*>/);
  assert.match(r.live, /<details class="grp" id="g-done">/);
  assert.match(withBodies(r), /after <a href="#t-arch-schema">Draft the schema<\/a>/);
  assert.match(withBodies(r), /then <a href="#t-pick-db">Choose the &lt;b&gt;database&lt;\/b&gt; for the demo<\/a>, <a href="#t-done-live">/);
});

test("live block shape", () => {
  assert.ok(!r.live.includes("{TS}") && !r.live.includes("{STAMP}"), "no clock placeholders: the browser writes the last-change stamp itself");
  assert.match(r.live, /\(last change <span data-chg="time"><\/span>\)/);
  assert.match(r.live, /<div data-slot-for="stamp"><span data-chg="long"><\/span><\/div>/, "the stamp rides in the live payload as an element the page fills from the time of the last change");
  assert.match(liveJs("a\"b"), /^window\.__fdLive&&window\.__fdLive\("a\\"b"\);\n$/);
  assert.match(r.page, /page\.live\.js/);
  assert.match(r.live, /<div data-slot-for="banner"><\/div>/);
});

test("the page file is a shell: no task list, no stamp, no banner, and the signature it was written with", () => {
  assert.match(r.page, /<div id="live"><!--LIVE-START--><div class="m" id="fd-loading">Loading the page…<\/div><!--LIVE-END--><\/div>/);
  for (const id of ["pick-db", "ship-api", "done-live"]) assert.ok(!r.page.includes(`id="t-${id}"`), `${id}: the list is not in the page file`);
  assert.equal(pageSigOf(r.page.slice(0, 256)), r.signature, "a restarted plugin can tell the file on disk is already this page");
  // the file is the same bytes whatever the tasks, the agents or the banner say
  const m2 = structuredClone(model);
  m2.tasks = m2.tasks.slice(1);
  assert.equal(renderProject(m2, agents, { ...opts, banner: { kind: "state", text: "x" } }).page, r.page);
  assert.equal(renderProject(model, agents, { ...opts, now: new Date("2027-01-01T00:00:00Z") }).page, r.page);
});

test("sections and nav", () => {
  assert.match(r.page, /<section id="endpoints" data-section="endpoints"><h2>Endpoints &amp; creds<\/h2>/);
  assert.match(r.page, /<h2>Feature flags<\/h2>/);
  assert.match(r.page, /<h2>Extra Notes<\/h2>/);
  assert.match(r.page, /<a href="#how">How it runs<\/a>/);
});

test("signature covers the page's frame only: tasks, agents and stages never move it", () => {
  const a2 = structuredClone(agents);
  a2["ag-api"].recent = ["Something else entirely"];
  a2["ag-api"].stepCount = 99;
  assert.equal(renderProject(model, a2, opts).signature, r.signature);
  a2["ag-api"].status = "idle";
  assert.equal(renderProject(model, a2, opts).signature, r.signature, "agent status");
  const m2 = structuredClone(model);
  m2.tasks[0].notes = "changed";
  m2.tasks[0].state = "done";
  assert.equal(renderProject(m2, agents, opts).signature, r.signature, "task data");
  assert.equal(renderProject(model, agents, { ...opts, now: new Date("2026-10-21T11:00:00Z"), banner: { kind: "ended", text: "x" } }).signature, r.signature, "stamp and banner");
  const m3 = structuredClone(model);
  m3.title = "Another title";
  assert.notEqual(renderProject(m3, agents, opts).signature, r.signature, "title");
  const m4 = structuredClone(model);
  m4.sections[0].content += "\nmore";
  assert.notEqual(renderProject(m4, agents, opts).signature, r.signature, "section content");
  assert.notEqual(renderProject(model, agents, { ...opts, canvas: { status: "ok", css: ".x{}", summaries: {}, cards: {} } }).signature, r.signature, "canvas css");
});

test("agent step text is escaped; banner renders", () => {
  const a2 = structuredClone(agents);
  a2["ag-api"].recent = ["<script>x</script>"];
  const out = renderProject(model, a2, { ...opts, banner: { kind: "plugin-down", text: "Plugin <down>" } });
  assert.ok(!out.live.includes("<script>x"));
  assert.match(out.live, /&lt;script&gt;x/);
  assert.match(out.live, /<div data-slot-for="banner"><div class="banner b-bad" role="status">Plugin &lt;down&gt;<\/div><\/div>/);
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

test("a migrated archive line's order does not pin it above newer Done work; a live task's order does", () => {
  const noCard = { ...model, tasks: model.tasks.map((t) => (t.id === "done-live" ? { ...t, card: "" } : t)) };
  const pos = (html: string, id: string) => html.indexOf(`id="t-${id}"`);
  // newest first is recon, schema, done-live. A legacy order on the older archive lines must not lift them above newer work.
  const m = structuredClone(noCard);
  m.archive.find((t) => t.id === "arch-schema")!.order = 1;
  m.archive.find((t) => t.id === "arch-recon")!.order = 2;
  const d = renderProject(m, agents, opts).live;
  assert.ok(pos(d, "arch-recon") < pos(d, "arch-schema") && pos(d, "arch-schema") < pos(d, "done-live"));
  m.archive.find((t) => t.id === "arch-recon")!.updatedMs = 1;
  m.archive.find((t) => t.id === "arch-recon")!.order = 0;
  const d1 = renderProject(m, agents, opts).live;
  assert.ok(pos(d1, "arch-schema") < pos(d1, "arch-recon"));
  // the same order on a live done task (the oldest) pins it to the top of Done
  const m2 = structuredClone(noCard);
  m2.tasks.find((t) => t.id === "done-live")!.order = 1;
  const d2 = renderProject(m2, agents, opts).live;
  assert.ok(pos(d2, "done-live") < pos(d2, "arch-recon") && pos(d2, "done-live") < pos(d2, "arch-schema"));
});

test("Parked sorts newest parked first; a live task's order still pins it", () => {
  const m = structuredClone(model);
  const ids = ["write-docs", "polish-ui", "ask-fm"];
  const days = ["2026-10-10T00:00:00Z", "2026-10-12T00:00:00Z", "2026-10-11T00:00:00Z"];
  ids.forEach((id, i) => { const t = m.tasks.find((x) => x.id === id)!; t.state = "parked"; t.asks = []; t.depends_on = []; t.updatedMs = Date.parse(days[i]); });
  const parked = (mm: typeof m) => { const html = renderProject(mm, agents, opts).live; const g = html.slice(html.indexOf('id="g-parked"')); return ids.filter((id) => g.includes(`id="t-${id}"`)).sort((a, b) => g.indexOf(`id="t-${a}"`) - g.indexOf(`id="t-${b}"`)); };
  assert.deepEqual(parked(m), ["polish-ui", "ask-fm", "write-docs"]);
  m.tasks.find((x) => x.id === "write-docs")!.order = 1;
  assert.deepEqual(parked(m), ["write-docs", "polish-ui", "ask-fm"]);
});

test("an archived task keeps its answered ask, and its context", () => {
  const t = model.archive.find((x) => x.id === "arch-schema")!;
  assert.deepEqual(t.answered.map((a) => [a.id, a.text]), [["a1", "Postgres or SQLite?"]]);
  const all = withBodies(r), card = all.slice(all.indexOf('id="t-arch-schema"'), all.indexOf('id="t-broke-build"'));
  assert.match(card, /Answered/);
  assert.match(card, /Postgres or SQLite\?/);
  assert.match(card, /<b>wins<\/b> on concurrent writes/);
  assert.doesNotMatch(card, /report\.md/);
});

test("a context file with no answer record (answered before records existed) still shows; notes survive next to a card", () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-"));
  mkdirSync(join(dir, "state", "tasks", "old", "asks"), { recursive: true });
  writeFileSync(join(dir, "state", "tasks", "old", "asks", "1.md"), "Old context body");
  writeFileSync(join(dir, "state", "tasks", "old", "card.md"), "Brief text");
  writeFileSync(join(dir, "state", "fleet-archive.jsonl"), '{"id":"old","project":"p","status":"done","notes":"Extra notes kept","lastEvent":"2026-10-21T01:00:00Z"}\n');
  const live = withBodies(renderProject(loadProject(dir, "p"), {}, opts));
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

test("the payload does not depend on the clock: same data, two hours later, byte-identical (idle pages download nothing)", () => {
  const later = renderProject(model, agents, { ...opts, now: new Date(opts.now.getTime() + 2 * 3600_000 + 17_000) });
  assert.equal(later.live, r.live);
  assert.match(r.live, /<span class="ck" data-so="\d+"><\/span>/, "a running agent carries when it started; the browser writes the elapsed time");
  assert.ok(!/ so far/.test(r.live), "no elapsed-time words in the payload");
});

test("done and parked cards are one line with their body kept aside; a card with a comment stays whole", () => {
  const lite = r.live.match(/<article [^>]*class="task s-(?:done|parked)[^"]*" id="t-([\w-]+)"[^>]*data-bh="([0-9a-f]{12})"/g) ?? [];
  assert.ok(lite.length >= 3, "the fixture's done cards are one line");
  for (const id of Object.keys(r.bodies)) {
    const card = r.live.slice(r.live.indexOf(`id="t-${id}"`), r.live.indexOf("</article>", r.live.indexOf(`id="t-${id}"`)));
    assert.match(card, /<details class="lz" id="lz-[^"]+"><summary>Show card<\/summary><div class="lzb"><\/div><\/details>/);
    assert.ok(card.length < 900, `${id}: the one-line card is small (${card.length} chars)`);
    assert.match(card, new RegExp(`data-bh="${r.bodies[id].hash}"`));
  }
  assert.ok(!r.live.includes("Postgres or SQLite?") || !Object.keys(r.bodies).includes("pick-db"), "an open ask keeps its card whole");
  // a comment on a done card puts its body back on the page at once (nothing to open, nothing to load)
  const done = model.tasks.find((x) => r.bodies[x.id]) ?? model.archive.find((x) => r.bodies[x.id])!;
  const m2 = structuredClone(model);
  m2.comments = [{ id: "cc", at: "2026-10-21T10:00:00Z", target: `t-${done.id}`, text: "a note", delivered: true, answered: false }];
  const r2 = renderProject(m2, agents, opts);
  assert.ok(!(done.id in r2.bodies), "a commented card is not one line");
  assert.ok(!r2.live.slice(r2.live.indexOf(`id="t-${done.id}"`)).startsWith(`id="t-${done.id}" data-bh`));
  // the body's hash is its content: same data, same hash; a changed card, a new hash
  assert.equal(renderProject(model, agents, opts).bodies[Object.keys(r.bodies)[0]].hash, r.bodies[Object.keys(r.bodies)[0]].hash);
});

