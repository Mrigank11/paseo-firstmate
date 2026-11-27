// A crew on another host writes its canvas with a key in the x-canvas-key header: the deck never logs, shows or forwards it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Gate, messageVerdict } from "../server/gate.ts";
import { human } from "../server/humanize.ts";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector, viewFromItems, type TimelineItem } from "../server/paseo-port.ts";
import { Permission } from "../server/permission.ts";
import { redact } from "../server/redact.ts";
import { crew, fakeExec } from "./fake-hosts.ts";
import { assistant, FakeWorld, fakePaseo } from "./fake-paseo.ts";
import { tmp } from "./tmp.ts";

const KEY = "9f2c4b7a1d0e8f6a5b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a";
const CURL = `curl -s -X POST http://100.64.1.10:6790/api/canvas/x -H 'x-canvas-key: ${KEY}' -d @c.tsx`;

test("redact: the header's value goes, however it is quoted; the rest stays", () => {
  const forms = [
    `-H 'x-canvas-key: ${KEY}'`, `-H "x-canvas-key: ${KEY}"`, `-H x-canvas-key:${KEY}`, `--header="X-Canvas-Key:${KEY}"`, `-H 'x-canvas-key: "${KEY}"'`, `-H $'x-canvas-key: ${KEY}'`, `-H x-canvas-key:\\ ${KEY}`,
    `-H \\"x-canvas-key: ${KEY}\\"`, `{"x-canvas-key":"${KEY}"}`, `{\\"x-canvas-key\\": \\"${KEY}\\"}`, `headers={'x-canvas-key': '${KEY}'}`, `h.set("x-canvas-key", "${KEY}")`, `x-canvas-key=${KEY}`,
    `-H "x-canvas-key: \\\n  ${KEY}"`, `-H 'x-canvas-key: ${KEY}' -H 'x-canvas-key: ${KEY}'`, JSON.stringify({ command: CURL }), JSON.stringify(JSON.stringify({ command: `curl -H "x-canvas-key: ${KEY}"` })),
  ];
  for (const f of forms) {
    const out = redact(f);
    assert.ok(!out.includes(KEY.slice(0, 8)), f);
    assert.match(out, /\[redacted\]/, f);
    assert.equal(redact(out), out, "twice is once");
  }
  assert.equal(redact(CURL), CURL.replace(KEY, "[redacted]"));
  for (const same of ['-H "x-canvas-key: $KEY"', '-H "x-canvas-key: ${CANVAS_KEY}"', '-H "x-canvas-key: $(cat key)"', "the x-canvas-key header", "x-canvas-keys: 3", "no header here"]) assert.equal(redact(same), same);
});

const shell = (command: string) => ({ type: "tool_call", callId: "c", name: "Bash", status: "completed", error: null, detail: { type: "shell", command } }) as unknown as TimelineItem;

test("card steps and final lines carry no key, even where the text is cut short", () => {
  const items = [
    shell(`echo ${"a".repeat(10)} && x-canvas-key=${KEY} run`),
    { type: "tool_call", callId: "f", name: "fetch", status: "completed", error: null, detail: { type: "fetch", url: `http://h/?q=1 x-canvas-key: ${KEY}` } } as unknown as TimelineItem,
    { type: "reasoning", text: `I will send ${"y".repeat(60)} x-canvas-key: ${KEY} now` } as TimelineItem,
    { type: "error", message: `failed: x-canvas-key: ${KEY}` } as TimelineItem,
    assistant(`DONE: sent x-canvas-key: ${KEY}`),
  ];
  const v = viewFromItems(items);
  assert.doesNotMatch(JSON.stringify(v), new RegExp(KEY.slice(0, 8)));
  assert.equal(v.final, "DONE: sent x-canvas-key: [redacted]");
  assert.doesNotMatch(human("Search", `${"z".repeat(70)} x-canvas-key: ${KEY}`), new RegExp(KEY.slice(0, 8)));
  assert.equal(messageVerdict([assistant(`DONE: x-canvas-key: ${KEY}`)]).line, "DONE: x-canvas-key: [redacted]");
  assert.doesNotMatch(JSON.stringify(messageVerdict([assistant(`working\nDONE: x-canvas-key: ${KEY}`)])), new RegExp(KEY.slice(0, 8)));
});

test("the CLI port's view and sweep carry no key", async () => {
  const f = fakeExec({ local: [crew("a", "t", "2026-11-27T10:00:00Z", { status: "idle" })], hosts: [] });
  const port = new CliPort(async (args) => (args[0] === "logs" ? `[Shell] x-canvas-key=${KEY} go\nDONE: x-canvas-key: ${KEY}\n` : f.exec(args)));
  assert.doesNotMatch(JSON.stringify([await port.agentView("a"), await port.sweepInfo("a")]), new RegExp(KEY.slice(0, 8)));
});

test("a keyed curl that asks permission, and a crew's error, reach the logs and the first mate without the key", async () => {
  const root = mkdtempSync(join(tmp(), "redact-"));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "firstmate.json"), JSON.stringify({ agentId: "fm" }));
  const labels = { "fm.task": "t1", "fm.notify": "plugin" };
  const world = new FakeWorld().add({ id: "fm", labels: { firstmate: "true" } }, { id: "crew", labels, status: "running" });
  const ports = new PortSelector(new CliPort(async () => "[]"), () => {});
  ports.capture({ paseo: fakePaseo(world) }, "t");
  const permission = new Permission({ ports, root: () => root, paseoHome: null, log: () => {}, retryDelayMs: 1 });
  const long = `curl ${"-v ".repeat(60)}-H 'x-canvas-key: ${KEY}' http://x`;
  for (const [id, command] of [["p1", CURL], ["p2", long]]) {
    await permission.onRequested({ agent: { id: "crew", parentAgentId: "fm" }, request: { id, kind: "tool", name: "Bash", title: command, description: command, input: { command }, detail: { type: "shell", command } } });
  }
  const gate = new Gate({ ports, root: () => root, firstmateLabel: () => "firstmate=true", log: () => {} });
  await gate.onTurnEnded({ agent: { id: "crew", parentAgentId: "fm" }, turnId: "t1", outcome: { kind: "failed", error: { message: `curl x-canvas-key: ${KEY} failed` } }, timeline: [] });
  assert.equal(world.sent.length, 3);
  const written = [...world.sent.map((m) => m.text), readFileSync(join(root, "state", "permission-log.jsonl"), "utf8"), readFileSync(join(root, "state", "gate-log.jsonl"), "utf8")].join("\n");
  assert.doesNotMatch(written, new RegExp(KEY.slice(0, 8)));
  assert.match(written, /x-canvas-key: \[redacted\]/);
});
