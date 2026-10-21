import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPoll, decodePoll } from "../server/toon.ts";

const fx = (n: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");

test("feedback batch (real lavish-axi 0.1.90 output) decodes to prompts", async () => {
  const o = classifyPoll(await decodePoll(fx("feedback.toon")));
  assert.equal(o.kind, "feedback");
  assert.equal(o.ended, false);
  assert.equal(o.prompts.length, 2);
  assert.deepEqual(
    o.prompts.map((p) => [p.prompt, p.selector, p.tag, p.text]),
    [["Is this right?", "#t-ab-gap > span", "span", "gap"], ["Add detail", "section#endpoints > p", "p", "hi"]],
  );
});

test("the [lavish-axi] banner lines on stdout are ignored", async () => {
  const o = classifyPoll(await decodePoll("[lavish-axi] Long-polling...\n" + fx("feedback.toon")));
  assert.equal(o.prompts.length, 2);
});

test("LISTENER_ACTIVE names the holder", async () => {
  const o = classifyPoll(await decodePoll(fx("listener_active.toon")));
  assert.equal(o.kind, "listener-active");
  assert.equal(o.holder, "a");
  assert.equal(o.prompts.length, 0);
});

test("ended with a final prompt: prompts kept, ended true", async () => {
  const o = classifyPoll(await decodePoll(fx("ended_with_prompt.toon")));
  assert.equal(o.kind, "ended");
  assert.equal(o.ended, true);
  assert.equal(o.endedBy, "user");
  assert.deepEqual(o.prompts.map((p) => p.prompt), ["final words"]);
});

test("ended without prompts", async () => {
  const o = classifyPoll(await decodePoll(fx("ended_plain.toon")));
  assert.equal(o.kind, "ended");
  assert.equal(o.ended, true);
  assert.equal(o.prompts.length, 0);
});

test("browser_disconnected is resumable, not ended", () => {
  const o = classifyPoll({ session: { file: "/x", status: "browser_disconnected" } });
  assert.equal(o.kind, "disconnected");
  assert.equal(o.ended, false);
});

test("garbage is an error, not a crash", async () => {
  assert.equal(classifyPoll(null).kind, "error");
  assert.equal(classifyPoll({ error: "boom" }).kind, "error");
  await assert.rejects(decodePoll("   \n"));
});
