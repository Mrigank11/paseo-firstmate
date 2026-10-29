process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasPort } from "../server/canvas-port.ts";
import { FakeCanvas, summary } from "./fake-canvas.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rig = async (o: { url?: string } = {}) => {
  const fc = await new FakeCanvas().start();
  const changes: string[][] = [];
  const logs: string[] = [];
  const port = new CanvasPort({ url: () => o.url ?? fc.url, onChange: (ids) => changes.push(ids), log: (m) => logs.push(m), pollMs: 20, maxBackoffMs: 80 });
  return { fc, port, changes, logs, done: async () => { port.stop(); await fc.stop(); } };
};

test("a poll reads the summary, fetches a card once per rev, and tells who changed", async () => {
  const r = await rig();
  r.fc.set(summary("ag-1"));
  r.port.want("demo", ["ag-1"]);
  await r.port.poll();
  assert.equal(r.port.status, "ok");
  const d = r.port.data(["ag-1"]);
  assert.equal(d.summaries["ag-1"].bluf, "Building the API");
  assert.match(d.cards["ag-1"], /FULL CANVAS ag-1 rev 1/);
  assert.match(d.css, /\.acv/);
  assert.deepEqual(r.changes.flat(), ["ag-1"]);
  await r.port.poll(); await r.port.poll();
  assert.equal(r.fc.count("/api/fm/card/"), 1, "same rev: no new card fetch");
  assert.equal(r.fc.count("/api/fm/css"), 1);
  assert.equal(r.fc.cssTheme, "light", "the page is light: the canvas css is asked for that theme, not left to prefers-color-scheme");
  assert.equal(r.changes.length, 1, "nothing moved: no change event");
  r.fc.set(summary("ag-1", { rev: 2, bluf: "Tests green" }));
  await r.port.poll();
  assert.equal(r.fc.count("/api/fm/card/"), 2);
  assert.match(r.port.data(["ag-1"]).cards["ag-1"], /rev 2/);
  assert.equal(r.changes.length, 2);
  await r.done();
});

test("only the wanted agents are asked for, and one want() per project is unioned", async () => {
  const r = await rig();
  r.fc.set(summary("a")); r.fc.set(summary("b")); r.fc.set(summary("c"));
  r.port.want("p1", ["a"]); r.port.want("p2", ["b"]);
  await r.port.poll();
  assert.ok(r.fc.hits.some((h) => h.includes("agents=a%2Cb")), r.fc.hits.join(" "));
  assert.deepEqual(Object.keys(r.port.data().summaries).sort(), ["a", "b"]);
  r.port.want("p2", []);
  assert.deepEqual(Object.keys(r.port.data().summaries), ["a"]);
  await r.done();
});

test("unreachable canvas: soft 'down' (no fragment, no stage input), backoff, and recovery", async () => {
  const r = await rig();
  r.fc.set(summary("ag-1"));
  r.port.want("demo", ["ag-1"]);
  await r.port.poll();
  r.fc.down = true;
  await r.port.poll();
  assert.equal(r.port.status, "down");
  assert.deepEqual(r.port.data(["ag-1"]).summaries, {}, "not shown while down");
  assert.equal(r.logs.filter((l) => /unreachable/.test(l)).length, 1);
  await r.port.poll(); // the same failure is logged once
  assert.equal(r.logs.filter((l) => /unreachable/.test(l)).length, 1);
  r.fc.down = false;
  await r.port.poll();
  assert.equal(r.port.status, "ok");
  assert.equal(r.port.data(["ag-1"]).summaries["ag-1"].rev, 1);
  await r.done();
});

test("a dead port is a soft failure, never a throw", async () => {
  const r = await rig({ url: "http://127.0.0.1:1" });
  r.port.want("demo", ["ag-1"]);
  await r.port.poll();
  assert.equal(r.port.status, "down");
  await r.done();
});

test("no canvas URL: status off, nothing fetched", async () => {
  const r = await rig({ url: "" });
  r.port.want("demo", ["ag-1"]);
  await r.port.poll();
  assert.equal(r.port.status, "off");
  assert.equal(r.fc.hits.length, 0);
  await r.done();
});

test("it keeps polling by itself while an agent is wanted, and stops when none is", async () => {
  const r = await rig();
  r.fc.set(summary("ag-1"));
  r.port.want("demo", ["ag-1"]);
  await sleep(150);
  assert.ok(r.fc.count("/api/fm/summary") >= 3, `polled ${r.fc.count("/api/fm/summary")}x`);
  r.port.want("demo", []);
  await sleep(60);
  const n = r.fc.count("/api/fm/summary");
  await sleep(100);
  assert.equal(r.fc.count("/api/fm/summary"), n);
  await r.done();
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const H1 = "a".repeat(32), H2 = "b".repeat(32), H3 = "c".repeat(32);

test("a card's pictures become data: URIs: a Markdown image (no host) and an <Image> (daemon address) both survive the page and the snapshot", async () => {
  const r = await rig();
  r.fc.assets.set(H1, { mime: "image/png", bytes: PNG });
  r.fc.assets.set(H2, { mime: "image/png", bytes: PNG });
  r.fc.set(summary("ag-1"));
  r.fc.cardHtml.set("ag-1", `<figure class="fig"><img src="/asset/${H1}" alt="md" width="1" height="1" loading="lazy"></figure>`
    + `<figure class="fig"><img src="http://127.0.0.1:6790/asset/${H2}" alt="tag" loading="lazy"></figure>`
    + `<figure class="fig"><img src="/asset/${H3}" alt="gone"></figure>`);
  r.port.want("demo", ["ag-1"]);
  await r.port.poll();
  const card = r.port.data(["ag-1"]).cards["ag-1"];
  const uri = `data:image/png;base64,${PNG.toString("base64")}`;
  assert.equal(card.split(uri).length - 1, 2, "both pictures are embedded");
  assert.match(card, /alt="md"/);
  assert.ok(!card.includes(`/asset/${H1}`) && !card.includes(`/asset/${H2}`), "no host-less or loopback asset link is left");
  assert.ok(card.includes(`src="/asset/${H3}"`), "a picture the canvas no longer has keeps its link rather than breaking the card");
  await r.port.poll();
  assert.equal(r.fc.count(`/asset/${H1}`), 1, "assets are immutable by hash: fetched once");
  await r.done();
});
