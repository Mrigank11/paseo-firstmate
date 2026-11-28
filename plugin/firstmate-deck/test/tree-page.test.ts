process.env.TZ = "UTC";
// The page for a task tree: group cards with roll-up and chips, breadcrumbs, a tree section in the navigator, zoom. A project
// without groups renders exactly as before (render.test.ts snapshots that).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../server/state.ts";
import { renderProject } from "../server/render.ts";

function rig(extra: (state: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "tree-page-"));
  const state = join(root, "state");
  mkdirSync(join(state, "projects", "lh"), { recursive: true });
  mkdirSync(join(state, "tasks", "g"), { recursive: true });
  writeFileSync(join(state, "projects", "lh", "project.json"), JSON.stringify({ title: "Longitude" }));
  const t = (id: string, x: object = {}) => ({ id, intent: `do ${id}`, title: id.toUpperCase(), state: "active", since: "2026-10-21T09:00:00Z", project: "lh", shape: "ship", asks: [], ...x });
  writeFileSync(join(state, "fleet.json"), JSON.stringify({ version: 2, tasks: [
    t("g", { kind: "group", shape: "scout", title: "Iter 05" }),
    t("c1", { parent: "g", title: "PR one", asks: [{ id: "a1", text: "Pick a layout", since: "2026-10-21T09:30:00Z", options: ["A", "B"] }] }),
    t("c2", { parent: "g", title: "PR two" }),
    t("sub", { kind: "group", shape: "scout", parent: "g", title: "Memory" }),
    t("c3", { parent: "sub", title: "Design" }),
    t("solo", { title: "Loose task" }),
  ] }));
  writeFileSync(join(state, "fleet-archive.jsonl"), JSON.stringify({ id: "old", parent: "g", title: "Old PR", state: "done", outcome: "done", project: "lh", since: "2026-10-20T09:00:00Z" }) + "\n");
  writeFileSync(join(state, "tasks", "g", "card.md"), "Group card text: **BLUF** shipping PR one first.\n");
  extra(state);
  return root;
}
const labeled = { c2: [{ id: "ag-2", status: "running", archived: false, createdAt: "2026-10-21T10:00:00Z" }], solo: [{ id: "ag-s", status: "running", archived: false, createdAt: "2026-10-21T10:00:00Z" }] };
const agents = { "ag-2": { status: "running", stepCount: 1, recent: [] }, "ag-s": { status: "running", stepCount: 1, recent: [] } } as any;
const opts = { now: new Date("2026-10-21T10:15:30Z"), paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 20, labeled };
const render = (root: string) => renderProject(loadProject(root, "lh"), agents, opts);


test("a group is a one-line strip: name, bar, done/total, the asks below it, zoom. No chips, no child table, no child titles", () => {
  const live = render(rig()).live;
  assert.equal(live.split('id="t-g"').length - 1, 1);
  const card = live.slice(live.lastIndexOf("<article", live.indexOf('id="t-g"')), live.indexOf("</article>", live.indexOf('id="t-g"')));
  assert.match(card, /gcard/);
  assert.match(card, /<span class="gsn">Iter 05<\/span>/);
  assert.match(card, /class="gsc"[^>]*>1\/4</);
  assert.match(card, /<span class="gask">1 needs you<\/span>/);
  assert.match(card, /class="gz"[^>]*data-g="g"/);
  assert.doesNotMatch(card.slice(0, card.indexOf("<details")), /gchip|gchips|<table|PR one|PR two|Old PR|Design/, "no chips, no table, no child titles on the strip");
  assert.doesNotMatch(card, /<table|gchip/);
  assert.match(card, /<details class="cnotes gnote"[^>]*><summary>Notes<\/summary>[^]*Group card text:/, "the group's own text stays one click away");
});


test("groups are not stage cards: Needs you is one flat list first, then the strips, then the other lanes", () => {
  const live = render(rig()).live;
  const you = live.slice(live.indexOf('id="g-you"'), live.indexOf('id="g-groups"'));
  assert.ok(you.includes('id="t-c1"'), "the leaf's ask is in Needs you, before the groups section");
  assert.ok(!you.includes("gcard") && !you.includes('class="gh'), "Needs you is never clustered");
  assert.ok(live.indexOf('id="g-groups"') < live.indexOf('id="g-running"'));
  assert.match(live, /1 needs you/);
  assert.doesNotMatch(live, /2 needs you/, "the group does not count its leaf's ask a second time");
});

test("every task has exactly one card in the main view", () => {
  const live = render(rig()).live;
  for (const id of ["c1", "c2", "c3", "solo", "old"]) assert.equal(live.split(`id="t-${id}"`).length - 1, 1, id);
});

