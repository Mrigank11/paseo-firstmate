process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, type ProjectModel } from "../server/state.ts";
import { renderProject, trailHtml } from "../server/render.ts";
import { pageScript } from "../server/page-script.ts";
import { classifyPoll, decodePoll } from "../server/toon.ts";
import { formatMessage, newEntries, parseChoice } from "../server/relay.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-21T10:15:30Z");
const opts = { now: NOW, paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 1 };
const base = loadProject(join(here, "fixtures", "root"), "deck-demo");
const c = (o: object) => ({ id: "c", at: "2026-10-21T10:15:00Z", target: "t-x", text: "hello", delivered: false, answered: false, ...o });

test("trail: sending (fresh), sending (late, amber), first mate has it, answered", () => {
  const fresh = trailHtml([c({ at: "2026-10-21T10:15:25Z" })], "t-x", NOW);
  assert.match(fresh, /💬 You · 10:15<\/span>/);
  assert.match(fresh, /“hello”/);
  assert.match(fresh, /class="st st-send">sending…/);
  assert.match(trailHtml([c({ at: "2026-10-21T10:15:00Z" })], "t-x", NOW), /class="st st-late">sending…/);
  assert.match(trailHtml([c({ delivered: true })], "t-x", NOW), /class="st st-has">first mate has it/);
  assert.match(trailHtml([c({ delivered: true, answered: true })], "t-x", NOW), /class="st st-answered">answered/);
});

test("trail: latest wins, count shown, text cut at 100, other targets ignored, 24 h rule", () => {
  const long = "w".repeat(300);
  const h = trailHtml([c({ id: "1", at: "2026-10-21T09:00:00Z", text: "old" }), c({ id: "2", text: long }), c({ target: "t-y", text: "elsewhere" })], "t-x", NOW);
  assert.ok(!h.includes("old") && !h.includes("elsewhere"));
  assert.match(h, /2 comments/);
  assert.ok(h.includes("w".repeat(90)) && !h.includes("w".repeat(101)));
  const stale = c({ at: "2026-10-19T10:00:00Z", delivered: true, answered: true });
  assert.equal(trailHtml([stale], "t-x", NOW), "");
  assert.match(trailHtml([{ ...stale, answered: false }], "t-x", NOW), /first mate has it/);
  assert.match(trailHtml([c({ choice: { ask: 1, option: "B live" } })], "t-x", NOW), /picked <b>B live<\/b>/);
});

test("trail renders on the card, and sections/page via slots filled by the script", () => {
  const m: ProjectModel = { ...structuredClone(base), comments: [
    { id: "1", at: "2026-10-21T10:10:00Z", target: "t-ship-api", text: "card note", delivered: true, answered: false },
    { id: "2", at: "2026-10-21T10:11:00Z", target: "endpoints", text: "section note", delivered: false, answered: false },
    { id: "3", at: "2026-10-21T10:12:00Z", target: "page", text: "page note", delivered: true, answered: true },
  ] };
  const r = renderProject(m, {}, opts);
  const card = r.live.slice(r.live.indexOf('id="t-ship-api"'));
  assert.match(card.slice(0, 600), /card note/);
  assert.match(r.live, /<div data-trail-for="endpoints"><div class="trail">.*section note/);
  assert.match(r.live, /<div data-trail-for="page">.*page note/);
  assert.match(r.page, /<section id="endpoints"[^>]*><h2>[^<]*<\/h2>\n<div class="trail-slot" data-trail-slot="endpoints">/);
  assert.match(r.page, /<div class="trail-slot" data-trail-slot="page">/);
  assert.match(r.live, /checked every second/);
});

test("comments do not move the page signature (no page reload per comment)", () => {
  const a = renderProject(base, {}, opts).signature;
  const b = renderProject({ ...structuredClone(base), comments: [{ id: "z", at: "2026-10-21T10:00:00Z", target: "page", text: "x", delivered: false, answered: false }] }, {}, opts).signature;
  assert.equal(a, b);
});

