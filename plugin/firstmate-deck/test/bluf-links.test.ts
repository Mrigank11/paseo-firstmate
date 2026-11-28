// Markdown [text](url) links in a canvas's BLUF and recap lines show as links on the project page (http and https only).
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../server/state.ts";
import { canvasFragment, recapStrip, renderProject } from "../server/render.ts";
import { summary } from "./fake-canvas.ts";
import { withBodies } from "./bodies.ts";
import type { CanvasData } from "../server/canvas-port.ts";

const NOW = new Date("2026-10-24T12:00:00Z");
const a = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const blufOf = (bluf: string, full = false) => /<div class="cv-bluf">([\s\S]*?)<\/div>/.exec(canvasFragment(summary("a", { bluf }), undefined, full))![1];
const strip = (asked: string, did: string) => recapStrip({ id: "t1" } as any, "you", { asked, did }, Date.parse("2026-10-24T11:30:00Z"), [], NOW).html;
const values = (html: string) => [...html.matchAll(/<span class="rc-v" title="([^"]*)">([\s\S]*?)<\/span>/g)].map((m) => ({ title: m[1], html: m[2] }));

test("BLUF: a link becomes an anchor that opens in a new tab", () => {
  assert.equal(blufOf("See [PR #21](https://github.test/o/r/pull/21). Not merged."), `See ${a("https://github.test/o/r/pull/21", "PR #21")}. Not merged.`);
  assert.equal(blufOf("[demo](http://box.test:4387/session/e9)"), a("http://box.test:4387/session/e9", "demo"));
});

test("BLUF: two links in one line", () => {
  assert.equal(blufOf("Two PRs: [one](https://x.test/1) and [two](https://x.test/2?a=1&b=2)."),
    `Two PRs: ${a("https://x.test/1", "one")} and ${a("https://x.test/2?a=1&amp;b=2", "two")}.`);
});

test("BLUF: anything but http(s) stays the text it was", () => {
  const raw = "[a](javascript:alert(1)) [b](mailto:x@y.test) [c](docs/x.md) [d](#top) [e](data:text/html,x) https://bare.test **b** `c`";
  assert.equal(blufOf(raw), raw);
});

test("BLUF: HTML stays text, in the line, in a link's text and in its url", () => {
  assert.equal(blufOf("<script>alert(1)</script> [<img src=x>](https://x.test/a)"),
    `&lt;script&gt;alert(1)&lt;/script&gt; ${a("https://x.test/a", "&lt;img src=x&gt;")}`);
  for (const bad of [`[x](https://x.test/"onmouseover="alert`, `[x](https://x.test/'a`, "[x](https://x.test/<b>", "[x](https://x.test/\u0001"]) {
    assert.ok(!blufOf(`${bad})`).includes("<a "), bad);
  }
  assert.equal(blufOf(`[x](https://x.test/"onmouseover="y)`), "[x](https://x.test/&quot;onmouseover=&quot;y)");
});

test("BLUF: the cut counts what is read, not the url, and never leaves half a link", () => {
  const url = `https://x.test/${"u".repeat(300)}`;
  assert.equal(blufOf(`Open [the PR](${url}) now`), `Open ${a(url, "the PR")} now`);
  const long = `${"x".repeat(270)} [the pull request](${url}) tail`;
  assert.equal(blufOf(long), `${"x".repeat(270)} ${a(url, "the pull")}…`);
  assert.equal(blufOf("y".repeat(400)), `${"y".repeat(279)}…`, "a line without links is cut as before");
  assert.equal(blufOf(`[l](${url}) ${"z".repeat(400)}`, true), `${a(url, "l")} ${"z".repeat(400)}`, "a Needs-you card is uncut");
});

test("recap lines: links are anchors; the tooltip reads without the url", () => {
  const [asked, did] = values(strip("Open [two PRs](https://x.test/prs) <now>", "Opened [one](https://x.test/1) and [two](https://x.test/2)"));
  assert.equal(asked.html, `Open ${a("https://x.test/prs", "two PRs")} &lt;now&gt;`);
  assert.equal(asked.title, "Open two PRs &lt;now&gt;");
  assert.equal(did.html, `Opened ${a("https://x.test/1", "one")} and ${a("https://x.test/2", "two")}`);
  const [bad] = values(strip("[x](javascript:alert(1)) <script>x</script>", "ok"));
  assert.equal(bad.html, "[x](javascript:alert(1)) &lt;script&gt;x&lt;/script&gt;");
  assert.equal(bad.title, bad.html);
});

test("recap lines: cut at 200 read characters, the link kept whole", () => {
  const url = `https://x.test/${"u".repeat(300)}`;
  const [asked] = values(strip(`${"x".repeat(190)} [the pull request](${url}) tail`, "ok"));
  assert.equal(asked.html, `${"x".repeat(190)} ${a(url, "the pull")}…`);
  assert.equal(asked.title, `${"x".repeat(190)} the pull request tail`);
});

// the BLUF inside a canvas body, as agent-canvas draws it: escaped text in <p class="lede">
const LEDE = `<p class="lede">Open: [pr &lt;21&gt;](https://x.test/21?a=1&amp;b=2) and [two](https://x.test/22). [no](javascript:alert(1)) &lt;script&gt;</p>`;
const LINKED = `<p class="lede">Open: ${a("https://x.test/21?a=1&amp;b=2", "pr &lt;21&gt;")} and ${a("https://x.test/22", "two")}. [no](javascript:alert(1)) &lt;script&gt;</p>`;
const OTHER = `<div class="well"><span>[not a bluf](https://x.test/code)</span></div>`;

test("a live canvas embedded in the card: the BLUF's links are anchors, the rest of the canvas is untouched", () => {
  const html = canvasFragment(summary("a"), `<div class="acv">${LEDE}${OTHER}</div>`, true);
  assert.ok(html.includes(LINKED + OTHER), html);
});

function project(task: object, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "deck-bl-"));
  const pdir = join(root, "state", "projects", "demo");
  const tdir = join(root, "state", "tasks", "t1");
  mkdirSync(pdir, { recursive: true });
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo", sections: [] }));
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks: [task] }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(tdir, name), text);
  return loadProject(root, "demo");
}
const T = { id: "t1", intent: "x", title: "Build", state: "active", since: "2026-10-24T10:00:00Z", project: "demo", shape: "ship" };
const OPTS = { now: NOW, paseoAgentUrl: (id: string) => `http://paseo.test/agent/${id}`, tickSeconds: 20 };

test("a done card: the saved canvas's BLUF and its recap strip show links", () => {
  const model = project({ ...T, state: "done" }, {
    "canvas.final.html": `<!doctype html>\n<html><head><style>\n.acv .lede{margin:0}\n</style></head><body>\n<div class="cv-snap acv"><div class="acv">${LEDE}${OTHER}</div></div>\n</body></html>\n`,
    "canvas.final.tsx": `<Canvas title="x" status="done"><Bluf>b</Bluf><Markdown id="recap">**You asked:** see [it](https://x.test/it) **I did:** opened [PR](https://x.test/pr)</Markdown></Canvas>`,
  });
  const empty: CanvasData = { status: "ok", css: "", summaries: {}, cards: {} };
  const html = withBodies(renderProject(model, {}, { ...OPTS, canvas: empty }));
  assert.ok(html.includes(LINKED + OTHER), html);
  assert.ok(html.includes(`see ${a("https://x.test/it", "it")}`));
  assert.ok(html.includes(`opened ${a("https://x.test/pr", "PR")}`));
});
