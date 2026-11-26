// The task tree: parent links, depth, roll-up and the owner chain. Pure and dependency-free (bin/fleet runs it without the plugin's
// packages installed). The registry holds only `parent` and `kind`; everything else here is computed, never stored.
//
// Shape: a project is the implicit root. A group is a task with `kind: "group"` and no crew of its own. A node has at most
// MAX_ANCESTORS ancestors, i.e. project > group > task, or project > group > group > task.

export type NodeLike = { id: string; parent?: string | null; kind?: string | null };

export const MAX_ANCESTORS = 2;

export type RollGroup = "you" | "fm" | "running" | "blocked" | "next" | "parked" | "done";

/** Most urgent first: a group takes the first of these that any open leaf is in. */
const URGENCY: RollGroup[] = ["you", "fm", "running", "blocked", "next", "parked"];
const LABEL: Record<RollGroup, string> = { you: "Needs you", fm: "With the first mate", running: "Running", blocked: "Blocked", next: "Next up", parked: "Parked", done: "Done" };

export const isGroup = (n: NodeLike | undefined): boolean => n?.kind === "group";

/** The parent chain, nearest first. Stops at a missing node (the missing id is the last entry) or on a cycle. */
export function ancestorsOf(nodes: readonly NodeLike[], id: string): string[] {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  const seen = new Set([id]);
  for (let p = by.get(id)?.parent; p && !seen.has(p); p = by.get(p)?.parent) {
    out.push(p);
    seen.add(p);
    if (!by.has(p)) break;
  }
  return out;
}

export const childrenOf = (nodes: readonly NodeLike[], id: string): NodeLike[] => nodes.filter((n) => n.parent === id);

