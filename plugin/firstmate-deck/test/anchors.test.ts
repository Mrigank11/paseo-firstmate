process.env.TZ = "UTC";
// Comment anchors: the page stamps invisible ids inside task cards so Lavish's 5-level selector always reaches one,
// and the deck reads the owning task / canvas ask back out of it. The failing real-world case is comment
// c-mw3a8s80-64b25c on longitudehealth: "plan this option" on a bullet in the lh-ios-schemes-explainer canvas.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../server/state.ts";
import { renderProject } from "../server/render.ts";
import { extractTarget } from "../server/target.ts";
import { ANCHOR_JS, STAMP_ID } from "../server/anchors.ts";
import { pageScript } from "../server/page-script.ts";
import { formatMessage, newEntries } from "../server/relay.ts";
import { summary } from "./fake-canvas.ts";
import { El, lavishSelector, parse } from "./dom.ts";

const TASK = "lh-ios-schemes-explainer";
const OPTION_B = "Option B only: staging gets its own bundle id, name, icon and App Store Connect app, so both install side by side.";
const REAL_SELECTOR = "div:nth-of-type(4) > ul > li:nth-of-type(3) > div > p"; // from inbox.jsonl line 590

// The crew canvas card, shaped like agent-canvas's (article.canvas > div.sheet > div.md ...); the 4th div is the list block.
const CARD =
  `<div class="acv"><article class="canvas"><div class="sheet">` +
  `<div class="statusline"><div class="l1"><span class="badge ok">Done</span></div></div>` +
  `<div class="trow dimmable"><span class="title">Plan: a separate Shifu Staging app</span></div>` +
  `<div class="md"><h3 class="mdh2">Issue</h3><p>Staging and prod share one app identity.</p></div>` +
  `<div class="md"><ul>` +
  `<li><div><p><strong>Option A:</strong> keep one app.</p></div></li>` +
  `<li><div><p>Option C: a build flag.</p></div></li>` +
  `<li><div><p>${OPTION_B}</p><table><tbody><tr><td><code>bundle id</code></td><td>x</td></tr></tbody></table></div></li>` +
  `</ul></div>` +
  `<details class="fold"><summary>Evidence</summary><div class="md"><ol><li><div><p>one <em>two</em></p></div></li></ol><pre><code>npm test</code></pre></div></details>` +
  `</div></article></div>`;

let n = 0;
function render(asks: { id: string; question: string }[] = []) {
  const root = mkdtempSync(join(tmpdir(), "deck-anc-"));
  const pdir = join(root, "state", "projects", "demo");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo", sections: [] }));
  const T = { id: TASK, intent: "explain ios schemes", title: "Explainer: iOS schemes, prod vs staging", state: "active", since: "2026-10-24T10:00:00Z", project: "demo", shape: "scout" };
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: [T] }));
  const m = loadProject(root, "demo");
  const s = summary("ag-1", { openAsks: asks.map((a) => ({ id: a.id, question: a.question, blocking: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] })) });
  const r = renderProject(m, { "ag-1": { status: "running", stepCount: 1, recent: [], createdAt: "2026-10-24T11:00:00Z", updatedAt: "2026-10-24T11:59:00Z" } },
    { now: new Date("2026-10-24T12:00:00Z"), paseoAgentUrl: (id: string) => `http://paseo.test/${id}`, tickSeconds: 20,
      labeled: { [TASK]: [{ id: "ag-1", status: "running", archived: false, createdAt: "2026-10-24T11:00:00Z" }] },
      canvas: { status: "ok", css: "", summaries: { "ag-1": s }, cards: { "ag-1": CARD } } } as any);
  n++;
  return r.live;
}

/** Run the page script's anchor function (the real source, in a vm) on a parsed tree. */
const anchor = (root: El) => vm.runInNewContext(`${ANCHOR_JS};anchorIds(root)`, { root });
const known = { tasks: [TASK], agents: { "ag-1": TASK } };
const findP = (root: El, text: string) => root.all().find((e) => e.tagName === "P" && e.innerText.startsWith(text))!;

