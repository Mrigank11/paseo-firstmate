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
