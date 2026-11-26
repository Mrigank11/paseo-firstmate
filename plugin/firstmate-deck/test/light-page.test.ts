// The page stays light: screenshots are links to the deck's own server (not base64 in the payload), and an idle tab only
// polls a tiny version file, fetching the full payload when its hash moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { ASSET_MARK, assetDir, externalizeImages, resolveAssets, saveAsset } from "../server/asset-store.ts";
import { MarksServer } from "../server/marks-server.ts";
import { liveJs, liveVersionJs } from "../server/render.ts";
import { pageScript } from "../server/page-script.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const root = () => { const r = mkdtempSync(join(tmpdir(), "light-")); mkdirSync(join(r, "state", "projects", "demo"), { recursive: true });
  writeFileSync(join(r, "state", "projects", "demo", "project.json"), "{}"); return r; };

test("a data: picture in a saved snapshot becomes a link, and its bytes are kept on disk by hash", () => {
  const r = root();
  const html = `<p>x</p><img src="data:image/png;base64,${PNG.toString("base64")}" alt="s">`;
  const out = externalizeImages(html, assetDir(r));
  assert.ok(!out.includes("base64"), "no inlined bytes left");
  const m = new RegExp(`src="${ASSET_MARK}/asset/([0-9a-f]{32})"`).exec(out);
  assert.ok(m, out);
  assert.equal(externalizeImages(html, assetDir(r)), out, "same input, same link");
  const base = resolveAssets(out, "http://h:4398", assetDir(r));
  assert.ok(base.includes(`src="http://h:4398/asset/${m![1]}"`));
  assert.ok(resolveAssets(out, "", assetDir(r)).includes(`data:image/png;base64,${PNG.toString("base64")}`), "no server: falls back to the bytes");
});

test("the deck's web server serves a saved picture by hash, cacheable forever, and 404s anything else", async () => {
  const r = root();
  const h = "a".repeat(32);
  saveAsset(assetDir(r), h, "image/png", new Uint8Array(PNG));
  const s = new MarksServer(() => r);
  const [bound] = await s.listen(["127.0.0.1"], 0).then(() => s.boundPorts());
  try {
    const res = await fetch(`http://127.0.0.1:${bound}/asset/${h}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    assert.equal((await fetch(`http://127.0.0.1:${bound}/asset/${"b".repeat(32)}`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${bound}/asset/..%2F..%2Fproject`)).status, 404);
  } finally { await s.close(); }
});

test("liveJs carries the content hash; the version file is a tiny call with hash and sequence", () => {
  assert.match(liveJs("a", "i", 3, "abc"), /__fdLive\("a","i",3,"abc"\)/);
  const v = liveVersionJs("abc", "i", 3);
  assert.ok(v.length < 120, v);
  assert.match(v, /__fdVer/);
});

function boot() {
  let clock = 1_000_000;
  const timers: { fn: () => void; every: number; next: number }[] = [];
  const srcs: string[] = [];
  const doc: any = { activeElement: null, addEventListener() {}, getElementById: () => null, querySelectorAll: () => [],
    createElement: () => { const s: any = { remove() {} }; return s; }, head: { appendChild(s: any) { srcs.push(s.src); } } };
  const win: any = { name: "", scrollY: 0, scrollTo() {}, scrollBy() {}, addEventListener() {} };
  const ctx = vm.createContext({ document: doc, window: win, location: { hash: "" }, localStorage: undefined, Date: { now: () => clock, parse: Date.parse },
    JSON, Object, Math, Array, setInterval: (fn: () => void, every: number) => { timers.push({ fn, every, next: clock + every }); return timers.length; } });
  vm.runInContext(pageScript("p", "page.live.js", 1), ctx);
  const advance = (ms: number) => { const end = clock + ms; for (;;) { const d = timers.filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0]; if (!d) break; clock = d.next; d.next += d.every; d.fn(); } clock = end; };
  return { win, srcs, advance, versionTicks: () => srcs.filter((s) => s.startsWith("page.live.v.js")).length, fullTicks: () => srcs.filter((s) => s.startsWith("page.live.js")).length };
}

test("an idle tab polls only the version file; the full payload loads once, then again only when the hash moves", () => {
  const b = boot();
  assert.equal(b.fullTicks(), 1, "first load fetches the full payload");
  b.win.__fdLive("<p>a</p>", "i", 1, "h1");
  const base = b.fullTicks();
  b.advance(10_000);
  assert.equal(b.versionTicks() >= 10, true, "one tiny check per second");
  assert.equal(b.fullTicks(), base, "nothing changed: no full fetch in 10 s");
  b.win.__fdVer("h1", 2, "i");
  b.advance(2_000);
  assert.equal(b.fullTicks(), base, "same hash, new sequence: still no full fetch");
  b.win.__fdVer("h2", 3, "i");
  b.advance(1_000);
  assert.equal(b.fullTicks(), base + 1, "new hash: exactly one full fetch");
  b.advance(1_000);
  assert.equal(b.fullTicks(), base + 1, "and not another while it is in flight or once loaded");
});

import { CanvasPort } from "../server/canvas-port.ts";
import { readAsset } from "../server/asset-store.ts";
import { FakeCanvas, summary } from "./fake-canvas.ts";

test("with an asset dir, a crew card links its screenshots instead of embedding them, and the bytes are stored", async () => {
  const r = root();
  const fc = await new FakeCanvas().start();
  const H1 = "a".repeat(32), H3 = "c".repeat(32);
  fc.assets.set(H1, { mime: "image/png", bytes: PNG });
  fc.set(summary("ag-1"));
  fc.cardHtml.set("ag-1", `<img src="/asset/${H1}" alt="md"><img src="/asset/${H3}" alt="gone">`);
  const port = new CanvasPort({ url: () => fc.url, pollMs: 20, onChange: () => {}, assetDir: () => assetDir(r) });
  port.want("demo", ["ag-1"]);
  await port.poll();
  const card = port.data(["ag-1"]).cards["ag-1"];
  assert.ok(card.includes(`src="${ASSET_MARK}/asset/${H1}"`) && !card.includes("base64"), card);
  assert.ok(card.includes(`src="/asset/${H3}"`), "a picture the canvas no longer has keeps its link");
  assert.deepEqual(readAsset(assetDir(r), H1)?.bytes, PNG);
  port.stop(); await fc.stop();
});
