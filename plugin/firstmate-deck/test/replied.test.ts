import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../server/state.ts";

const SINCE = "2026-10-21T09:00:00Z";

/** One task "pick" with one ask, plus an optional second task; comments are inbox lines. */
function world(opts: { pendingSince?: string; otherStatus?: string; comments?: object[]; asks?: object[] } = {}) {
  const r = mkdtempSync(join(tmpdir(), "deck-replied-"));
  mkdirSync(join(r, "state/projects/p"), { recursive: true });
  writeFileSync(join(r, "state/projects/p/project.json"), JSON.stringify({ title: "p", sections: [] }));
  const ask = { text: "A or B?", since: SINCE, ...(opts.pendingSince ? { pendingSince: opts.pendingSince } : {}) };
  writeFileSync(join(r, "state/fleet.json"), JSON.stringify({ tasks: [
    { id: "pick", project: "p", status: "needs-captain", asks: opts.asks ?? [ask] },
    { id: "mockups", project: "p", status: opts.otherStatus ?? "queued" },
  ] }));
  writeFileSync(join(r, "state/projects/p/inbox.jsonl"), (opts.comments ?? []).map((e) => JSON.stringify(e) + "\n").join(""));
  return r;
}
const c = (o: object) => ({ id: "c1", at: "2026-10-21T09:05:00Z", target: "t-pick#a1", text: "show me more", delivered: true, answered: false, ...o });
const ask = (r: string, n = 0) => loadProject(r, "p").tasks.find((t) => t.id === "pick")!.asks[n];

test("an UNANSWERED comment on the ask itself puts it with the first mate at once, whatever else is running", () => {
  for (const other of ["queued", "done", "running"]) {
    const a = ask(world({ otherStatus: other, comments: [c({})] }));
    assert.equal(a.repliedAt, "2026-10-21T09:05:00Z", other);
    assert.equal(a.replyText, "show me more");
    assert.equal(a.replyAnswered, false);
  }
});

test("a comment that is not delivered yet still counts (the reaction is immediate)", () => {
  assert.equal(ask(world({ comments: [c({ delivered: false })] })).repliedAt, "2026-10-21T09:05:00Z");
});

test("comments on the card body or steps (target t-<task>) never move an ask", () => {
  const a = ask(world({ otherStatus: "running", comments: [c({ target: "t-pick" }), c({ id: "c2", target: "t-pick", answered: true })] }));
  assert.equal(a.repliedAt, undefined);
});

test("comments on another ask of the same task, other tasks, sections and the page do not move this ask", () => {
  const a = ask(world({ comments: [c({ target: "t-pick#a2" }), c({ target: "t-mockups#a1" }), c({ target: "endpoints" }), c({ target: "page" })] }));
  assert.equal(a.repliedAt, undefined);
});

test("once the comment is answered and nothing is marked pending, the ask is the captain's again", () => {
  const a = ask(world({ otherStatus: "running", comments: [c({ answered: true })] }));
  assert.equal(a.repliedAt, undefined, "no 'something is running' guess: only an explicit pending mark keeps it");
});

test("answered, but the first mate marked it pending: it stays with the first mate and shows the reply", () => {
  const a = ask(world({ otherStatus: "done", pendingSince: "2026-10-21T09:08:00Z", comments: [c({ answered: true })] }));
  assert.equal(a.repliedAt, "2026-10-21T09:05:00Z");
  assert.equal(a.replyText, "show me more");
  assert.equal(a.replyAnswered, true);
  assert.equal(a.pendingSince, "2026-10-21T09:08:00Z");
});

test("pending with no comment to quote (marked by hand): with the first mate since the mark", () => {
  const a = ask(world({ pendingSince: "2026-10-21T09:08:00Z" }));
  assert.equal(a.repliedAt, "2026-10-21T09:08:00Z");
  assert.equal(a.replyText, undefined);
});

test("a newer unanswered comment after an answered one wins", () => {
  const a = ask(world({ comments: [c({ answered: true }), c({ id: "c2", at: "2026-10-21T09:30:00Z", text: "and one more thing" })] }));
  assert.equal(a.replyText, "and one more thing");
});

test("comments older than the ask (or older than a reask) are ignored", () => {
  assert.equal(ask(world({ comments: [c({ at: "2026-10-21T08:00:00Z" })] })).repliedAt, undefined);
});

test("a choice belongs to its own ask; options are loaded", () => {
  const asks = [
    { text: "First?", since: SINCE, options: ["A", "B"] },
    { text: "Second?", since: SINCE, options: ["only one"] },
  ];
  const r = world({ asks, comments: [c({ text: "Picked: B", choice: { ask: 1, option: "B" } })] });
  const got = loadProject(r, "p").tasks[0].asks;
  assert.deepEqual([got[0].replyChoice, got[0].repliedAt, got[1].repliedAt], ["B", "2026-10-21T09:05:00Z", undefined]);
  assert.deepEqual([got[0].options, got[1].options], [["A", "B"], undefined]);
});
