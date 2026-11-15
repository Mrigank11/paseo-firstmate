process.env.FM_DECK_POLL_MODE ??= "cli";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject, readTextCached, textCacheStats } from "../server/state.ts";
import { Deck } from "../server/runtime.ts";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector } from "../server/paseo-port.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an unchanged file is read once, a changed one is read again", () => {
  const d = mkdtempSync(join(tmpdir(), "deck-cache-"));
  const f = join(d, "card.md");
  writeFileSync(f, "one");
  const before = textCacheStats();
  assert.equal(readTextCached(f), "one");
  assert.equal(readTextCached(f), "one");
  assert.equal(readTextCached(f), "one");
  const s = textCacheStats();
  assert.equal(s.reads - before.reads, 1, "three loads, one disk read");
  writeFileSync(f, "two!");
  assert.equal(readTextCached(f), "two!", "a changed file is seen at once");
  writeFileSync(f, "TWO!"); // same size: only the mtime moves
  utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(readTextCached(f), "TWO!");
  assert.equal(readTextCached(join(d, "missing.md")), "", "missing is empty");
  writeFileSync(join(d, "missing.md"), "now");
  assert.equal(readTextCached(join(d, "missing.md")), "now", "a file that appears is seen");
});

test("loading a project twice reads each task card once", () => {
  const root = mkdtempSync(join(tmpdir(), "deck-cache-"));
  const state = join(root, "state");
  mkdirSync(join(state, "projects", "demo"), { recursive: true });
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, intent: "x", state: "active", project: "demo", since: "2026-11-01T00:00:00Z", asks: [] }));
  writeFileSync(join(state, "fleet.json"), JSON.stringify({ version: 2, tasks }));
  for (const t of tasks) { mkdirSync(join(state, "tasks", t.id), { recursive: true }); writeFileSync(join(state, "tasks", t.id, "card.md"), "card " + t.id); }
  loadProject(root, "demo");
  const a = textCacheStats().reads;
  loadProject(root, "demo");
  assert.equal(textCacheStats().reads - a, 0, "the second load reads nothing it already has");
});

// ---- the throttle ----

function deckWithCounter() {
  const exec = async (a: string[]) => { if (a[0] === "status") return JSON.stringify({ listen: "127.0.0.1:1", serverId: "s" }); throw new Error("no cli"); };
  const deck = new Deck({ exec, ports: new PortSelector(new CliPort(exec)), batchMs: 30, readConfig: async () => ({ root: "", firstmateLabel: "firstmate=true" }) });
  const times: number[] = [];
  (deck as any).render = async () => { times.push(Date.now()); };
  return { deck, times };
}

test("a burst of agent events renders at once, then once more at the end, not once per event", async () => {
  const { deck, times } = deckWithCounter();
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) { deck.scheduleRender("demo", 150, "agent"); await sleep(50); }
  await sleep(1500);
  assert.ok(times.length >= 2 && times.length <= 4, `rendered ${times.length} times for 20 events over 1 s`);
  assert.ok(times[0] - t0 < 400, "the first one is not held back");
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(gaps.every((g) => g >= 900), `renders are at least ~1 s apart: ${gaps}`);
  deck.stop();
});

test("an event that keeps arriving faster than the debounce still renders (no starvation)", async () => {
  const { deck, times } = deckWithCounter();
  for (let i = 0; i < 40; i++) { deck.scheduleRender("demo", 150, "canvas"); await sleep(60); }
  assert.ok(times.length >= 1, "rendered while events were still arriving");
  deck.stop();
});

test("comments, inbox changes and asks are never throttled", async () => {
  const { deck, times } = deckWithCounter();
  deck.scheduleRender("demo", 30, "agent");
  await sleep(100);
  const n = times.length;
  const t = Date.now();
  deck.scheduleRender("demo", 30, "comment");
  await sleep(120);
  assert.equal(times.length, n + 1, "a comment inside the gap still renders within ~30 ms");
  assert.ok(times.at(-1)! - t < 120);
  deck.scheduleRender("demo", 150, "fleet"); // fleet.json / card / asks changes: where an ask shows up
  await sleep(300);
  assert.equal(times.length, n + 2, "a fleet.json change inside the gap renders within the normal debounce");
  deck.stop();
});

test("an instant render supersedes a throttled one that is waiting", async () => {
  const { deck, times } = deckWithCounter();
  deck.scheduleRender("demo", 30, "agent"); await sleep(60);
  deck.scheduleRender("demo", 30, "agent"); // waits for the gap
  deck.scheduleRender("demo", 30, "comment");
  await sleep(150);
  assert.equal(times.length, 2, "the comment's render ran at once and covers the waiting one");
  await sleep(1200);
  assert.equal(times.length, 2, "nothing left over");
  deck.stop();
});
