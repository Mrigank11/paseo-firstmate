import { test } from "node:test";
import assert from "node:assert/strict";
import { canvasInput } from "../server/canvas-view.ts";
import { computeStage } from "../server/stage.ts";
import type { FmSummary } from "../server/canvas-port.ts";
import type { TrailComment } from "../server/state.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
const summary = { agentId: "ag", verdict: { label: "Needs you", flags: [], needsYou: true }, openAsks: [{ id: "q1", question: "?", options: [], blocking: true }] } as unknown as FmSummary;
const click = (at: string): TrailComment => ({ id: "c1", at, target: "t-job#c-q1", text: "", delivered: true, answered: false, choice: { ask: "q1", option: "a" } });
const agent = { id: "ag", status: "idle", archived: false, createdAt: "2026-10-28T09:00:00Z", lastActivityAt: "2026-10-28T11:30:00Z", pendingPermissions: 0, final: "BLOCKED: canvas ask q1" };

test("a click from before the crew's last activity answered an earlier q1: the new q1 is Needs you, not With the first mate", () => {
  const stale = [click("2026-10-28T10:00:00Z")];
  const s = computeStage({ state: "active", asks: [] }, [agent], NOW, { canvas: canvasInput(summary, "job", stale, agent.lastActivityAt) });
  assert.deepEqual([s.stage, s.group], ["Needs you", "you"]);
});

test("a click after the crew's last activity is a pick still waiting on the first mate", () => {
  const fresh = [click("2026-10-28T11:45:00Z")];
  const s = computeStage({ state: "active", asks: [] }, [agent], NOW, { canvas: canvasInput(summary, "job", fresh, agent.lastActivityAt) });
  assert.deepEqual([s.stage, s.group], ["With the first mate", "fm"]);
});