test("options render as real buttons with a hint; picked card shows the choice", () => {
  const m = structuredClone(base);
  const t = m.tasks.find((x) => x.id === "ask-fm")!;
  t.asks[0] = { text: "Layout?", contextMd: "", options: ["A index card", "B live <console>", "C status board"] };
  let live = renderProject(m, {}, opts).live;
  assert.equal((live.match(/<button type="button" class="opt"/g) ?? []).length, 3);
  assert.match(live, /data-task="ask-fm" data-ask="1" data-opt="B live &lt;console&gt;"/);
  assert.match(live, /or comment on the card/);
  assert.match(live, /data-key="ask-ask-fm-1"/);
  t.asks[0] = { ...t.asks[0], repliedAt: "2026-10-21T09:10:00Z", replyText: "Picked: B", replyChoice: "B live <console>", replyAnswered: false };
  live = renderProject(m, {}, opts).live;
  const fm = live.slice(live.indexOf('id="g-fm"'), live.indexOf('id="g-running"'));
  assert.ok(fm.includes('id="t-ask-fm"'));
  assert.match(fm, /You picked <b>B live &lt;console&gt;<\/b> · the first mate is applying it/);
  assert.ok(!fm.includes('class="opt"'));
});

test("page script: 1 s reload, lavish guard, optimistic map, queuePrompt + send", () => {
  const js = pageScript("p", "page.live.js", 1);
  assert.match(js, /setInterval\(tick,1000\)/);
  assert.match(js, /open this page in Lavish to answer/);
  assert.match(js, /kind:"ask-choice"/);
  assert.match(js, /sendQueuedPrompts/);
  assert.doesNotThrow(() => new Function(js));
});

test("page script in a fake DOM: click marks optimistically, queues, sends, survives a swap", () => {
  // minimal DOM: just enough of the surface the script's click handler and swap re-apply touch
  const mkBtn = (opt: string) => {
    const attrs: Record<string, string> = { "data-task": "pick-db", "data-ask": "1", "data-opt": opt, "data-title": "Pick DB" };
    const b: any = { disabled: false, attrs, getAttribute: (k: string) => attrs[k], setAttribute: (k: string, v: string) => (attrs[k] = v), classList: { on: false, toggle(_c: string, on: boolean) { this.on = on; }, remove() { this.on = false; } } };
    return b;
  };
  const btns = [mkBtn("A"), mkBtn("B")];
  const line: any = { hidden: true, textContent: "" };
  const box: any = { getAttribute: () => "ask-pick-db-1", querySelectorAll: () => btns, querySelector: () => line };
  const card = {};
  btns.forEach((b) => { b.closest = (sel: string) => (sel === ".opts" ? box : card); });
  let click: ((e: any) => void) | undefined;
  const liveEl: any = { querySelectorAll: (s: string) => (s === ".opts[data-key]" ? [box] : []), set innerHTML(_v: string) {} };
  const doc: any = {
    addEventListener: (ev: string, fn: any) => { if (ev === "click") click = fn; },
    getElementById: (id: string) => (id === "live" ? liveEl : null),
    querySelectorAll: () => [], createElement: () => ({}), head: { appendChild() {} },
  };
  const queued: any[] = []; let sent = 0;
  const win: any = { name: "", scrollY: 0, scrollTo() {}, lavish: { queuePrompt: (p: string, o: any) => queued.push([p, o]), sendQueuedPrompts: () => { sent++; } } };
  const js = pageScript("p", "page.live.js", 1);
  new Function("document", "window", "location", "localStorage", "setInterval", js)(doc, win, { hash: "" }, undefined, () => 0);
  click!({ target: { closest: (s: string) => (s === "button.opt" ? btns[1] : null) } });
  assert.equal(btns[0].disabled && btns[1].disabled, true);
  assert.equal(btns[1].classList.on, true);
  assert.equal(btns[0].classList.on, false);
  assert.equal(line.textContent, "You picked B · sending…");
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0], "Picked: B");
  assert.deepEqual(queued[0][1].data, { kind: "ask-choice", task: "pick-db", ask: 1, option: "B" });
  assert.equal(queued[0][1].queueKey, "ask-pick-db-1");
  assert.equal(queued[0][1].tag, "choice");
  assert.equal(queued[0][1].text, "Pick DB: B");
  assert.equal(queued[0][1].element, card);
  assert.equal(sent, 1);
  // a live swap brings fresh, enabled buttons: the pick is re-applied
  btns.forEach((b) => { b.disabled = false; b.classList.on = false; }); line.hidden = true; line.textContent = "";
  win.__fdLive("<p>new</p>");
  assert.equal(btns[1].classList.on && btns[0].disabled, true);
  assert.equal(line.textContent, "You picked B · sending…");
  // outside Lavish: no pick, a hint instead
  btns.forEach((b) => { b.disabled = false; b.classList.on = false; }); line.textContent = "";
  delete win.lavish; queued.length = 0;
  click!({ target: { closest: (s: string) => (s === "button.opt" ? btns[0] : null) } });
  assert.equal(line.textContent, "open this page in Lavish to answer");
  assert.equal(btns[0].disabled, false);
  assert.equal(queued.length, 0);
});

