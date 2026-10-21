import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PagePoller, BACKOFF_MS, LISTENER_RETRY_MS, OWN_LISTENER_RETRY_MS, pollWrapperPath, hasLivePoll, killStalePoll, scanNpxCache, spawnPoll, killAllPolls, type PollRun } from "../server/lavish.ts";
import { decodePoll } from "../server/toon.ts";

const fx = (n: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");
const WAITING = "session:\n  file: /x\n  status: browser_disconnected\n";

/** A poller whose polls are scripted; sleeps are recorded and instant. */
function rig(script: (PollRun | (() => Promise<PollRun>))[], ownAlive?: () => boolean) {
  const sleeps: number[] = [];
  const events: string[] = [];
  let i = 0;
  let runningPolls = 0;
  const poller: PagePoller = new PagePoller({
    run: async () => {
      runningPolls++;
      events.push("poll-start");
      const step = script[i++];
      if (!step) { poller.stop(); return { code: 0, stdout: WAITING }; }
      return typeof step === "function" ? step() : step;
    },
    decode: (s) => decodePoll(s),
    onBatch: async (prompts) => { events.push(`batch:${prompts.length}`); await new Promise((r) => setImmediate(r)); events.push("batch-done"); },
    onEnded: () => { events.push("ended"); },
    onListener: (st, detail) => { events.push(`listener:${st}`); if (detail) events.push(`detail:${detail}`); },
    ownAlive,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { poller, sleeps, events, polls: () => runningPolls };
}

test("the next poll starts before the batch has been handled", async () => {
  const r = rig([{ code: 0, stdout: fx("feedback.toon") }]);
  r.poller.start();
  await r.poller.done;
  await new Promise((res) => setImmediate(res));
  const e = r.events.filter((x) => x !== "listener:ok");
  assert.deepEqual(e.slice(0, 3), ["poll-start", "batch:2", "poll-start"], "second poll starts right after the batch is handed off");
  assert.ok(e.indexOf("poll-start", 1) < e.indexOf("batch-done"), "...and before the handler finished");
});

test("browser_disconnected re-polls immediately", async () => {
  const r = rig([{ code: 0, stdout: WAITING }, { code: 0, stdout: fx("feedback.toon") }]);
  r.poller.start();
  await r.poller.done;
  assert.equal(r.polls(), 3);
  assert.deepEqual(r.sleeps, []);
});

test("failures back off 1 s, 2, 4 ... capped at 30 s, and reset after a good poll", async () => {
  const bad: PollRun = { code: 1, stdout: "garbage that is not toon: [" };
  const script: PollRun[] = [bad, bad, bad, bad, bad, bad, bad, bad, { code: 0, stdout: WAITING }, bad];
  const r = rig(script);
  r.poller.start();
  await r.poller.done;
  assert.deepEqual(r.sleeps, [...BACKOFF_MS, 30000, 30000, 1000].slice(0, r.sleeps.length));
  assert.equal(r.sleeps[0], 1000);
  assert.equal(r.sleeps[1], 2000);
  assert.equal(r.sleeps[2], 4000);
  assert.equal(Math.max(...r.sleeps), 30000);
  assert.equal(r.sleeps.at(-1), 1000, "reset after the good poll");
});

test("LISTENER_ACTIVE: marked, retried every 30 s, never taken over", async () => {
  const r = rig([{ code: 1, stdout: fx("listener_active.toon") }, { code: 1, stdout: fx("listener_active.toon") }]);
  r.poller.start();
  await r.poller.done;
  assert.deepEqual(r.sleeps.slice(0, 2), [LISTENER_RETRY_MS, LISTENER_RETRY_MS]);
  assert.ok(r.events.includes("listener:active-elsewhere"));
});

test("LISTENER_ACTIVE with none of our own polls alive: active-elsewhere, with the holder named", async () => {
  const r = rig([{ code: 1, stdout: fx("listener_active.toon") }], () => false);
  r.poller.start();
  await r.poller.done;
  assert.equal(r.sleeps[0], LISTENER_RETRY_MS);
  assert.ok(r.events.includes("listener:active-elsewhere"));
  assert.ok(r.events.some((e) => e.startsWith("detail:held by ")));
});

test("LISTENER_ACTIVE while one of our own earlier polls is alive retries fast and is not flagged", async () => {
  // Lavish labels an unowned poll "agent-listener": the holder text says nothing, our own process table does
  const r = rig([{ code: 1, stdout: fx("listener_active.toon") }], () => true);
  r.poller.start();
  await r.poller.done;
  assert.equal(r.sleeps[0], OWN_LISTENER_RETRY_MS);
  assert.ok(!r.events.includes("listener:active-elsewhere"));
});

test("own-poll fast retries are capped, then it counts as held elsewhere", async () => {
  const la = { code: 1, stdout: fx("listener_active.toon") };
  const r = rig(Array.from({ length: 11 }, () => la), () => true);
  r.poller.start();
  await r.poller.done;
  assert.equal(r.sleeps.slice(0, 10).every((x) => x === OWN_LISTENER_RETRY_MS), true);
  assert.equal(r.sleeps[10], LISTENER_RETRY_MS);
  assert.ok(r.events.includes("listener:active-elsewhere"));
});

test("session end: final prompts delivered, then ended, then polling stops", async () => {
  const r = rig([{ code: 0, stdout: fx("ended_with_prompt.toon") }, { code: 0, stdout: WAITING }]);
  r.poller.start();
  await r.poller.done;
  assert.equal(r.polls(), 1);
  const e = r.events.filter((x) => x !== "listener:ok");
  assert.deepEqual(e.slice(0, 3), ["poll-start", "batch:1", "ended"]);
});

test("an ended session without prompts also stops", async () => {
  const r = rig([{ code: 0, stdout: fx("ended_plain.toon") }]);
  r.poller.start();
  await r.poller.done;
  assert.deepEqual(r.events.filter((x) => x !== "listener:ok"), ["poll-start", "ended"]);
});

test("stop() ends the loop even while a poll is running", async () => {
  let release!: (r: PollRun) => void;
  const r = rig([() => new Promise<PollRun>((res) => (release = res))]);
  r.poller.start();
  await new Promise((res) => setImmediate(res));
  r.poller.stop();
  release({ code: 0, stdout: fx("feedback.toon") });
  await r.poller.done;
  assert.ok(!r.events.some((e) => e.startsWith("batch")), "nothing handled after stop");
});

test("scanNpxCache tolerates a missing cache", () => {
  assert.deepEqual(scanNpxCache("/nonexistent-home"), []);
});

test("spawnPoll resolves when the document is complete, not when the lingering process exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-spawn-"));
  const bin = join(dir, "fake-lavish.mjs");
  // prints a feedback document in two chunks, then lingers for 5 s like the real CLI does for ~1 s
  writeFileSync(bin, `process.stdout.write("[lavish-axi] hello\\n");
process.stdout.write("session:\\n  status: feedback\\nprompts[1]{prompt}:\\n  hi");
setTimeout(() => process.stdout.write("\\nnext_step: \\"go on\\"\\n"), 50);
setTimeout(() => {}, 5000);`);
  const t0 = Date.now();
  const sp = spawnPoll(bin, "/x/page.html", process.env, "o");
  const r = await sp.result;
  assert.ok(Date.now() - t0 < 2500, `resolved after ${Date.now() - t0} ms`);
  assert.equal(sp.child.exitCode, null, "process is still lingering");
  assert.ok(r.stdout.endsWith("  hi\n"), JSON.stringify(r.stdout));
  assert.ok(!r.stdout.includes("next_step"));
  assert.equal((await decodePoll(r.stdout)).prompts[0].prompt, "hi");
  killAllPolls();
});

