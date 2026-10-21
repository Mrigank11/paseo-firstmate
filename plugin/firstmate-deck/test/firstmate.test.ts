import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolveFirstMate } from "../server/paseo-cli.ts";

// fake `paseo` CLI: canned answers per subcommand, every call recorded
function fakeExec(labelled: object[], all: object[]) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "ls" && args.includes("--label")) return JSON.stringify(labelled);
    if (args[0] === "ls") return JSON.stringify(all);
    if (args[0] === "inspect") return JSON.stringify({ CreatedAt: "2026-10-21T09:00:00Z" });
    return "";
  };
  return { exec, calls };
}

test("a labelled first mate wins and nothing is relabelled", async () => {
  const f = fakeExec([{ id: "fm-1", status: "idle" }], [{ id: "x", status: "idle", cwd: "/root" }]);
  assert.deepEqual(await resolveFirstMate(f.exec, "firstmate=true", "/root"), { id: "fm-1", status: "idle" });
  assert.equal(f.calls.some((c) => c[0] === "agent"), false);
});

test("no label: the agent running in the checkout (~ expanded) is the first mate, and gets labelled", async () => {
  const root = `${homedir()}/projects/fm`;
  const f = fakeExec([], [
    { id: "crew", status: "running", cwd: "~/.paseo-deck/worktrees/abc/crew-x" },
    { id: "fm-ui", status: "idle", cwd: "~/projects/fm" },
  ]);
  assert.deepEqual(await resolveFirstMate(f.exec, "firstmate=true", root + "/"), { id: "fm-ui", status: "idle" });
  assert.deepEqual(f.calls.find((c) => c[0] === "agent"), ["agent", "update", "fm-ui", "--label", "firstmate=true"]);
});

test("no label and nothing in the checkout: null", async () => {
  const f = fakeExec([], [{ id: "crew", status: "running", cwd: "/elsewhere" }]);
  assert.equal(await resolveFirstMate(f.exec, "firstmate=true", "/root"), null);
});
