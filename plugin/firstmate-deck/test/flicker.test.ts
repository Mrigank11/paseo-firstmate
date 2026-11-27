/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The flicker check: a live update must change only what changed. Runs the real page in Chrome (playwright-core) from a
// file:// URL, feeds it payloads through window.__fdLive exactly as page.live.js does, and asserts that scroll, folds,
// focus, selection and embedded canvas frames survive. Needs Chrome for Testing in ~/.cache/ms-playwright; it fails (not skips) when none can be launched. One browser at a time; XDG_CONFIG_HOME must be writable.
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { loadProject } from "../server/state.ts";
import { renderProject } from "../server/render.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agents = JSON.parse(readFileSync(join(here, "fixtures", "agents.json"), "utf8"));
const model = loadProject(join(here, "fixtures", "root"), "deck-demo");
const base = { now: new Date("2026-10-21T10:15:30Z"), paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 3600 };

// a done card carries an embedded canvas frame, as the live deck's "Final canvas" does
const PROBE = `<iframe id="probe" class="cv-final" srcdoc="&lt;p&gt;final canvas&lt;/p&gt;"></iframe>`;
// ...and the clock elements the browser fills: a running agent's start stamp (data-so) and a comment still "sending" (data-late)
const CLOCKS = () => `<span id="ck1" class="ck" data-so="${Date.now() - 95 * 60_000}"></span><span id="late1" class="st st-send" data-late="10000">sending…</span>`;
const withProbe = (live: string) => live.replace(/(<article [^>]*id="t-done-live"[^>]*>)/, `$1${PROBE}${CLOCKS()}`);
const payload = (m = model, now = base.now, edit = (s: string) => s) =>
  edit(withProbe(renderProject(m, agents, { ...base, now }).live));

// Playwright's own browser revision may not be the one installed; any cached Chrome for Testing build will do.
function chromeForTesting(): string | undefined {
  const dir = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(dir)) return undefined;
  const builds = readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  return builds.map((d) => join(dir, d, "chrome-linux64", "chrome")).find((p) => existsSync(p));
}

function launch(): Promise<Browser> {
  const xdg = join(tmpdir(), "deck-flicker-xdg");
  mkdirSync(xdg, { recursive: true });
  return chromium.launch({ executablePath: chromeForTesting(), env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? xdg } as Record<string, string> });
}