test("spawnPoll on an error document resolves on exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-spawn-"));
  const bin = join(dir, "fake-lavish.mjs");
  writeFileSync(bin, `process.stdout.write("error: nope\\ncode: LISTENER_ACTIVE\\n"); process.exit(1);`);
  const r = await spawnPoll(bin, "/x/page.html", process.env, "o").result;
  assert.equal(r.code, 1);
  assert.match(r.stdout, /LISTENER_ACTIVE/);
});

// ---- the poll wrapper: a poll child must die with its parent ----

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number, ms = 4000) {
  const t0 = Date.now();
  while (alive(pid)) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 25)); }
  return true;
}
/** A fake lavish whose poll child writes its pid to a file, prints a document and then hangs for a minute. */
function hangingLavish() {
  const dir = mkdtempSync(join(tmpdir(), "deck-wrap-"));
  const bin = join(dir, "lavish-axi", "cli.mjs");
  mkdirSync(join(dir, "lavish-axi"));
  const pidFile = join(dir, "child.pid");
  writeFileSync(bin, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write("session:\\n  status: browser_disconnected\\nnext_step: \\"x\\"\\n");
setTimeout(() => {}, 60000);`);
  return { bin, pidFile, dir };
}
async function readPid(f: string) {
  const t0 = Date.now();
  while (!existsSync(f) || !readFileSync(f, "utf8")) { if (Date.now() - t0 > 4000) throw new Error("child never started"); await new Promise((r) => setTimeout(r, 25)); }
  return Number(readFileSync(f, "utf8"));
}

test("wrapper: output passes through and the real child is the one that runs", async () => {
  const f = hangingLavish();
  const sp = spawnPoll(f.bin, "/x/page.html", process.env);
  const r = await sp.result;
  assert.match(r.stdout, /browser_disconnected/);
  const childPid = await readPid(f.pidFile);
  assert.notEqual(childPid, sp.child.pid, "the poll is a child of the wrapper");
  killAllPolls();
  assert.ok(await gone(childPid), "SIGTERM to the wrapper reaches the poll child");
});

test("wrapper: when the parent's pipe closes (parent died), the poll child is killed and the wrapper exits", async () => {
  const f = hangingLavish();
  const sp = spawnPoll(f.bin, "/x/page.html", process.env);
  await sp.result;
  const childPid = await readPid(f.pidFile);
  sp.child.stdin!.end(); // what the kernel does to the pipe when the plugin is kill -9'd
  assert.ok(await gone(childPid), "poll child gone");
  assert.ok(await gone(sp.child.pid!), "wrapper gone");
});

test("wrapper: killStalePoll still recognises it by command line and kills the whole chain", async () => {
  const f = hangingLavish();
  const page = "/x/proj/page.html";
  const sp = spawnPoll(f.bin, page, process.env);
  await sp.result;
  const childPid = await readPid(f.pidFile);
  const pidFile = join(f.dir, ".poll.pid");
  writeFileSync(pidFile, String(sp.child.pid));
  assert.equal(hasLivePoll(page), true);
  assert.equal(hasLivePoll(page, sp.child), false, "except skips the given child");
  assert.equal(hasLivePoll("/other.html"), false);
  assert.equal(killStalePoll(pidFile, page), true);
  assert.ok(await gone(childPid), "poll child gone");
  assert.equal(killStalePoll(pidFile, page), false, "pid file removed");
});

test("wrapper exits with the child's exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-wrap-"));
  const bin = join(dir, "lavish-axi.mjs");
  writeFileSync(bin, `process.stdout.write("error: nope\\n"); process.exit(3);`);
  const r = await spawnPoll(bin, "/x/page.html", process.env).result;
  assert.equal(r.code, 3);
  assert.match(r.stdout, /error: nope/);
  assert.match(pollWrapperPath(), /firstmate-deck-poll-wrapper-[0-9a-f]{12}\.mjs$/);
});