test("ask-choice parsed from a realistic poll prompt (lavish folds data into the prompt text)", async () => {
  const o = classifyPoll(await decodePoll(readFileSync(join(here, "fixtures", "feedback_choice.toon"), "utf8")));
  assert.equal(o.prompts.length, 1);
  const parsed = parseChoice(o.prompts[0])!;
  assert.deepEqual(parsed.choice, { task: "pick-db", ask: 1, option: "B live console" });
  assert.equal(parsed.text, "Picked: B live console");
  const [e] = newEntries("deck-demo", o.prompts, { tasks: ["pick-db"] }, new Date("2026-10-21T10:00:00Z"), (t, n) => (t === "pick-db" && n === 1 ? "Postgres or SQLite?" : undefined));
  assert.equal(e.target, "t-pick-db");
  assert.equal(e.text, "Picked: B live console");
  assert.deepEqual(e.choice, { task: "pick-db", ask: 1, option: "B live console", askText: "Postgres or SQLite?" });
});

test("choice parsing rejects malformed data and also reads a separate data field", () => {
  assert.equal(parseChoice({ prompt: "hi" }), null);
  assert.equal(parseChoice({ prompt: "x\n\nContext data:\n{not json" }), null);
  assert.equal(parseChoice({ prompt: "x", data: { kind: "ask-choice", task: "../evil", ask: 1, option: "A" } }), null);
  assert.equal(parseChoice({ prompt: "x", data: { kind: "ask-choice", task: "ok", ask: 0, option: "A" } }), null);
  assert.deepEqual(parseChoice({ prompt: "x", data: { kind: "ask-choice", task: "ok", ask: 2, option: "A" } })!.choice, { task: "ok", ask: 2, option: "A" });
});

test("relay message names the choice and how to apply it", () => {
  const msg = formatMessage("deck-demo", [
    { target: "endpoints", text: "a note", choice: undefined },
    { target: "t-pick-db", text: "Picked: B", choice: { task: "pick-db", ask: 1, option: "B live console", askText: "Postgres\nor SQLite?" } },
  ]);
  assert.equal(msg, [
    "## Page comments · deck-demo",
    '- [endpoints] "a note"',
    '- [t-pick-db] picked option "B live console" for ask 1 ("Postgres or SQLite?")',
    'Reply with: bin/page reply deck-demo "<your reply>"',
    "Apply with: bin/fleet answer pick-db 1, then act on it.",
  ].join("\n"));
});