test("in the other lanes a group's tasks sit together under a slim header with their count; ungrouped come first", () => {
  const root = rig((state) => {
    const f = JSON.parse(readFileSync(join(state, "fleet.json"), "utf8"));
    f.tasks.push({ id: "c4", intent: "x", title: "PR four", state: "active", since: "2026-10-21T09:00:00Z", project: "lh", shape: "ship", asks: [], parent: "g" });
    writeFileSync(join(state, "fleet.json"), JSON.stringify(f));
  });
  const live = renderProject(loadProject(root, "lh"), { ...agents, "ag-4": { status: "running", stepCount: 1, recent: [] } } as any, { ...opts, labeled: { ...labeled, c4: [{ id: "ag-4", status: "running", archived: false, createdAt: "2026-10-21T10:00:00Z" }] } }).live;
  const lane = live.slice(live.indexOf('id="g-running"'), live.indexOf("</section>", live.indexOf('id="g-running"')));
  assert.ok(lane.indexOf('id="t-solo"') < lane.indexOf('class="gh"'), "ungrouped first");
  assert.match(lane, /<div class="gh" data-gh="g" data-in="g" data-quiet="0"[^>]*><button[^>]*aria-expanded="true"[^>]*>[^]*?<span class="ghn">Iter 05<\/span><\/button><span class="gn">2<\/span>/);
  assert.equal(lane.split('class="gh"').length - 1, 1, "one header for the run");
  assert.ok(lane.indexOf('class="gh"') < lane.indexOf('id="t-c2"') && lane.indexOf('id="t-c2"') < lane.indexOf('id="t-c4"'));
});

test("a group's strip never lists its done or parked children; in Done and Parked its header is folded and shows only a count", () => {
  const root = rig((state) => {
    const f = JSON.parse(readFileSync(join(state, "fleet.json"), "utf8"));
    const lines: string[] = [];
    for (let i = 1; i <= 14; i++) lines.push(JSON.stringify({ id: `d${i}`, parent: "g", title: `Finished ${i}`, state: "done", outcome: "done", project: "lh", since: "2026-10-20T09:00:00Z" }));
    for (let i = 1; i <= 4; i++) f.tasks.push({ id: `p${i}`, intent: "x", title: `Parked ${i}`, state: "parked", since: "2026-10-21T09:00:00Z", project: "lh", shape: "ship", asks: [], parent: "g" });
    writeFileSync(join(state, "fleet.json"), JSON.stringify(f));
    writeFileSync(join(state, "fleet-archive.jsonl"), lines.join("\n") + "\n");
  });
  const live = render(root).live; // group g now has 20 children: 14 done, 4 parked, c1 asks, c2 runs (+ c3 under sub)
  const strip = live.slice(live.lastIndexOf("<article", live.indexOf('id="t-g"')), live.indexOf("</article>", live.indexOf('id="t-g"')));
  assert.doesNotMatch(strip, /Finished|Parked \d/, "no done or parked child on the strip");
  assert.match(strip, /class="gsc"[^>]*>14\/\d+</);
  for (const lane of ["g-done", "g-parked"]) {
    const at = live.indexOf(`id="${lane}"`);
    const html = live.slice(at, live.indexOf(lane === "g-parked" ? 'id="g-done' : "</details>", at));
    assert.match(html, /<div class="gh gfold" data-gh="g"[^>]*data-quiet="1"[^>]*><button[^>]*aria-expanded="false"/, `${lane} header starts folded`);
    assert.equal(html.split('class="gh gfold"').length - 1, 1, `${lane}: one header over the whole run`);
  }
  assert.match(live.slice(live.indexOf('id="g-parked"')), /<span class="gn">4<\/span>/);
  assert.match(live.slice(live.indexOf('id="g-done"')), /<span class="gn">14<\/span>/, "all 14 finished tasks, as one count");
  const running = live.slice(live.indexOf('id="g-running"'), live.indexOf("</section>", live.indexOf('id="g-running"')));
  assert.match(running, /<div class="gh" data-gh="g"/, "open work stays open");
  assert.ok(live.includes('id="t-c1"') && live.includes('id="t-c2"'), "open work stays visible");
  assert.equal(live.split('id="t-d14"').length - 1, 1);
});

test("a child card carries a breadcrumb up to its group and the path it zooms by", () => {
  const live = render(rig()).live;
  const c3 = live.slice(live.indexOf('id="t-c3"'), live.indexOf("</article>", live.indexOf('id="t-c3"')));
  assert.match(c3, /<div class="crumb">Longitude<span class="sep"> › <\/span><a href="#t-g">Iter 05<\/a><span class="sep"> › <\/span><a href="#t-sub">Memory<\/a><\/div>/);
  assert.match(live.slice(live.indexOf('<article class="task'), live.indexOf('id="t-c3"') + 80), /data-in="g sub c3"/);
  const solo = live.slice(live.indexOf('id="t-solo"'), live.indexOf("</article>", live.indexOf('id="t-solo"')));
  assert.doesNotMatch(solo, /crumb|data-in/, "a top-level task is unchanged");
});


