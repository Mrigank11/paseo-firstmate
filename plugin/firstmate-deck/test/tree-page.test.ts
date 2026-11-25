process.env.TZ = "UTC";
// The page for a task tree: group cards with roll-up and chips, breadcrumbs, a tree section in the navigator, zoom. A project
// without groups renders exactly as before (render.test.ts snapshots that).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("a group card shows the rolled-up stage, counts, chips for its children and its card text", () => {
  const live = render(rig()).live;
  assert.equal(live.split('id="t-g"').length - 1, 1);
  const card = live.slice(live.lastIndexOf("<article", live.indexOf('id="t-g"')), live.indexOf("</article>", live.indexOf('id="t-g"')));
  assert.match(card, /gcard/);
  assert.match(card, /Needs you/);
  assert.match(card, /1 of 4 done/);
  assert.match(card, /1 needs you/);
  assert.match(card, /<a class="gchip[^"]*" href="#t-c1">PR one<\/a>/);
  assert.match(card, /<a class="gchip[^"]*" href="#t-sub">Memory/);
  assert.match(card, /Group card text:/);
  assert.match(card, /class="gz"[^>]*data-g="g"/);
});

test("groups are not stage cards: the stage groups hold only tasks, and Needs you stays one flat list across the tree", () => {
  const live = render(rig()).live;
  const you = live.slice(live.indexOf('id="g-you"'), live.indexOf('id="g-running"'));
  assert.ok(you.includes('id="t-c1"'), "the leaf's ask is in Needs you");
  assert.ok(!you.includes('id="t-g"') && !live.slice(live.indexOf('id="g-running"')).includes('id="t-g"'));
  assert.match(live, /1 needs you/);
  assert.doesNotMatch(live, /2 needs you/, "the group does not count its leaf's ask a second time");
  assert.equal(live.split('id="t-c1"').length - 1, 1);
});

test("a child card carries a breadcrumb up to its group and the path it zooms by", () => {
  const live = render(rig()).live;
  const c3 = live.slice(live.indexOf('id="t-c3"'), live.indexOf("</article>", live.indexOf('id="t-c3"')));
  assert.match(c3, /<div class="crumb">Longitude<span class="sep"> › <\/span><a href="#t-g">Iter 05<\/a><span class="sep"> › <\/span><a href="#t-sub">Memory<\/a><\/div>/);
  assert.match(live.slice(live.indexOf('<article class="task'), live.indexOf('id="t-c3"') + 80), /data-in="g sub c3"/);
  const solo = live.slice(live.indexOf('id="t-solo"'), live.indexOf("</article>", live.indexOf('id="t-solo"')));
  assert.doesNotMatch(solo, /crumb|data-in/, "a top-level task is unchanged");
});

test("the navigator template gains a tree section: groups with their children, nested", () => {
  const live = render(rig()).live;
  const tn = live.slice(live.indexOf("data-tn>"), live.indexOf("</div>", live.indexOf('data-k="tree"') + 2000));
  assert.match(tn, /class="tn-st t-tree" data-k="tree" data-n="2" data-label="Groups"/);
  assert.match(tn, /data-t="t-g"[^>]*>Iter 05/);
  assert.match(tn, /<ul>[^]*data-t="t-sub"[^]*data-t="t-c3"/);
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
