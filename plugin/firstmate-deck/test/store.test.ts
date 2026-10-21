import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInbox, patchPageJson, readInbox, readPageJson, updateInbox, type InboxEntry } from "../server/store.ts";

const entry = (id: string, over: Partial<InboxEntry> = {}): InboxEntry => ({
  id, at: "2026-10-21T10:00:00Z", project: "p", target: "page", text: id, prompt: { prompt: id }, delivered: false, answered: false, ...over,
});

test("inbox append is one line per entry and survives bad lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-store-"));
  const f = join(dir, "inbox.jsonl");
  assert.deepEqual(readInbox(f), []);
  appendInbox(f, [entry("a"), entry("b")]);
  appendInbox(f, [entry("c")]);
  assert.equal(readFileSync(f, "utf8").trim().split("\n").length, 3);
  assert.deepEqual(readInbox(f).map((e) => e.id), ["a", "b", "c"]);
  assert.equal(existsSync(f + ".lock"), false, "lock released");
});

test("updateInbox rewrites atomically and reports how many changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-store-"));
  const f = join(dir, "inbox.jsonl");
  appendInbox(f, [entry("a"), entry("b", { delivered: true }), entry("c", { delivered: true, answered: true })]);
  const n = updateInbox(f, (e) => { if (e.delivered && !e.answered) e.answered = true; });
  assert.equal(n, 1);
  assert.deepEqual(readInbox(f).map((e) => [e.id, e.delivered, e.answered]), [["a", false, false], ["b", true, true], ["c", true, true]]);
  assert.equal(updateInbox(f, () => {}), 0);
});

test("page.json patches merge and keep unknown keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-store-"));
  const f = join(dir, "page.json");
  assert.equal(readPageJson(f).session, "unknown");
  patchPageJson(f, { session: "open" });
  assert.equal(existsSync(f), false, "no project.json: a deleted project's page.json is never recreated");
  writeFileSync(join(dir, "project.json"), "{}");
  patchPageJson(f, { lavishUrl: "http://x/s/1", session: "open" });
  patchPageJson(f, { undelivered: 2, lastDelivery: "t" });
  const pj = readPageJson(f);
  assert.deepEqual([pj.lavishUrl, pj.session, pj.undelivered, pj.lastDelivery], ["http://x/s/1", "open", 2, "t"]);
});
