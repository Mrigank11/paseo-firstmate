process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, type ProjectModel, type Task } from "../server/state.ts";
import { renderProject, trailHtml } from "../server/render.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-21T10:15:30Z");
const opts = { now: NOW, paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 1 };

// Crew-reachable text: every field below is stuffed with all four attacks.
const EVIL = 'X<script>alert(1)</script><img src=x onerror=alert(1)><details open>[click](javascript:alert(1)) [ok](http://fine.test)';
const MD_EVIL = `${EVIL}\n\n<img src=x onerror=alert(2)>\n\n- <script>x</script> item\n\n| a | b |\n|---|---|\n| ${EVIL} | <b>c</b> |`;

function evilModel(): ProjectModel {
  const m: ProjectModel = structuredClone(loadProject(join(here, "fixtures", "root"), "deck-demo"));
  m.title = EVIL;
  m.sectionTitles = { ...m.sectionTitles, endpoints: EVIL };
  m.sections = [
    { name: "endpoints", kind: "md", content: MD_EVIL },
    { name: "decisions", kind: "md", content: "[x](javascript:alert(1))" },
  ];
  const task = (over: Partial<Task>): Task => ({ id: "e", intent: "", status: "queued", depends_on: [], asks: [], notes: "", card: "", ...over });
  m.tasks = [
    task({ id: "e-title", title: EVIL, status: "needs-captain", notes: EVIL,
      asks: [{ text: EVIL, since: "2026-10-21T09:00:00Z", contextMd: MD_EVIL, options: [EVIL, "B"] }] }),
    task({ id: "e-intent", intent: EVIL, status: "running", agentId: "ag-1", card: MD_EVIL }),
    task({ id: "e-replied", intent: "plain", status: "needs-captain",
      asks: [{ text: EVIL, since: "2026-10-21T09:00:00Z", contextMd: "", repliedAt: "2026-10-21T09:10:00Z", replyText: EVIL },
        { text: EVIL, since: "2026-10-21T09:00:00Z", contextMd: "", repliedAt: "2026-10-21T09:10:00Z", replyChoice: EVIL }] }),
    task({ id: "e-dep", intent: "dependent", status: "queued", depends_on: ["e-title"], notes: EVIL }),
  ];
  m.archive = [task({ id: "e-arch", title: EVIL, status: "done", depends_on: ["e-intent"], card: MD_EVIL })];
  m.comments = [{ id: "c1", at: "2026-10-21T10:15:00Z", target: "t-e-title", text: EVIL, delivered: true, answered: false }];
  return m;
}

const agents = { "ag-1": { status: "running" as const, stepCount: 1, recent: [EVIL], final: EVIL } };

function assertNoMarkup(html: string, label: string) {
  assert.ok(!/<script/i.test(html), `${label}: <script survived`);
  assert.ok(!/<img/i.test(html), `${label}: <img survived`);
  // attribute-aware: look at attribute NAMES only, so escaped text inside a quoted value is not a false alarm
  for (const tag of html.match(/<[a-z][^>"']*(?:"[^"]*"|'[^']*'|[^>"'])*>/gi) ?? []) {
    const names = tag.replace(/"[^"]*"|'[^']*'/g, "").match(/\s[^\s=>\/]+/g) ?? [];
    assert.ok(!names.some((n) => /^\s*on/i.test(n)), `${label}: event-handler attribute in ${tag.slice(0, 120)}`);
  }
  assert.ok(!/href="\s*javascript:/i.test(html), `${label}: a javascript: href survived`);
  assert.equal((html.match(/<details/g) ?? []).length, (html.match(/<\/details>/g) ?? []).length, `${label}: unbalanced <details>`);
}

test("no payload becomes markup in any field, in the live block, the page or the trail", () => {
  const r = renderProject(evilModel(), agents, { ...opts, banner: { kind: "unreachable", text: EVIL } });
  assertNoMarkup(r.live, "live");
  assert.equal((r.page.match(/<script/g) ?? []).length, 1, "only the page's own script");
  assertNoMarkup(r.page.replace(/<script>[\s\S]*?<\/script>/, ""), "page");
  assertNoMarkup(trailHtml(evilModel().comments, "t-e-title", NOW), "trail");
  // escaped, not dropped: the text is still readable
  assert.ok(r.live.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(r.live.includes("&lt;img src=x onerror=alert(1)&gt;"));
  // the harmless link survives as a link, the javascript: one as plain text
  assert.ok(r.live.includes('<a href="http://fine.test">ok</a>'));
  assert.ok(r.live.includes("click"));
});

test("every field carries the payload: each one is checked on its own", () => {
  const base = evilModel();
  const fields: [string, (m: ProjectModel) => void][] = [
    ["project title", (m) => { m.tasks = []; m.archive = []; }],
    ["task title/intent/notes/card/asks", (m) => { m.title = "ok"; m.sections = []; }],
    ["sections", (m) => { m.tasks = []; m.archive = []; m.title = "ok"; }],
  ];
  for (const [name, cut] of fields) {
    const m = structuredClone(base);
    cut(m);
    const r = renderProject(m, agents, opts);
    assertNoMarkup(r.live, name + " live");
    assertNoMarkup(r.page.replace(/<script>[\s\S]*?<\/script>/, ""), name + " page");
  }
});

test("sections/*.html is the first mate's own and stays raw; sections/*.md never is", () => {
  const m = evilModel();
  m.sections = [{ name: "how", kind: "html", content: '<p class="mine">raw <b>ok</b></p>' }, { name: "flags", kind: "md", content: "<b>not raw</b>" }];
  const page = renderProject(m, agents, opts).page;
  assert.ok(page.includes('<p class="mine">raw <b>ok</b></p>'));
  assert.ok(page.includes("&lt;b&gt;not raw&lt;/b&gt;"));
});

test("the detector itself catches raw payloads (so a pass means something)", () => {
  for (const raw of ["<script>x</script>", "<img src=x>", '<b onclick="x">', '<a href="javascript:x">', "<details><summary>x</summary>"]) {
    assert.throws(() => assertNoMarkup(raw, "raw"), raw);
  }
  assert.doesNotThrow(() => assertNoMarkup('<b data-t="x onerror=y">a &lt;img&gt;</b>', "ok"));
});
