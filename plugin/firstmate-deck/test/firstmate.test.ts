import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliPort } from "../server/paseo-cli.ts";
import { NoFirstMateError, PortSelector, resolveFirstMate, sendToFirstMate } from "../server/paseo-port.ts";

// A checkout with optional claim, live fleet tasks and archive lines.
function checkout(o: { claim?: string; crew?: string[]; archived?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deck-fm-"));
  mkdirSync(join(root, "state"), { recursive: true });
  if (o.claim) writeFileSync(join(root, "state", "firstmate.json"), JSON.stringify({ agentId: o.claim, claimedAt: "2026-10-21T08:00:00Z" }));
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ tasks: (o.crew ?? []).map((agentId, i) => ({ id: `t${i}`, agentId })) }));
  if (o.archived) writeFileSync(join(root, "state", "fleet-archive.jsonl"), o.archived.map((agentId, i) => JSON.stringify({ id: `a${i}`, agentId }) + "\n").join(""));
  return root;
}

// fake `paseo` CLI: `ls` (no label) lists live agents, `ls --label` the labelled ones; every call recorded
function fakeExec(all: { id: string; status: string; created?: string }[], labelled: string[]) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "ls" && args.includes("--label")) return JSON.stringify(all.filter((a) => labelled.includes(a.id)));
    if (args[0] === "ls") return JSON.stringify(all);
    if (args[0] === "inspect") return JSON.stringify({ CreatedAt: all.find((a) => a.id === args[1])?.created ?? "2026-10-21T09:00:00Z" });
    return "";
  };
  return { exec, calls };
}

test("the claimed agent wins over any label, and nothing is ever relabelled", async () => {
  const root = checkout({ claim: "fm-new" });
  const f = fakeExec([{ id: "fm-new", status: "idle" }, { id: "fm-old", status: "idle", created: "2026-10-22T00:00:00Z" }], ["fm-old"]);
  assert.deepEqual(await resolveFirstMate(new CliPort(f.exec), "firstmate=true", root), { id: "fm-new", status: "idle" });
  assert.equal(f.calls.some((c) => c[0] === "agent"), false);
});

test("a stale label loses to the claim", async () => {
  const root = checkout({ claim: "fm-new" });
  const f = fakeExec([{ id: "fm-old", status: "idle" }, { id: "fm-new", status: "running" }], ["fm-old"]);
  assert.equal((await resolveFirstMate(new CliPort(f.exec), "firstmate=true", root))?.id, "fm-new");
});

test("a claim whose agent is gone (archived) falls back to the label", async () => {
  const root = checkout({ claim: "fm-gone" });
  const f = fakeExec([{ id: "fm-labelled", status: "idle" }], ["fm-labelled"]);
  assert.equal((await resolveFirstMate(new CliPort(f.exec), "firstmate=true", root))?.id, "fm-labelled");
});

test("without a claim, the newest live labelled agent wins and a crew id carrying the label is excluded", async () => {
  const root = checkout({ crew: ["scout-1"], archived: ["scout-0"] });
  const f = fakeExec([
    { id: "scout-1", status: "idle", created: "2026-10-21T12:00:00Z" },
    { id: "scout-0", status: "idle", created: "2026-10-21T11:00:00Z" },
    { id: "fm-a", status: "idle", created: "2026-10-21T08:00:00Z" },
    { id: "fm-b", status: "idle", created: "2026-10-21T09:00:00Z" },
  ], ["scout-1", "scout-0", "fm-a", "fm-b"]);
  assert.equal((await resolveFirstMate(new CliPort(f.exec), "firstmate=true", root))?.id, "fm-b");
});

test("no claim and no label: null, even when an agent runs in the checkout", async () => {
  const root = checkout();
  const f = fakeExec([{ id: "scout", status: "running" }], []);
  assert.equal(await resolveFirstMate(new CliPort(f.exec), "firstmate=true", root), null);
  assert.equal(f.calls.some((c) => c[0] === "agent"), false, "no auto-labelling");
});

test("a label held only by crew resolves to null", async () => {
  const root = checkout({ crew: ["scout-1"] });
  const f = fakeExec([{ id: "scout-1", status: "idle" }], ["scout-1"]);
  assert.equal(await resolveFirstMate(new CliPort(f.exec), "firstmate=true", root), null);
});

test("sending with nobody to send to throws NoFirstMateError with the claim hint", async () => {
  const root = checkout();
  const f = fakeExec([], []);
  await assert.rejects(sendToFirstMate(new PortSelector(new CliPort(f.exec)), "firstmate=true", "hi", undefined, root), (e: Error) =>
    e instanceof NoFirstMateError && /No first mate claimed this checkout: run bin\/page claim in the first mate's session/.test(e.message));
});