/** Every descendant id (not `id` itself). */
export function subtreeOf(nodes: readonly NodeLike[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  const walk = (p: string) => {
    for (const c of childrenOf(nodes, p)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** Descendants that are not groups: the tasks that actually run. A group's stage rolls up from these. */
export function leavesUnder(nodes: readonly NodeLike[], id: string): NodeLike[] {
  const by = new Map(nodes.map((n) => [n.id, n]));
  return subtreeOf(nodes, id).map((x) => by.get(x)!).filter((n) => !isGroup(n));
}

/** Why `parent` cannot be the parent of `id`, or null when it can. `nodes` holds the live tasks (the new node need not be among them). */
export function parentError(nodes: readonly NodeLike[], id: string, parent: string, kind?: string | null): string | null {
  if (parent === id) return `a task cannot be the parent of itself`;
  const p = nodes.find((n) => n.id === parent);
  if (!p) return `no live task '${parent}' to be the parent`;
  if (!isGroup(p)) return `'${parent}' is not a group (kind=group): only a group can have children`;
  const up = ancestorsOf(nodes, parent);
  if (up.includes(id)) return `that would be a cycle: '${id}' is already above '${parent}'`;
  // the node and its own descendants hang below `parent`: the deepest chain must stay within the cap
  let below = Math.max(0, ...subtreeOf(nodes, id).map((d) => ancestorsOf(nodes, d).indexOf(id) + 1));
  // a group sits above at least one task, so it counts as one level below itself even while empty
  if ((kind ?? nodes.find((n) => n.id === id)?.kind) === "group") below = Math.max(below, 1);
  if (up.length + 1 + below > MAX_ANCESTORS) return `'${id}' would sit deeper than ${MAX_ANCESTORS} levels under the project`;
  return null;
}

export type Rollup = {
  group: RollGroup;
  stage: string;
  /** Leaf tasks per stage group. */
  counts: Record<RollGroup, number>;
  total: number;
  done: number;
  /** Every leaf is closed and at least one failed. */
  failed: boolean;
  reason: string;
};

/** The group's stage from its leaves' stages: the most urgent open one, done only when every leaf is done. */
export function rollup(nodes: readonly NodeLike[], id: string, stageOf: (leafId: string) => { group: RollGroup; failed?: boolean }): Rollup {
  const counts: Record<RollGroup, number> = { you: 0, fm: 0, running: 0, blocked: 0, next: 0, parked: 0, done: 0 };
  let failed = 0;
  const leaves = leavesUnder(nodes, id);
  for (const l of leaves) {
    const s = stageOf(l.id);
    counts[s.group]++;
    if (s.failed) failed++;
  }
  const total = leaves.length;
  const open = total - counts.done;
  const part = (g: RollGroup) => `${counts[g]} ${g === "you" ? "needs you" : LABEL[g].toLowerCase()}`;
  const detail = [...URGENCY, "done" as const].filter((g) => counts[g]).map(part).join(", ");
  if (!total) return { group: "next", stage: LABEL.next, counts, total, done: 0, failed: false, reason: "no tasks in this group yet" };
  if (!open) return { group: "done", stage: failed ? "Done (some failed)" : LABEL.done, counts, total, done: counts.done, failed: failed > 0, reason: `all ${total} done${failed ? `, ${failed} failed` : ""}` };
  const group = URGENCY.find((g) => counts[g]) ?? "next";
  return { group, stage: LABEL[group], counts, total, done: counts.done, failed: false, reason: detail };
}

export type OwnerHop = { id: string; via: string };

/**
 * Who a node's wakes go to, nearest first: the live second mates claiming the node itself and then each ancestor (`via` names the
 * node), then the project and checkout first mates (`via: "project"`). An agent appears once, at its nearest hop. `claimOf` and
 * `projectClaims` are already filtered to live agents by the caller.
 */
export function ownerChain(nodes: readonly NodeLike[], id: string, claimOf: (nodeId: string) => string | null, projectClaims: readonly (string | null)[]): OwnerHop[] {
  const out: OwnerHop[] = [];
  const add = (agent: string | null, via: string) => { if (agent && !out.some((o) => o.id === agent)) out.push({ id: agent, via }); };
  for (const n of [id, ...ancestorsOf(nodes, id)]) add(claimOf(n), n);
  for (const c of projectClaims) add(c, "project");
  return out;
}

/** The parts of a stage row the roll-up reads and writes (stages-file.ts `StageRow` fits). */
export type RowLike = {
  id: string;
  project: string | null;
  state: string;
  stage: string;
  group: string;
  agentId: string | null;
  flags: { key: string; text: string; drift: boolean }[];
  owner: string;
  reason: string;
  clears: string;
  fp: string;
  parent?: string | null;
  kind?: string | null;
  rollup?: { counts: Record<RollGroup, number>; total: number; done: number; failed: boolean };
};

const OWNER_OF: Record<RollGroup, string> = { you: "captain", fm: "firstmate", running: "crew", blocked: "outside", next: "nobody", parked: "nobody", done: "nobody" };

/**
 * Give every group row the stage its leaves roll up to. `archived` are finished children no longer in the live index (they count as
 * done leaves). A group keeps its own stage when it has an open ask (Needs you) or its own done/failed verdict, and stays parked when
 * parked. Its other flags are dropped: a group has no crew, so "no agent" is not drift. Rows without groups come back as they were.
 */
export function withRollups<R extends RowLike>(rows: readonly R[], archived: readonly (NodeLike & { failed?: boolean })[]): R[] {
  if (!rows.some((r) => r.kind === "group")) return rows as R[];
  const nodes: NodeLike[] = [...rows.map((r) => ({ id: r.id, parent: r.parent, kind: r.kind })), ...archived];
  const stage = new Map<string, { group: RollGroup; failed?: boolean }>();
  for (const r of rows) stage.set(r.id, { group: r.group as RollGroup, failed: r.stage.startsWith("Failed") });
  for (const a of archived) stage.set(a.id, { group: "done", failed: a.failed });
  return rows.map((r) => {
    if (r.kind !== "group") return r;
    const ro = rollup(nodes, r.id, (id) => stage.get(id) ?? { group: "done" });
    const info = { counts: ro.counts, total: ro.total, done: ro.done, failed: ro.failed };
    const own = r.group === "you" || r.state === "done" || r.state === "failed" || (r.state === "parked" && r.group === "parked");
    if (own) return { ...r, rollup: info };
    const group = ro.group;
    return { ...r, stage: ro.stage, group, owner: OWNER_OF[group], reason: ro.reason, clears: group === "fm" ? "the tasks under it say how" : "", flags: [], fp: `${ro.stage}|${ro.reason}|${r.id}`, rollup: info };
  });
}

/** The group's card: counts in one line, then each leaf's stage. Rebuilt from the rows, so it is never stale. */
export function cardMarkdown(g: RowLike, rows: readonly RowLike[], nameOf: (id: string) => string, archived: readonly (NodeLike & { failed?: boolean })[] = []): string {
  const ro = g.rollup;
  const nodes: NodeLike[] = [...rows.map((r) => ({ id: r.id, parent: r.parent, kind: r.kind })), ...archived];
  const leaves = leavesUnder(nodes, g.id);
  const by = new Map(rows.map((r) => [r.id, r]));
  const head = ro && ro.total ? `**${nameOf(g.id)}** · ${g.stage}\n\n${ro.done} of ${ro.total} done · ${g.reason}` : `**${nameOf(g.id)}** · ${g.stage}\n\n${g.reason}`;
  if (!leaves.length) return head;
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const lines = leaves.map((l) => `| ${cell(nameOf(l.id))} | ${cell(by.get(l.id)?.stage ?? (archived.find((a) => a.id === l.id)?.failed ? "Failed" : "Done"))} |`);
  return [head, "", "| Task | Stage |", "|---|---|", ...lines].join("\n");
}
