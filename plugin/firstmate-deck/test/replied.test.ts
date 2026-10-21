import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../server/state.ts";

function root(otherStatus: string) {
  const r = mkdtempSync(join(tmpdir(), "deck-replied-"));
  mkdirSync(join(r, "state/projects/p"), { recursive: true });
  writeFileSync(join(r, "state/projects/p/project.json"), JSON.stringify({ title: "p", sections: [] }));
  writeFileSync(join(r, "state/fleet.json"), JSON.stringify({ tasks: [
    { id: "pick", project: "p", status: "done", asks: [{ text: "A or B?", since: "2026-10-21T09:00:00Z" }] },
    { id: "mockups", project: "p", status: otherStatus },
  ] }));
  writeFileSync(join(r, "state/projects/p/inbox.jsonl"),
    JSON.stringify({ id: "c1", at: "2026-10-21T09:05:00Z", target: "t-pick", text: "show me more" }) + "\n");
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
