import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../server/config.ts";

test("settings win; FIRSTMATE_ROOT is the fallback for an empty root", () => {
  assert.equal(resolveConfig({ firstmateRoot: "/a" }, { FIRSTMATE_ROOT: "/b" }).root, "/a");
  assert.equal(resolveConfig({ firstmateRoot: "" }, { FIRSTMATE_ROOT: "/b" }).root, "/b");
  assert.equal(resolveConfig({}, {}).root, "");
});

test("lavish port: explicit setting, else environment, else leave to Lavish", () => {
  assert.equal(resolveConfig({ lavishPort: 4390 }, { LAVISH_AXI_PORT: "5000" }).lavishPort, "4390");
  assert.equal(resolveConfig({ lavishPort: 4387 }, { LAVISH_AXI_PORT: "5000" }).lavishPort, "5000");
  assert.equal(resolveConfig({ lavishPort: 4387 }, {}).lavishPort, "4387");
  assert.equal(resolveConfig({}, {}).lavishPort, undefined);
});

test("lavish state dir: setting, else environment, else undefined", () => {
  assert.equal(resolveConfig({ lavishStateDir: "/s" }, { LAVISH_AXI_STATE_DIR: "/e" }).lavishStateDir, "/s");
  assert.equal(resolveConfig({ lavishStateDir: "" }, { LAVISH_AXI_STATE_DIR: "/e" }).lavishStateDir, "/e");
  assert.equal(resolveConfig({ lavishStateDir: "" }, {}).lavishStateDir, undefined);
});

test("normalizeRoot: ~ expanded, symlinks resolved, a missing state/ is reported", async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync } = await import("node:fs");
  const { tmpdir, homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { normalizeRoot } = await import("../server/config.ts");
  const real = realpathSync(mkdtempSync(join(tmpdir(), "deck-root-")));
  mkdirSync(join(real, "state"));
  const link = join(mkdtempSync(join(tmpdir(), "deck-link-")), "fm");
  symlinkSync(real, link);
  assert.deepEqual(normalizeRoot(link), { root: real });
  assert.deepEqual(normalizeRoot(""), { root: "" });
  assert.equal(normalizeRoot("~/definitely-not-here-xyz").root, join(homedir(), "definitely-not-here-xyz"));
  assert.match(normalizeRoot("~/definitely-not-here-xyz").problem!, /does not exist/);
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "deck-bare-")));
  assert.match(normalizeRoot(bare).problem!, /no state\/ directory/);
});

test("canvasUrl: the default, an explicit setting, the environment while the setting is the default, and 'off'", () => {
  const url = (s: object, env: Record<string, string> = {}) => resolveConfig(s as any, env).canvasUrl;
  assert.equal(url({}), "http://127.0.0.1:6790");
  assert.equal(url({ canvasUrl: "http://127.0.0.1:6790" }), "http://127.0.0.1:6790");
  assert.equal(url({ canvasUrl: "http://127.0.0.1:6791" }, { AGENT_CANVAS_URL: "http://x:1" }), "http://127.0.0.1:6791");
  assert.equal(url({ canvasUrl: "http://127.0.0.1:6790" }, { AGENT_CANVAS_URL: "http://127.0.0.1:6791" }), "http://127.0.0.1:6791");
  assert.equal(url({ canvasUrl: "off" }, { AGENT_CANVAS_URL: "http://x:1" }), "");
  assert.equal(resolveConfig({ canvasDir: "/c" } as any, {}).canvasDir, "/c");
});
