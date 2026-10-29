import type { ProjectSummary } from "../shared/contract";

/** A project is live when its session is open, or it still has work that is not finished. */
export function isActiveProject(p: ProjectSummary): boolean {
  if (p.session === "open") return true;
  const c = p.counts;
  return p.needsYou.length > 0 || c.needsYou > 0 || (c.withFirstMate ?? 0) > 0 || c.running > 0 || (c.blocked ?? 0) > 0 || p.running.length > 0;
}

/** Needs-you count descending, then running, then name. */
export function sortProjects(projects: readonly ProjectSummary[]): ProjectSummary[] {
  const needs = (p: ProjectSummary) => Math.max(p.counts.needsYou, p.needsYou.length);
  return [...projects].sort(
    (a, b) => needs(b) - needs(a) || b.counts.running - a.counts.running || a.title.localeCompare(b.title),
  );
}

/** The cards to show: active projects only, unless `showAll`. */
export function visibleProjects(projects: readonly ProjectSummary[], showAll: boolean): ProjectSummary[] {
  return sortProjects(showAll ? projects : projects.filter(isActiveProject));
}

export function emptyState(hidden: number): { title: string; hint: string } {
  return {
    title: "No project pages yet",
    hint: hidden > 0 ? `${hidden} ended or stopped, hidden. Use "Show all" to see them.` : "Run `bin/page start <project>` in the first mate's checkout to create one.",
  };
}

export function toggleLabel(showAll: boolean, hidden: number): string | null {
  if (showAll) return "Hide ended";
  return hidden > 0 ? `Show all (${hidden} ended)` : null;
}

/** Text the card shows for a project, in order: the page link slot, the counts line, the banner, then each ask. */
export function cardText(p: ProjectSummary, counts: string): { link: string; counts: string; banner: string | null; asks: string[] } {
  return { link: p.pageUrl ? "Open page" : "Page not opened", counts, banner: p.banner, asks: p.needsYou.map((a) => a.text) };
}
