process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../server/state.ts";
import { liveJs, renderProject } from "../server/render.ts";

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
  const you = r.live.slice(r.live.indexOf('id="g-you"'), r.live.indexOf('id="g-running"'));
  assert.ok(you.includes('id="t-pick-db"'));
  assert.equal(you.split("Your call:").length - 1, 2);
});

test("failed marker, done collapsed, dependency across the archive", () => {
  assert.match(r.live, /<article class="task s-done s-failed" id="t-broke-build">/);
  assert.match(r.live, /<details class="grp" id="g-done">/);
  assert.match(r.live, /after <a href="#t-arch-schema">Draft the schema<\/a>/);
  assert.match(r.live, /then <a href="#t-pick-db">Choose the database for the demo<\/a>, <a href="#t-done-live">/);
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

test("loader: missing is empty, malformed throws", () => {
  const empty = loadProject(join(here, "fixtures", "nonexistent"), "nothing");
  assert.deepEqual([empty.tasks, empty.archive, empty.sections, empty.title], [[], [], [], "nothing"]);
  assert.equal(renderProject(empty, {}, opts).live.includes("No tasks"), true);
  assert.equal(model.archive.length, 2);
  assert.throws(() => loadProject(join(here, "fixtures", "bad"), "x"), /fleet\.json: invalid JSON/);
});
