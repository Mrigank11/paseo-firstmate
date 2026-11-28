// Where the page's agent links go. The page runs inside Lavish's sandboxed frame, so every link that leaves it must open a new
// tab (a plain link would load Paseo in place of the page), and each "Open in Paseo" has an "app ↗" paseo:// link beside it.
process.env.TZ = "UTC";
process.env.FM_DECK_POLL_MODE ??= "cli";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../server/state.ts";
import { renderProject, type RenderOpts } from "../server/render.ts";
import { Deck } from "../server/runtime.ts";
import { CliPort } from "../server/paseo-cli.ts";
import { PortSelector } from "../server/paseo-port.ts";
import { FakeWorld, fakePaseo } from "./fake-paseo.ts";
import { summary } from "./fake-canvas.ts";
import { withBodies } from "./bodies.ts";
import type { CanvasData } from "../server/canvas-port.ts";

const NEW_TAB = ` target="_blank" rel="noopener noreferrer"`;
const web = (id: string) => `http://paseo.test/agent/${id}`;
const app = (id: string) => `paseo://h/srv/agent/${id}`;
const pair = (id: string) => `<a class="open" href="${web(id)}"${NEW_TAB}>Open in Paseo</a><a class="app-open" href="${app(id)}"${NEW_TAB} title="Open in the Paseo app">app ↗</a>`;

const opts: RenderOpts = { now: new Date("2026-10-24T12:00:00Z"), paseoAgentUrl: web, paseoAppUrl: app, tickSeconds: 20 };
const agent = { status: "running" as const, stepCount: 3, recent: ["ran npm test"], createdAt: "2026-10-24T11:00:00Z", updatedAt: "2026-10-24T11:59:00Z" };
const T = { id: "t1", intent: "build the api", title: "Build the API", state: "active", since: "2026-10-24T10:00:00Z", project: "demo", shape: "ship" };
const labeled = { t1: [{ id: "ag-1", status: "running" as const, archived: false, createdAt: "2026-10-24T11:00:00Z" }] };

function checkout(tasks: object[]) {
  const root = mkdtempSync(join(tmpdir(), "deck-links-"));
  const pdir = join(root, "state", "projects", "demo");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "project.json"), JSON.stringify({ title: "Demo", sections: [] }));
  writeFileSync(join(root, "state", "fleet.json"), JSON.stringify({ version: 2, tasks }));
  return { root, pdir };
}
const project = (tasks: object[]) => loadProject(checkout(tasks).root, "demo");
const html = (task: object = T, canvas?: CanvasData, o: Partial<RenderOpts> = {}) =>
  withBodies(renderProject(project([task]), { "ag-1": agent }, { ...opts, labeled, canvas, ...o }));
const canvas = (s = summary("ag-1")): CanvasData => ({ status: "ok", css: "", summaries: { "ag-1": s }, cards: {} });
/** Every anchor that leaves the page (anything but a #fragment). */
const leaving = (h: string) => [...h.matchAll(/<a\b[^>]*\bhref="(?!#)[^"]*"[^>]*>/g)].map((m) => m[0]);
const assertAllNewTab = (h: string, atLeast: number) => {
  const links = leaving(h);
  assert.ok(links.length >= atLeast, `expected at least ${atLeast} outgoing links, got ${links.length}`);
  for (const a of links) assert.ok(a.includes(NEW_TAB), `opens in place of the page: ${a}`);
};

test("a running card: the title opens the web UI in a new tab; Open in Paseo has the app link beside it", () => {
  const h = html();
  assert.ok(h.includes(`<span class="ttl"><a href="${web("ag-1")}"${NEW_TAB}>Build the API</a></span>`));
  assert.ok(h.includes(`<span class="open-pair">${pair("ag-1")}</span>`));
  assertAllNewTab(h, 3);
});

test("a done card: the same title link, Open in Paseo and app link", () => {
  const h = html({ ...T, state: "done", agentId: "ag-1" });
  assert.ok(h.includes(`<a href="${web("ag-1")}"${NEW_TAB}>Build the API</a>`));
  assert.ok(h.includes(pair("ag-1")));
  assertAllNewTab(h, 3);
});

test("a card with a canvas: Open canvas opens a new tab, and the pair sits in the links row", () => {
  const h = html(T, canvas());
  assert.ok(h.includes(`<div class="cv-links"><a class="cv-open" href="http://canvas.test/a/ag-1"${NEW_TAB}>Open canvas ↗</a><span class="open-pair">${pair("ag-1")}</span></div>`));
  assert.equal(h.split(">app ↗</a>").length - 1, 1, "one app link per Open in Paseo");
  assertAllNewTab(h, 4);
});

test("a canvas question with no buttons: its answer link opens a new tab", () => {
  const ask = { id: "q1", question: "Which?", blocking: true, options: [] };
  const h = html(T, canvas(summary("ag-1", { openAsks: [ask] })));
  assert.ok(h.includes(`<a href="http://canvas.test/a/ag-1"${NEW_TAB}>Answer it on the canvas ↗</a>`));
  assertAllNewTab(h, 5);
});

test("no server ID known: Open in Paseo stands alone, with no app link", () => {
  for (const o of [{ paseoAppUrl: () => null }, { paseoAppUrl: undefined }]) {
    const h = html(T, undefined, o);
    assert.ok(h.includes(`<a class="open" href="${web("ag-1")}"${NEW_TAB}>Open in Paseo</a></div>`));
    assert.ok(!h.includes("paseo://") && !h.includes("app ↗"));
  }
});

/** The live payload a running deck writes, with the daemon answering `status` as given. */
async function deckLive(status: object): Promise<string> {
  const { root, pdir } = checkout([T]);
  const exec = async (a: string[]) => {
    if (a[0] === "status") return JSON.stringify(status);
    if (a[0] === "ls") return JSON.stringify(a.includes("--label") ? [] : [{ id: "ag-1", status: "running" }]);
    if (a[0] === "inspect") return JSON.stringify({ CreatedAt: "2026-10-24T11:00:00Z" });
    throw new Error("unexpected " + a.join(" "));
  };
  // the task finds its agent by the fm.task label, which only the SDK handle reports
  const fw = new FakeWorld().add({ id: "ag-1", status: "running", createdAt: "2026-10-24T11:00:00Z", labels: { "fm.task": "t1", "fm.project": "demo" } });
  const ports = new PortSelector(new CliPort(exec));
  ports.capture({ paseo: fakePaseo(fw) }, "test");
  const deck = new Deck({ exec, ports, batchMs: 30, readConfig: async () => ({ root, firstmateLabel: "firstmate=true" }) });
  try {
    await deck.configure();
    await deck.render("demo");
    return readFileSync(join(pdir, "page.live.js"), "utf8");
  } finally { deck.stop(); }
}

test("the deck builds both links from the daemon's address and server ID", async () => {
  const live = await deckLive({ listen: "100.64.0.1:6767", serverId: "srv_AbC123" });
  assert.ok(live.includes("http://100.64.0.1:6767/h/srv_AbC123/agent/ag-1"));
  assert.ok(live.includes("paseo://h/srv_AbC123/agent/ag-1"));
});

test("the app link needs only the server ID; without one it is left out", async () => {
  const noListen = await deckLive({ serverId: "srv_AbC123" });
  assert.ok(noListen.includes("paseo://h/srv_AbC123/agent/ag-1"));
  const noId = await deckLive({ listen: "100.64.0.1:6767" });
  assert.ok(noId.includes("Open in Paseo") && !noId.includes("paseo://"));
});
