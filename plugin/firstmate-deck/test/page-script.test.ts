// The page script's stale-banner and focus logic, run in a vm with a fake clock and a minimal fake DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { pageScript } from "../server/page-script.ts";
import { CSS } from "../server/style.ts";
import { STALE_TEXT } from "../server/render.ts";

type Timer = { fn: () => void; every: number; next: number };

function boot(opts: { focusIn?: () => string | null } = {}) {
  let clock = 1_000_000;
  const timers: Timer[] = [];
  const banner: any = { hidden: true };
  const focused: string[] = []; // ids that received focus
  const fresh = new Map<string, any>(); // elements present after a swap, by id
  let active: any = null;
  const liveEl: any = {
    contains: (n: any) => n === active,
    querySelectorAll: () => [],
    set innerHTML(html: string) { liveEl._html = html; active = null; /* a swap drops the focused node */ },
  };
  const doc: any = {
    get activeElement() { return active; },
    addEventListener() {},
    getElementById: (id: string) => (id === "live" ? liveEl : id === "fd-stale" ? banner : fresh.get(id) ?? null),
    querySelectorAll: () => [],
    createElement: () => ({ remove() {} }),
    head: { appendChild() {} },
  };
  const win: any = { name: "", scrollY: 0, scrollTo() {} };
  const DateShim = { now: () => clock, parse: Date.parse };
  const ctx = vm.createContext({
    document: doc, window: win, location: { hash: "" }, localStorage: undefined, Date: DateShim, JSON, Object, Math, Array,
    setInterval: (fn: () => void, every: number) => { timers.push({ fn, every, next: clock + every }); return timers.length; },
  });
  vm.runInContext(pageScript("p", "page.live.js", 1), ctx);
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      clock = due.next; due.next += due.every; due.fn();
    }
    clock = end;
  };
  const focusable = (id: string) => ({ id, focus() { focused.push(id); active = this; }, tagName: "BUTTON" });
  return { win, banner, advance, liveEl, doc, fresh, focused, setActive: (n: any) => { active = n; }, focusable, now: () => clock };
}

test("M4: the banner measures time since the payload last CHANGED, on the browser's own clock", () => {
  const b = boot();
  b.advance(30_000);
  assert.equal(b.banner.hidden, true, "30 s after load: not stale");
  b.win.__fdLive("<p>a</p>", "2026-10-21T10:00:00.000Z", 1);
  b.advance(59_000);
  assert.equal(b.banner.hidden, true, "59 s since the last change");
  b.advance(7_000);
  assert.equal(b.banner.hidden, false, "more than 60 s with the same sequence number: stalled");
  b.win.__fdLive("<p>a</p>", "2026-10-21T10:00:20.000Z", 2); // the same html, but the plugin rendered again
  assert.equal(b.banner.hidden, true, "a new sequence number clears it, even if the content is identical");
});

test("M4: a repeated sequence number does not keep the page 'fresh'", () => {
  const b = boot();
  for (let i = 0; i < 8; i++) { b.win.__fdLive("<p>a</p>", "2026-10-21T10:00:00.000Z", 5); b.advance(10_000); }
  assert.equal(b.banner.hidden, false, "the browser keeps reloading live.js but the plugin's seq never moves");
});

test("M4: the daemon's timestamp is never compared with the browser's clock (skew in either direction is harmless)", () => {
  const b = boot();
  // browser clock 2 minutes ahead of the daemon: every payload looks 2 minutes old by its timestamp, yet it keeps changing
  for (let i = 1; i <= 6; i++) { b.win.__fdLive(`<p>${i}</p>`, new Date(b.now() - 120_000).toISOString(), i); b.advance(15_000); }
  assert.equal(b.banner.hidden, true, "no false alarm with a fast browser clock");
  // browser clock 10 minutes behind: timestamps look like the future, but a stall is still caught
  const c = boot();
  c.win.__fdLive("<p>1</p>", new Date(c.now() + 600_000).toISOString(), 1);
  c.advance(70_000);
  assert.equal(c.banner.hidden, false, "no hidden stall with a slow browser clock");
});