test("a live update morphs in place: frames, folds, scroll, focus and selection survive", async () => {
  const browser = await launch();
  try {
    const dir = mkdtempSync(join(tmpdir(), "deck-flicker-"));
    const first = renderProject(model, agents, base);
    writeFileSync(join(dir, "page.html"), first.page);
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, timezoneId: "UTC" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("file://" + join(dir, "page.html"));
    const push = (html: string, seq: number, iso = "2026-10-21T10:15:30Z") => page.evaluate(([h, s, i]) => (window as any).__fdLive(h, i, s), [html, seq, iso] as const);
    await push(payload(), 1);

    // set up the state a captain would have built up
    const handles = await page.evaluate(() => {
      const w = window as any, probe = document.getElementById("probe") as HTMLIFrameElement;
      w.__probe = probe; w.__loads = 0;
      probe.addEventListener("load", () => { w.__loads++; });
      const grp = document.getElementById("g-done") as HTMLDetailsElement;
      grp.open = true;
      document.body.style.minHeight = "6000px";
      window.scrollTo(0, 1500);
      const sum = grp.querySelector("summary") as HTMLElement; sum.focus();
      const target = document.querySelector("#t-pick-db .ttl") as HTMLElement;
      const range = document.createRange(); range.selectNodeContents(target);
      const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(range);
      w.__sel = sel.toString(); w.__sum = sum; w.__kids = [...document.getElementById("live")!.children]; w.__muts = [];
      new MutationObserver((rs) => { for (const r of rs) w.__muts.push(r); }).observe(document.getElementById("live")!, { subtree: true, childList: true, attributes: true, characterData: true });
      return { sel: w.__sel as string, scroll: window.scrollY };
    });
    await page.waitForTimeout(300); // let the iframe's first load and the toggle settle
    await page.evaluate(() => { (window as any).__loads = 0; (window as any).__muts.length = 0; });
    assert.ok(handles.scroll > 1000 && handles.sel.length > 0, "fixture prepared");

    // update 1: a task's text and the stamp change; the {TS} clock moves
    const later = new Date("2026-10-21T10:16:05Z");
    const m2 = structuredClone(model);
    m2.tasks.find((x) => x.id === "ship-api")!.title = "Freshly renamed task";
    await push(payload(m2, later, (s) => s.replace(/10:15:30/g, "10:16:05")), 2, "2026-10-21T10:16:05Z");
    // update 2: a card moves between stages' groups (pick-db answered away) and another payload with a closed fold
    const m3 = structuredClone(m2);
    m3.tasks = m3.tasks.filter((x) => x.id !== "write-docs");
    await push(payload(m3, later, (s) => s.replace(/10:15:30/g, "10:16:20")), 3, "2026-10-21T10:16:20Z");

    const after = await page.evaluate(() => {
      const w = window as any;
      const touched = w.__muts.map((r: MutationRecord) => (r.target as Node)).filter((n: Node) => w.__probe.contains(n) || n === w.__probe);
      const removedProbe = w.__muts.some((r: MutationRecord) => [...r.removedNodes].some((n) => n === w.__probe || (n as Element).contains?.(w.__probe)));
      return {
        sameFrame: document.getElementById("probe") === w.__probe, loads: w.__loads, open: (document.getElementById("g-done") as HTMLDetailsElement).open,
        scroll: window.scrollY, focus: document.activeElement === w.__sum, sel: getSelection()!.toString(), selKept: getSelection()!.toString() === w.__sel,
        touchedProbe: touched.length, removedProbe, muts: w.__muts.length, note: document.getElementById("live")!.textContent!.includes("Freshly renamed task"),
        kids: w.__kids.filter((k: Element) => k.isConnected).length >= w.__kids.length - 1,
        stamp: document.querySelector('[data-slot="stamp"]')!.textContent, so: document.getElementById("ck1")?.textContent ?? null, lateNow: document.getElementById("late1")?.classList.contains("st-late"), gone: !document.getElementById("t-write-docs"),
      };
    });
    assert.equal(after.sameFrame, true, "the canvas frame element is the same node");
    assert.equal(after.loads, 0, "the canvas frame did not reload");
    assert.equal(after.removedProbe, false);
    assert.equal(after.touchedProbe, 0, "nothing inside the frame's card subtree around it was rewritten");
    assert.equal(after.open, true, "the fold the captain opened stays open");
    assert.equal(after.scroll, handles.scroll, "scroll did not move");
    assert.equal(after.focus, true, "keyboard focus stayed on the same element");
    assert.equal(after.selKept, true, `text selection intact (was ${JSON.stringify(handles.sel.slice(0, 60))}, now ${JSON.stringify(after.sel.slice(0, 60))})`);
    assert.equal(after.note, true, "the change did arrive");
    assert.equal(after.gone, true, "a removed task left the page");
    assert.match(after.stamp ?? "", /2026-10-21 10:16 UTC/, "the shell stamp follows the payload");
    assert.match(after.so ?? "", /^1 h 3[5-7] min so far$/, "the browser writes a running agent's elapsed time from its start stamp");
    assert.equal(after.lateNow, false, "a comment that was just shown is not late yet (the browser flips it after data-late ms on screen)");
    assert.ok(after.muts > 0, "something changed");
    assert.equal(after.kids, true, "the groups of the task list are the same nodes (a swap would have replaced them all)");

    // the captain reads the done card: it moves to the Done fold. Later payloads must not move it back or reload it.
    await page.evaluate(() => (document.querySelector("#t-done-live button.mr") as HTMLElement).click());
    await page.waitForTimeout(300);
    await page.evaluate(() => { (window as any).__loads = 0; });
    await push(payload(m3, later, (s) => s.replace(/10:16:05/g, "10:17:00")), 4, "2026-10-21T10:17:00Z");
    const read = await page.evaluate(() => {
      const w = window as any;
      return { sameFrame: document.getElementById("probe") === w.__probe, loads: w.__loads, inDone: !!document.querySelector("#g-done #t-done-live"), inUnread: !!document.querySelector("#g-doneu #t-done-live") };
    });
    assert.deepEqual(read, { sameFrame: true, loads: 0, inDone: true, inUnread: false }, "a read card stays in Done and its frame is untouched by the next payload");
    assert.deepEqual(errors, [], "no page errors");
  } finally { await browser.close(); }
});