test("replay of c-mw3a8s80-64b25c: through Lavish's own selector it is 'page' before the fix and the task after", () => {
  const live = parse(render());
  const p = findP(live, "Option B only");
  const before = lavishSelector(p);
  assert.equal(before, REAL_SELECTOR, "the fixture reproduces the selector Lavish really recorded");
  assert.equal(extractTarget(before, known), "page", "BEFORE: nothing in the selector names the task");
  anchor(live);
  const after = lavishSelector(p);
  assert.match(after, /^(?:[a-z]+#k_t-lh-ios-schemes-explainer_[0-9-]+(?: > |$))/, "AFTER: the walk ends at a stamped id");
  assert.equal(extractTarget(after, known), `t-${TASK}`);
  // and the line the first mate receives
  const prompt = { prompt: "plan this option", selector: after, tag: "p", text: OPTION_B };
  const [e] = newEntries("longitudehealth", [prompt], known);
  assert.equal(e.target, `t-${TASK}`);
  const line = formatMessage("longitudehealth", [{ ...e, id: "c-mw3a8s80-64b25c" }], () => ({
    title: "Explainer: iOS schemes, prod vs staging", asks: [], canvasAsks: [{ id: "env1", text: "Which change should I plan next?" }],
  }));
  assert.match(line, /- \[t-lh-ios-schemes-explainer · "Explainer: iOS schemes, prod vs staging" · canvas ask env1: "Which change should I plan next\?"\] \(c-mw3a8s80-64b25c\) "plan this option"/);
});

test("the stamp is also what the page script applies to a payload (not only the helper)", () => {
  const live = parse(render());
  const liveEl: any = { ...live, children: live.children, set innerHTML(h: string) { /* fallback path */ } };
  const ctx = vm.createContext({
    document: { getElementById: (i: string) => (i === "live" ? liveEl : null), addEventListener() {}, querySelectorAll: () => [], createElement: () => ({ remove() {} }), head: { appendChild() {} }, activeElement: null },
    window: { name: "", scrollY: 0, scrollTo() {}, scrollBy() {}, addEventListener() {} }, location: { hash: "" }, localStorage: undefined, Date, JSON, Object, Math, Array, setInterval() {},
  });
  vm.runInContext(pageScript("p", "page.live.js", 1), ctx);
  assert.match(pageScript("p", "x", 1), /anchorIds\(nx\)/, "the morph path stamps the incoming block before the morph");
  assert.match(pageScript("p", "x", 1), /anchorIds\(el\)/, "the fallback path stamps after the swap");
});

test("every element in every task card is placeable on a task; ones inside a canvas ask box name the ask", () => {
  const live = parse(render([{ id: "env1", question: "Which change should I plan next?" }]));
  anchor(live);
  const cards = live.all().filter((e) => e.tagName === "ARTICLE" && e.id.startsWith("t-"));
  assert.equal(cards.length, 1);
  let checked = 0, onAsk = 0;
  for (const c of cards) for (const e of c.all()) {
    const target = extractTarget(lavishSelector(e), known);
    assert.notEqual(target, "page", `unplaceable: ${lavishSelector(e)}`);
    assert.ok(target === `t-${TASK}` || target.startsWith(`t-${TASK}#`), target);
    checked++;
    if (target === `t-${TASK}#c-env1`) onAsk++;
  }
  assert.ok(checked > 60, `walked ${checked} elements`);
  assert.ok(onAsk >= 5, `the raw ask box's own elements (${onAsk}) resolve to the canvas ask`);
  // a deep element inside the ask box (the option button's label sits below the box)
  const btn = live.all().find((e) => e.tagName === "BUTTON" && e.id.startsWith("o-"))!;
  assert.equal(extractTarget(lavishSelector(btn), known), `t-${TASK}#c-env1`);
});

test("works with PR #448's climb-until-unique selector too (stamped ids are unique)", () => {
  const live = parse(render());
  anchor(live);
  const ids = live.all().map((e) => e.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "ids are unique in the page");
  assert.ok(ids.some((i) => STAMP_ID.test(i)));
});

test("ids are stable: the same render stamps the same ids; a text edit moves none; elements that had an id keep it", () => {
  const ids = (html: string) => { const l = parse(html); anchor(l); return l.all().map((e) => e.id); };
  const a = ids(render());
  assert.deepEqual(ids(render()), a, "re-render, same ids");
  const l = parse(render()); anchor(l);
  assert.deepEqual(l.all().map((e) => e.id), a, "stamping twice, same ids");
  const h = render();
  assert.deepEqual(ids(h.replace(OPTION_B, "Option B: a different sentence.")), a, "a text change leaves every id alone");
  // existing ids survive and are not replaced
  const pre = ids(h.replace('<div class="sheet">', '<div class="sheet" id="mine">'));
  assert.ok(pre.includes("mine"));
  assert.ok(a.some((i) => i.startsWith("cvd-")), "the deck's own ids are kept");
});

test("changing one block changes the ids under it only", () => {
  const before = parse(render()); anchor(before);
  const html = render().replace('<div class="md"><h3 class="mdh2">Issue</h3>', '<div class="md"><h3 class="mdh2">Issue</h3><p>added</p><p>added too</p>');
  const after = parse(html); anchor(after);
  const after_ids = new Set(after.all().map((e) => e.id));
  const edited = before.all().find((e) => e.tagName === "DIV" && e.attrs.class === "md")!;
  const inside = new Set([edited, ...edited.all()]);
  const outside = before.all().filter((e) => !inside.has(e) && STAMP_ID.test(e.id));
  assert.ok(outside.length >= 5, "there are stamps outside the edited block");
  for (const e of outside) assert.ok(after_ids.has(e.id), `${e.id} survived`);
});

test("ids the deck and the canvas own do not hide the task: cvd-<agent>, cv-<agent>-… and option buttons resolve", () => {
  assert.equal(extractTarget("details#cvd-ag-1", known), `t-${TASK}`);
  assert.equal(extractTarget("details#cv-ag-1-now > summary", known), `t-${TASK}`);
  assert.equal(extractTarget("button#o-lh-ios-schemes-explainer-c-env1-2", known), `t-${TASK}#c-env1`);
  assert.equal(extractTarget("button#o-lh-ios-schemes-explainer-a3-1", known), `t-${TASK}#a3`);
  assert.equal(extractTarget("details#cvd-ag-9", known), "page", "an agent of no known task");
});

test("stamp ids parse back: the owner is everything before the last underscore", () => {
  assert.deepEqual(STAMP_ID.exec("k_a-t1-c-db_3-0-2")!.slice(1), ["a-t1-c-db", "3-0-2"]);
  assert.deepEqual(STAMP_ID.exec("k_a-t1-c-d_b_3-0")!.slice(1), ["a-t1-c-d_b", "3-0"]);
  assert.equal(STAMP_ID.exec("k_t-x"), null);
});
