// The Project pages screen: sort, active filter, empty state and card text (the client's pure parts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectSummary } from "../shared/contract.ts";
import { cardText, emptyState, isActiveProject, sortProjects, toggleLabel, visibleProjects } from "../client/projects.ts";

function mk(project: string, over: Partial<ProjectSummary> & { needs?: number; run?: number } = {}): ProjectSummary {
  const { needs = 0, run = 0, ...rest } = over;
  return {
    project,
    title: project,
    repo: null,
    pageUrl: `http://lavish/${project}`,
    session: "open",
    needsYou: Array.from({ length: needs }, (_, i) => ({ taskId: `t${i}`, askId: `a${i}`, taskTitle: `Task ${i}`, text: `Question ${i}?`, since: "2026-10-29T00:00:00Z" })),
    running: [],
    counts: { needsYou: needs, running: run, next: 0, parked: 0, done: 0 },
    undelivered: 0,
    banner: null,
    ...rest,
  };
}

const ended = mk("old", { session: "ended" });
const quiet = mk("quiet");
const busy = mk("busy", { run: 3 });
const hot = mk("hot", { needs: 2 });
const alpha = mk("alpha", { run: 3 });

test("sort: needs-you desc, then running desc, then name", () => {
  assert.deepEqual(sortProjects([quiet, busy, alpha, hot]).map((p) => p.project), ["hot", "alpha", "busy", "quiet"]);
});

test("active filter hides ended projects with no live work; show all brings them back", () => {
  const all = [ended, quiet, hot];
  assert.equal(isActiveProject(ended), false);
  assert.deepEqual(visibleProjects(all, false).map((p) => p.project), ["hot", "quiet"]);
  assert.deepEqual(visibleProjects(all, true).map((p) => p.project), ["hot", "old", "quiet"]);
});

test("an ended project that still has an open ask, or a stopped one that is running, stays visible", () => {
  assert.equal(isActiveProject(mk("x", { session: "ended", needs: 1 })), true);
  assert.equal(isActiveProject(mk("y", { session: "stopped", run: 1 })), true);
});

test("empty state gives the start hint, or the hidden count", () => {
  assert.equal(emptyState(0).title, "No project pages yet");
  assert.match(emptyState(0).hint, /bin\/page start/);
  assert.match(emptyState(2).hint, /2 ended or stopped, hidden/);
});

test("show-all toggle only appears when something is hidden or already shown", () => {
  assert.equal(toggleLabel(false, 0), null);
  assert.equal(toggleLabel(false, 2), "Show all (2 ended)");
  assert.equal(toggleLabel(true, 2), "Hide ended");
});

test("card text: link or 'Page not opened', counts, banner, asks", () => {
  const c = cardText(mk("hot", { needs: 1, banner: "first mate unreachable" }), "1 needs you");
  assert.deepEqual(c, { link: "Open page", counts: "1 needs you", banner: "first mate unreachable", asks: ["Question 0?"] });
  assert.equal(cardText(mk("p", { pageUrl: null }), "").link, "Page not opened");
});
