// The task tree: parent links, depth, roll-up and the owner chain. Pure helpers, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ancestorsOf, childrenOf, leavesUnder, ownerChain, parentError, rollup, subtreeOf, type NodeLike } from "../server/tree.ts";

const N = (id: string, parent?: string, kind?: string): NodeLike => ({ id, parent, kind });
const nodes = [N("g", undefined, "group"), N("a", "g"), N("b", "g"), N("sub", "g", "group"), N("c", "sub"), N("solo")];

test("ancestors run nearest first and stop on a missing or cyclic parent", () => {
  assert.deepEqual(ancestorsOf(nodes, "c"), ["sub", "g"]);
  assert.deepEqual(ancestorsOf(nodes, "solo"), []);
  assert.deepEqual(ancestorsOf([N("x", "y"), N("y", "x")], "x"), ["y"]);
  assert.deepEqual(ancestorsOf([N("x", "gone")], "x"), ["gone"]);
});

test("children, subtree and leaves", () => {
  assert.deepEqual(childrenOf(nodes, "g").map((n) => n.id), ["a", "b", "sub"]);
  assert.deepEqual(subtreeOf(nodes, "g").sort(), ["a", "b", "c", "sub"]);
  assert.deepEqual(leavesUnder(nodes, "g").map((n) => n.id).sort(), ["a", "b", "c"]);
  assert.deepEqual(leavesUnder(nodes, "solo"), []);
});

test("parentError: a parent must be a live group, no cycle, at most two ancestors, not itself", () => {
  assert.equal(parentError(nodes, "solo", "g"), null);
  assert.match(parentError(nodes, "solo", "nope")!, /no live task/);
  assert.match(parentError(nodes, "solo", "a")!, /not a group/);
  assert.match(parentError(nodes, "g", "g")!, /itself/);
  assert.match(parentError(nodes, "g", "sub")!, /cycle/);
  const deep = [...nodes, N("sub2", "sub", "group")];
  assert.match(parentError(deep, "z", "sub2")!, /deeper than/);
  assert.match(parentError(deep, "sub", "sub2")!, /cycle/);
  // an empty group two levels down could never hold a task
  assert.match(parentError(nodes, "g3", "sub", "group")!, /deeper than/);
  assert.equal(parentError(nodes, "g3", "g", "group"), null);
  // a group that already has children cannot be moved under a node that would push them past the cap
  assert.match(parentError(nodes, "sub", "g2")!, /no live task/);
  assert.match(parentError([...nodes, N("g2", "g", "group")], "sub", "g2")!, /deeper than/);
});

const roll = (m: Record<string, string>, failed: string[] = []) => (id: string) => ({ group: m[id] as any, failed: failed.includes(id) });

test("rollup: the most urgent open child wins, counts ride along", () => {
  const r = rollup(nodes, "g", roll({ a: "done", b: "running", c: "you" }));
  assert.equal(r.group, "you");
  assert.equal(r.stage, "Needs you");
  assert.deepEqual(r.counts, { you: 1, fm: 0, running: 1, blocked: 0, next: 0, parked: 0, done: 1 });
  assert.equal(r.total, 3);
  assert.equal(r.done, 1);
  assert.equal(rollup(nodes, "g", roll({ a: "fm", b: "running", c: "blocked" })).group, "fm");
  assert.equal(rollup(nodes, "g", roll({ a: "parked", b: "blocked", c: "done" })).group, "blocked");
  assert.equal(rollup(nodes, "g", roll({ a: "parked", b: "next", c: "done" })).group, "next");
  assert.equal(rollup(nodes, "g", roll({ a: "parked", b: "parked", c: "done" })).group, "parked");
});

test("rollup: done only when every leaf is done; failed leaves flag the group", () => {
  const r = rollup(nodes, "g", roll({ a: "done", b: "done", c: "done" }));
  assert.equal(r.group, "done");
  assert.equal(r.failed, false);
  assert.equal(rollup(nodes, "g", roll({ a: "done", b: "done", c: "done" }, ["b"])).failed, true);
  assert.equal(rollup(nodes, "sub", roll({ c: "done" })).group, "done");
});

test("rollup: a group with no leaves is next up and says so", () => {
  const r = rollup([N("e", undefined, "group")], "e", roll({}));
  assert.equal(r.group, "next");
  assert.equal(r.total, 0);
  assert.match(r.reason, /no tasks/);
});

test("ownerChain: nearest claimed live node first, then the project and checkout claims", () => {
  const claims: Record<string, string> = { sub: "sm-sub", g: "sm-g" };
  const claim = (id: string) => claims[id] ?? null;
  assert.deepEqual(ownerChain(nodes, "c", claim, ["fm-project", "fm-checkout"]), [
    { id: "sm-sub", via: "sub" }, { id: "sm-g", via: "g" }, { id: "fm-project", via: "project" }, { id: "fm-checkout", via: "project" },
  ]);
  assert.deepEqual(ownerChain(nodes, "solo", claim, ["fm"]), [{ id: "fm", via: "project" }]);
  // a group's own claim owns the group itself, and so its children's wakes
  assert.deepEqual(ownerChain(nodes, "g", claim, []), [{ id: "sm-g", via: "g" }]);
  // the same agent never appears twice
  assert.deepEqual(ownerChain(nodes, "a", () => "x", ["x"]), [{ id: "x", via: "a" }]);
});
