import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTarget } from "../server/target.ts";

const known = { tasks: ["ab-gap", "x.y"], sections: ["endpoints", "flags"] };

test("task cards", () => {
  assert.equal(extractTarget("#t-ab-gap > span", known), "t-ab-gap");
  assert.equal(extractTarget("#live > section#g-running > article#t-ab-gap > div.tt > span.ttl", known), "t-ab-gap");
  assert.equal(extractTarget("#t-ab-gap", {}), "t-ab-gap");
  assert.equal(extractTarget("#t-x\\.y > p", known), "t-x.y");
});

test("real Lavish selector captured from headless Chrome (lavish-axi 0.1.90)", () => {
  assert.equal(extractTarget("article#t-ab-gap > div:nth-of-type(1) > span", known), "t-ab-gap");
});

test("steps belong to the task card; the ask block, its buttons and its context belong to that ask", () => {
  assert.equal(extractTarget("#s-ab-gap > summary", known), "t-ab-gap");
  assert.equal(extractTarget("#a-ab-gap-2 > div", known), "t-ab-gap#a2");
  assert.equal(extractTarget("article#t-ab-gap > div#a-ab-gap-1 > div.opts > div.opt-row > button.opt", known), "t-ab-gap#a1");
  assert.equal(extractTarget("article#t-ab-gap > div#a-ab-gap-3 > details#x-ab-gap-3 > div", known), "t-ab-gap#a3");
  assert.equal(extractTarget("#x-ab-gap-2 > summary", known), "t-ab-gap#a2");
  assert.equal(extractTarget("#a-ab-gap-1", {}), "t-ab-gap#a1");
  assert.equal(extractTarget("#a-nope-1 > div", known), "page");
  // stable ask ids in the DOM ids: a-<task>-<askId>
  assert.equal(extractTarget("#a-ab-gap-a2 > div", known), "t-ab-gap#a2");
  assert.equal(extractTarget("article#t-ab-gap > div#a-ab-gap-a12 > div.opts > div.opt-row > button#o-ab-gap-a12-1", known), "t-ab-gap#a12");
  assert.equal(extractTarget("details#x-ab-gap-a3 > summary", known), "t-ab-gap#a3");
  assert.equal(extractTarget("#a-nope-a1 > div", known), "page");
});

test("sections", () => {
  assert.equal(extractTarget("section#endpoints > p", known), "endpoints");
  assert.equal(extractTarget("main > section#flags > ul > li:nth-of-type(2)", {}), "flags");
  assert.equal(extractTarget("#flags > p", known), "flags");
  assert.equal(extractTarget('main > [data-section="decisions"] > p', {}), "decisions");
  assert.equal(extractTarget("#endpoints > p", {}), "page"); // a bare #id is only a section when we know it is one
});

test("the innermost match wins: a task card inside the live block", () => {
  assert.equal(extractTarget("section#endpoints > article#t-ab-gap", known), "t-ab-gap");
});

test("everything else is the page", () => {
  assert.equal(extractTarget("body", known), "page");
  assert.equal(extractTarget("h1", known), "page");
  assert.equal(extractTarget("#g-running > h3", known), "page");
  assert.equal(extractTarget("#t-unknown-task > p", known), "page"); // not a known task: not a card target
  assert.equal(extractTarget(undefined, known), "page");
  assert.equal(extractTarget("", known), "page");
});