test("the navigator's Groups tree lists only groups (nested ones under their parent), never the tasks", () => {
  const live = render(rig()).live;
  const tn = live.slice(live.indexOf("data-tn>"), live.indexOf("</div>", live.indexOf('data-k="tree"') + 2000));
  const tree = tn.slice(tn.indexOf('data-k="tree"'), tn.indexOf('</ul></div>', tn.indexOf('data-k="tree"')));
  assert.match(tree, /data-k="tree" data-n="2" data-label="Groups"/);
  assert.match(tree, /data-t="t-g"[^>]*>Iter 05/);
  assert.match(tree, /<ul>[^]*data-t="t-sub"/);
  assert.doesNotMatch(tree, /data-t="t-(c1|c2|c3|solo)"/, "no task leaf in the tree");
  assert.match(live.slice(live.indexOf('data-k="running"')), /data-t="t-c2"/, "the task is in its stage list, once");
});

test("a project without groups has no tree section, crumbs or group cards", () => {
  const root = rig();
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: [{ id: "solo", intent: "x", state: "active", project: "lh", shape: "ship", asks: [], since: "2026-10-21T09:00:00Z" }] }));
  writeFileSync(join(root, "state", "fleet-archive.jsonl"), "");
  const live = render(root).live;
  assert.doesNotMatch(live, /gcard|class="crumb"|data-k="tree"|data-in=/);
});

test("a group with a second mate says so, and links its agent", () => {
  const root = rig((state) => writeFileSync(join(state, "tasks", "g", "claim.json"), JSON.stringify({ agentId: "sm-agent-1234" })));
  const live = render(root).live;
  assert.match(live, /second mate · <a [^>]*href="http:\/\/paseo\.test\/agent\/sm-agent-1234"/);
});

test("the group's own state is not counted as a needs-you item in the tab count", () => {
  const r = render(rig());
  assert.equal(r.attention.needsYou, 1);
});


test("fold: every strip has a fold control keyed by its group id; the tree has none and leaves have none", () => {
  const live = render(rig()).live;
  for (const g of ["g", "sub"]) assert.match(live, new RegExp(`class="gf" data-fold="${g}" aria-expanded="true"`));
  assert.ok(!/data-fold="c1"/.test(live), "leaves have no fold control");
  assert.ok(!/tn-fold/.test(live));
});

test("fold: an open ask under a group is counted on the group (card and tree node), nested groups included", () => {
  const live = render(rig()).live;
  const tn = live.slice(live.indexOf("data-tn>"));
  assert.match(tn, /data-g="g">[^]*?<span class="tn-ask" title="1 open ask below">1<\/span>/);
  assert.match(live, /<span class="gask">1 needs you<\/span>/);
  // the sub group holds only a running-less task, so it carries no marker
  assert.ok(!/data-g="sub">[^]*?<\/a>/.exec(tn)![0].includes("tn-ask"));
});

test("fold: the ask stays in the flat Needs you list, once, whatever is folded", () => {
  const live = render(rig()).live;
  const you = live.slice(live.indexOf('id="g-you"'), live.indexOf("</section>", live.indexOf('id="g-you"')));
  assert.equal((you.match(/id="t-c1"/g) ?? []).length, 1);
  assert.ok(!/gcard/.test(you));
});

test("fold: the nav script keeps the fold in a pref and re-applies it after every swap", async () => {
  const { navScript } = await import("../server/nav-script.ts");
  const js = navScript();
  assert.match(js, /__fdPref\("tn-f-"\+g,folded\(g\)\?0:1\)/);
  assert.match(js, /build\(html\)[^]*applyFold\(\)/);
  assert.match(js, /adopt\(\);applyFold\(\);unread/);
});


test("fold: a fold hides tasks only outside Needs you, so an ask is never hidden; cluster headers are toggles kept in prefs", async () => {
  const { navScript } = await import("../server/nav-script.ts");
  const js = navScript();
  assert.match(js, /#live \.grp:not\(#g-you\) \.task\[data-in~=/);
  assert.match(js, /__fdPref\("tn-f-"\+g,folded\(g\)\?0:1\)/);
  assert.match(js, /"gho-"\+/);
  assert.match(js, /\.gh:not\('\+sel\+'\)\{display:none\}/, "zoom hides other groups' headers too");
});