test("M4: an old payload without a sequence number falls back to its timestamp changing", () => {
  const b = boot();
  b.win.__fdLive("<p>a</p>", "2026-10-21T10:00:00.000Z");
  b.advance(70_000);
  assert.equal(b.banner.hidden, false);
  b.win.__fdLive("<p>a</p>", "2026-10-21T10:01:10.000Z");
  assert.equal(b.banner.hidden, true);
});

test("M4: a page whose live.js never loads is flagged after 60 s from page load", () => {
  const b = boot();
  b.advance(66_000); // the check runs every 5 s
  assert.equal(b.banner.hidden, false);
});

test("M4: the banner copy is captain-facing", () => {
  assert.equal(STALE_TEXT, "This page stopped updating. Your comments may not reach the first mate until it's fixed (the first mate can run bin/page heal).");
});

test("m1: keyboard focus on an element inside the live block survives a swap", () => {
  const b = boot();
  const btn = b.focusable("o-pick-a2-1");
  b.setActive(btn);
  const after = b.focusable("o-pick-a2-1"); // the same button, re-created by the swap
  b.fresh.set("o-pick-a2-1", after);
  b.win.__fdLive("<p>new</p>", "x", 1);
  assert.deepEqual(b.focused, ["o-pick-a2-1"], "focus is put back on the new node with the same id");
});

test("m1: a focused <summary> is restored through its <details> id; focus outside the live block is left alone", () => {
  const b = boot();
  const sum: any = { tagName: "SUMMARY", parentElement: { id: "s-t1" }, focus() { b.focused.push("sum"); } };
  b.setActive(sum);
  b.fresh.set("s-t1", { querySelector: (q: string) => (q === "summary" ? { focus() { b.focused.push("restored-summary"); } } : null) });
  b.win.__fdLive("<p>1</p>", "x", 1);
  assert.deepEqual(b.focused, ["restored-summary"]);
  const c = boot();
  c.setActive({ id: "outside", focus() {} });
  c.liveEl.contains = () => false; // focus is elsewhere on the page
  c.fresh.set("outside", c.focusable("outside"));
  c.win.__fdLive("<p>1</p>", "x", 1);
  assert.deepEqual(c.focused, []);
});

test("accessibility: 44 px touch targets, a pressed style at full contrast, parked grey >= 4.5:1", () => {
  assert.match(CSS, /button\.opt\{[^}]*min-height:44px/);
  assert.match(CSS, /button\.opt\[aria-pressed=true\]\{opacity:1;/);
  assert.ok(!/button\.opt\.on:disabled\{opacity:\.5/.test(CSS));
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const park = /--park:(#[0-9a-f]{6})/.exec(CSS)![1];
  for (const bg of ["#f7f6f2", "#f1efe8", "#ffffff"]) assert.ok(ratio(park, bg) >= 4.5, `${park} on ${bg} = ${ratio(park, bg).toFixed(2)}`);
  assert.ok(ratio("#ffffff", "#b4410c") >= 4.5, "the pressed option: white on the accent");
});

test("every live swap asks the task navigator to rebuild", () => {
  const b = boot();
  let n = 0;
  b.win.__tn = () => { n++; };
  b.win.__fdLive("<p>a</p>", "2026-10-21T10:00:00.000Z", 1);
  assert.equal(n, 1);
  b.win.__fdLive("<p>b</p>", "2026-10-21T10:00:01.000Z", 2);
  assert.equal(n, 2);
  b.win.__tn = () => { throw new Error("boom"); };
  assert.doesNotThrow(() => b.win.__fdLive("<p>c</p>", "2026-10-21T10:00:02.000Z", 3), "a navigator error never breaks the live swap");
});

test("a page preference (the navigator's fold) is kept in the page state and survives a reload without localStorage", () => {
  const run = (name: string) => {
    const win: any = { name, scrollY: 0, scrollTo() {} };
    const doc: any = { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ remove() {} }), head: { appendChild() {} } };
    vm.runInContext(pageScript("p", "page.live.js", 1), vm.createContext({ document: doc, window: win, location: { hash: "" }, localStorage: undefined, Date, JSON, Object, Math, Array, setInterval: () => 0 }));
    return win;
  };
  const a = run("");
  assert.equal(a.__fdPref("tn-exp"), undefined);
  a.__fdPref("tn-exp", 0);
  const b = run(a.name); // Lavish reloads the iframe: same browsing context, same window.name
  assert.equal(b.__fdPref("tn-exp"), 0);
});
