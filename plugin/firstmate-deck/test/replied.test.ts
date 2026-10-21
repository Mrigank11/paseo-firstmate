import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../server/state.ts";

function root(otherStatus: string, answered = true, extra: object[] = []) {
  const r = mkdtempSync(join(tmpdir(), "deck-replied-"));
  mkdirSync(join(r, "state/projects/p"), { recursive: true });
  writeFileSync(join(r, "state/projects/p/project.json"), JSON.stringify({ title: "p", sections: [] }));
  writeFileSync(join(r, "state/fleet.json"), JSON.stringify({ tasks: [
    { id: "pick", project: "p", status: "done", asks: [{ text: "A or B?", since: "2026-10-21T09:00:00Z" }] },
    { id: "mockups", project: "p", status: otherStatus },
  ] }));
  writeFileSync(join(r, "state/projects/p/inbox.jsonl"),
    [{ id: "c1", at: "2026-10-21T09:05:00Z", target: "t-pick", text: "show me more", delivered: true, answered }, ...extra]
      .map((e) => JSON.stringify(e) + "\n").join(""));
  return r;
}

test("a replied ask stays with the first mate while follow-up work runs", () => {
  const m = loadProject(root("running"), "p");
  assert.equal(m.tasks.find((t) => t.id === "pick")!.asks[0].repliedAt, "2026-10-21T09:05:00Z");
});

test("with nothing dispatched or running, a replied ask is the captain's again", () => {
  const m = loadProject(root("done"), "p");
  assert.equal(m.tasks.find((t) => t.id === "pick")!.asks[0].repliedAt, undefined);
});

test("an UNANSWERED comment is with the first mate even with nothing running", () => {
  const a = loadProject(root("done", false), "p").tasks.find((t) => t.id === "pick")!.asks[0];
  assert.equal(a.repliedAt, "2026-10-21T09:05:00Z");
  assert.equal(a.replyAnswered, false);
});

test("an answered comment with work still running stays with the first mate", () => {
  const a = loadProject(root("dispatched", true), "p").tasks.find((t) => t.id === "pick")!.asks[0];
  assert.equal(a.repliedAt, "2026-10-21T09:05:00Z");
  assert.equal(a.replyAnswered, true);
});

test("a newer unanswered comment after an answered one wins, even when idle", () => {
  const r = root("done", true, [{ id: "c2", at: "2026-10-21T09:30:00Z", target: "t-pick", text: "and one more thing", delivered: false, answered: false }]);
  const a = loadProject(r, "p").tasks.find((t) => t.id === "pick")!.asks[0];
  assert.equal(a.replyText, "and one more thing");
});

test("a choice belongs to its own ask; options are loaded", () => {
  const r = mkdtempSync(join(tmpdir(), "deck-choice-"));
  mkdirSync(join(r, "state/projects/p"), { recursive: true });
  writeFileSync(join(r, "state/projects/p/project.json"), JSON.stringify({ title: "p", sections: [] }));
  writeFileSync(join(r, "state/fleet.json"), JSON.stringify({ tasks: [
    { id: "pick", project: "p", status: "needs-captain", asks: [
      { text: "First?", since: "2026-10-21T09:00:00Z", options: ["A", "B"] },
      { text: "Second?", since: "2026-10-21T09:00:00Z", options: ["only one"] },
    ] },
  ] }));
  writeFileSync(join(r, "state/projects/p/inbox.jsonl"),
    JSON.stringify({ id: "c1", at: "2026-10-21T09:05:00Z", target: "t-pick", text: "Picked: B", choice: { ask: 1, option: "B" }, delivered: true, answered: false }) + "\n");
  const asks = loadProject(r, "p").tasks[0].asks;
  assert.deepEqual([asks[0].replyChoice, asks[1].repliedAt], ["B", undefined]);
  assert.deepEqual([asks[0].options, asks[1].options], [["A", "B"], undefined]);
});
