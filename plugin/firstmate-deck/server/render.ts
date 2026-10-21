// renderProject: ProjectModel + live agent views -> { page, live, signature }. Pure, no I/O.
import { createHash } from "node:crypto";
import { cut } from "./humanize.ts";
import { markdown } from "./markdown.ts";
import { pageScript } from "./page-script.ts";
import { CSS } from "./style.ts";
import type { ProjectModel, Task, TrailComment } from "./state.ts";

export type AgentView = {
  status: "initializing" | "idle" | "running" | "error" | "closed" | "archived" | "unknown";
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  thinking?: string;
  stepCount: number;
  /** `stepCount` is a lower bound: only a bounded tail of the agent's timeline was read. */
  stepsAtLeast?: boolean;
  /** Last-known state, shown while the daemon cannot be asked (no SDK handle yet, or the last refresh failed). */
  stale?: boolean;
  /** Already humanized, oldest first, max 8. */
  recent: string[];
  /** The DONE:/BLOCKED: line, if any. */
  final?: string;
};

export const STALE_PILL = "status unknown (reconnecting)";

export type Banner = { kind: "unreachable" | "ended" | "plugin-down"; text: string };

export type RenderOpts = {
  now: Date;
  paseoAgentUrl: (id: string) => string;
  banner?: Banner;
  tickSeconds: number;
  /** How often the plugin re-renders even when nothing changed (it says so in the page text). Default 20. */
  refreshSeconds?: number;
  /** Basename of the page file; its `.live.js` sibling is polled. Defaults to the project's configured page, else "page.html". */
  pageFile?: string;
};

export type Rendered = { page: string; live: string; signature: string };

const GROUPS = [
  ["you", "Needs you"],
  ["fm", "With the first mate"],
  ["running", "Running"],
  ["next", "Next up"],
  ["parked", "Parked"],
  ["done", "Done"],
] as const;
type GroupKey = (typeof GROUPS)[number][0];

const DEFAULT_TITLES: Record<string, string> = {
  endpoints: "Endpoints & creds",
  flags: "Flags",
  code: "Local code changes",
  decisions: "Decisions",
  how: "How it runs",
};

const ACTIVE = new Set(["running", "initializing"]);

export const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const pad = (n: number) => String(n).padStart(2, "0");

export function dur(sec: number): string {
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${pad(m % 60)} min` : `${Math.floor(m / 1440)} d`;
}

function stampLong(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

const stampShort = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function groupOf(t: Task, live: boolean): GroupKey {
  if (live && t.asks.length > 0) return t.asks.some((a) => !a.repliedAt) ? "you" : "fm";
  if (live && t.status === "needs-captain") return "you";
  if (t.status === "dispatched" || t.status === "running") return "running";
  if (t.status === "done" || t.status === "failed") return "done";
  if (t.status === "parked") return "parked";
  return "next"; // queued and anything unrecognised
}

function pill(group: GroupKey, ast: string): [string, string] {
  if (ACTIVE.has(ast)) return ["running", "running"];
  if (ast === "error") return ["error", "error"];
  if (group === "you") return ["you", "waiting on you"];
  if (group === "done") return ["done", "done"];
  return ["idle", ast || "idle"];
}

function agentBlock(t: Task, group: GroupKey, view: AgentView | undefined, o: RenderOpts): string {
  const aid = t.agentId as string;
  const url = esc(o.paseoAgentUrl(aid));
  if (group === "done") { // frozen: the agent id may be reused later, so show none of its live state
    const [cls, label] = t.status === "failed" ? ["error", "failed"] : ["done", "done"];
    return `<div class="ag"><span class="pill p-${cls}"><span class="dot"></span>${label}</span><a class="open" href="${url}">Open in Paseo</a></div>`;
  }
  const a: AgentView = view ?? { status: "unknown", stepCount: 0, recent: [] };
  const ast = a.stale ? "unknown" : a.status;
  const [cls, label] = a.stale ? ["idle", STALE_PILL] : pill(group, ast);
  const c = a.createdAt ? new Date(a.createdAt) : null;
  const u = a.updatedAt ? new Date(a.updatedAt) : null;
  const ok = (d: Date | null): d is Date => !!d && !isNaN(d.getTime());
  const el = !a.stale && ok(c) && ok(u)
    ? ACTIVE.has(ast) ? `${dur((o.now.getTime() - c.getTime()) / 1000)} so far` : `took ${dur((u.getTime() - c.getTime()) / 1000)}`
    : "";
  const model = [a.model, a.thinking].filter(Boolean).join(" ");
  const facts = [a.stepCount ? `${a.stepCount}${a.stepsAtLeast ? "+" : ""} steps` : "", el, model, ast === "archived" ? "archived" : ""].filter(Boolean).join(" · ");
  const cur = ACTIVE.has(ast) && a.recent.length ? a.recent[a.recent.length - 1] : a.final || a.recent[a.recent.length - 1] || "";
  const head =
    `<div class="ag"><span class="pill p-${cls}"><span class="dot"></span>${esc(label)}</span>` +
    `<span class="facts">${esc(facts)}</span><a class="open" href="${url}">Open in Paseo</a></div>`;
  if (!cur) return head;
  if (!a.recent.length) return head + `<div class="cur">${esc(cut(cur, 160))}</div>`;
  const lis = a.recent.map((s) => `<li>${esc(s)}</li>`).join("");
  return (
    head +
    `<details class="stp" id="s-${esc(t.id)}"><summary class="cur">${esc(cut(cur, 160))}</summary>` +
    `<ol start="${Math.max(1, a.stepCount - a.recent.length + 1)}">${lis}</ol></details>`
  );
}

const DAY_MS = 24 * 3600 * 1000;
const LATE_MS = 10_000;

/** The captain's comment trail for one target: latest comment, a count, and where it stands (from the inbox flags). */
export function trailHtml(all: TrailComment[], target: string, now: Date): string {
  // comments on an ask ("t-<task>#a<n>") show in their card's trail too
  const mine = all.filter((c) => (c.target === target || c.target.startsWith(target + "#")) && (!c.answered || now.getTime() - Date.parse(c.at) < DAY_MS));
  if (!mine.length) return "";
  const last = mine.reduce((a, b) => (Date.parse(b.at) >= Date.parse(a.at) ? b : a));
  const d = new Date(last.at);
  const hm = isNaN(d.getTime()) ? "" : ` · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const said = last.choice
    ? `picked <b>${esc(cut(last.choice.option, 100))}</b>`
    : `“${esc(cut(last.text.replace(/\s+/g, " ").trim(), 100))}”`;
  let chip: string;
  if (last.answered) chip = `<span class="st st-answered">answered</span>`;
  else if (last.delivered) chip = `<span class="st st-has">first mate has it</span>`;
  else chip = `<span class="st ${now.getTime() - Date.parse(last.at) > LATE_MS ? "st-late" : "st-send"}">sending…</span>`;
  const n = mine.length > 1 ? `<span class="tr-n">${mine.length} comments</span>` : "";
  return `<div class="trail"><span class="tr-who">💬 You${hm}</span><span class="tr-txt">${said}</span>${n}${chip}</div>`;
}

type Ctx = { byId: Map<string, Task>; unblocks: Map<string, string[]>; agents: Record<string, AgentView>; o: RenderOpts; comments: TrailComment[] };

function row(t: Task, group: GroupKey, ctx: Ctx): string {
  const name = esc(t.title || t.intent || t.id);
  const title = t.agentId ? `<a href="${esc(ctx.o.paseoAgentUrl(t.agentId))}">${name}</a>` : name;
  const failed = t.status === "failed";
  const chip = failed ? `<span class="chip c-fail">failed</span>` : "";
  const out = [
    `<article class="task s-${group}${failed ? " s-failed" : ""}" id="t-${esc(t.id)}">`,
    `<div class="tt"><span class="ttl">${title}</span>${chip}</div>`,
    trailHtml(ctx.comments, `t-${t.id}`, ctx.o.now),
  ];
  t.asks.forEach((a, i) => {
    const n = i + 1;
    const box: string[] = [];
    const asked = `<div class="ask asked">${esc(a.text)}</div>`;
    if (a.repliedAt && a.replyChoice) {
      box.push(asked, `<div class="ask replied picked">You picked <b>${esc(a.replyChoice)}</b> · the first mate is applying it</div>`);
    } else if (a.repliedAt && a.replyText !== undefined) {
      const d = new Date(a.repliedAt);
      const hm = isNaN(d.getTime()) ? "" : ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      box.push(asked, `<div class="ask replied">You replied${hm}: “${esc(cut(a.replyText, 120))}” · the first mate is on it</div>`);
    } else if (a.repliedAt) { // marked pending by the first mate (bin/page reply --followup), no comment to quote
      box.push(asked, `<div class="ask replied">The first mate is working on a follow-up</div>`);
    } else {
      box.push(`<div class="ask"><b>Your call:</b> ${esc(a.text)}</div>`);
      if (a.options?.length) {
        const key = `ask-${t.id}-${n}`;
        const btns = a.options.map((o) =>
          `<button type="button" class="opt" data-task="${esc(t.id)}" data-ask="${n}" data-opt="${esc(o)}" data-title="${name}">${esc(o)}</button>`).join("");
        box.push(`<div class="opts" data-key="${esc(key)}"><div class="opt-row">${btns}<span class="hint">or comment on the card</span></div><div class="pickline" role="status" hidden></div></div>`);
      }
    }
    if (a.contextMd.trim()) {
      box.push(`<details class="actx" id="x-${esc(t.id)}-${n}"><summary>Context</summary><div>${markdown(a.contextMd)}</div></details>`);
    }
    // One block per ask: a comment anywhere inside it (text, option buttons, context) targets this ask.
    out.push(`<div class="askbox" id="a-${esc(t.id)}-${n}">${box.join("")}</div>`);
  });
  if (t.agentId) out.push(agentBlock(t, group, ctx.agents[t.agentId], ctx.o));
  const body = t.card.trim() ? markdown(t.card) : esc(t.notes);
  if (body) out.push(`<div class="nt">${body}</div>`);
  const link = (id: string) => `<a href="#t-${esc(id)}">${esc(ctx.byId.get(id)!.title || ctx.byId.get(id)!.intent || id)}</a>`;
  const dep = t.depends_on.filter((d) => ctx.byId.has(d)).map(link);
  const unb = (ctx.unblocks.get(t.id) ?? []).map(link);
  if (dep.length || unb.length) {
    out.push(
      '<div class="dp">' +
        [dep.length ? "after " + dep.join(", ") : "", unb.length ? "then " + unb.join(", ") : ""].filter(Boolean).join(" · ") +
        "</div>",
    );
  }
  return out.join("") + "</article>";
}

function renderLive(model: ProjectModel, agents: Record<string, AgentView>, o: RenderOpts): string {
  const liveIds = new Set(model.tasks.map((t) => t.id));
  const archive = model.archive.filter((t) => !liveIds.has(t.id)).reverse(); // newest first
  const all = [...model.tasks, ...archive];
  const byId = new Map(all.map((t) => [t.id, t]));
  const unblocks = new Map<string, string[]>();
  for (const t of all) for (const d of t.depends_on) unblocks.set(d, [...(unblocks.get(d) ?? []), t.id]);
  const ctx: Ctx = { byId, unblocks, agents, o, comments: model.comments };

  const buckets: Record<GroupKey, { t: Task; g: GroupKey }[]> = { you: [], fm: [], running: [], next: [], parked: [], done: [] };
  for (const t of model.tasks) buckets[groupOf(t, true)].push({ t, g: groupOf(t, true) });
  for (const t of archive) buckets.done.push({ t, g: "done" });
  // live done tasks come before archived ones (model.tasks were pushed first)

  const busy = GROUPS.filter(([k]) => k !== "done").flatMap(([k]) => buckets[k])
    .filter(({ t }) => t.agentId && ACTIVE.has(agents[t.agentId]?.status ?? "")).length;
  let summary = GROUPS.filter(([k]) => buckets[k].length)
    .map(([k, n]) => `<a href="#g-${k}" class="sum c-${k}">${buckets[k].length} ${k === "you" ? "needs you" : n.toLowerCase()}</a>`)
    .join("");
  if (busy) summary += `<span class="sum c-running">${busy} agent${busy > 1 ? "s" : ""} working</span>`;
  const parts = [`<div class="summary">${summary}<span class="m">live: the page checks ${o.tickSeconds === 1 ? "every second" : `every ${o.tickSeconds} s`}; the plugin refreshes it on every change and at least every ${o.refreshSeconds ?? 20} s (last refresh {TS})</span></div>`];
  for (const [k, n] of GROUPS) {
    const items = buckets[k];
    if (!items.length) continue;
    const rows = items.map(({ t, g }) => row(t, g, ctx)).join("\n");
    const h = `<h3>${n} <span class="n">(${items.length})</span></h3>`;
    if (k === "done" || k === "parked") parts.push(`<details class="grp" id="g-${k}"><summary>${h}</summary>\n${rows}</details>`);
    else parts.push(`<section class="grp" id="g-${k}">${h}\n${rows}</section>`);
  }
  if (parts.length === 1) parts.push(`<div class="m">No tasks for this project yet.</div>`);
  // Trails for the page and the sections live outside the live block (page.html is not rewritten per comment);
  // the page script copies these into their slots after every swap.
  const slots = ["page", ...model.sections.map((s) => s.name)]
    .map((k) => [k, trailHtml(model.comments, k, o.now)] as const).filter(([, h]) => h)
    .map(([k, h]) => `<div data-trail-for="${esc(k)}">${h}</div>`).join("");
  parts.push(`<div hidden data-trails>${slots}</div>`);
  return parts.join("\n");
}

function renderSection(model: ProjectModel, name: string): string {
  const s = model.sections.find((x) => x.name === name)!;
  const title = model.sectionTitles[name] ?? DEFAULT_TITLES[name] ?? titleCase(name);
  const body = s.kind === "html" ? s.content : markdown(s.content);
  return `<section id="${esc(name)}" data-section="${esc(name)}"><h2>${esc(title)}</h2>\n<div class="trail-slot" data-trail-slot="${esc(name)}"></div>\n${body}\n</section>`;
}

/** `iso` is when the plugin produced this payload; the page script compares it with the browser clock to flag a stalled plugin. */
export function liveJs(liveHtml: string, iso?: string): string {
  return `window.__fdLive&&window.__fdLive(${JSON.stringify(liveHtml)}${iso ? `,${JSON.stringify(iso)}` : ""});\n`;
}

export const STALE_TEXT = "This page stopped updating: comments may not reach the first mate. Ask the first mate to run bin/page heal.";

export function renderProject(model: ProjectModel, agents: Record<string, AgentView>, opts: RenderOpts): Rendered {
  const live = renderLive(model, agents, opts);
  const pageFile = opts.pageFile ?? (model.page ? model.page.slice(model.page.lastIndexOf("/") + 1) : "page.html");
  const liveFile = pageFile.replace(/\.[^./]*$/, "") + ".live.js";

  const sig = createHash("sha1")
    .update(JSON.stringify([
      { ...model, comments: undefined },
      opts.banner ?? null,
      Object.keys(agents).sort().map((id) => [id, agents[id].status]),
    ]))
    .digest("hex");

  const names = model.sections.map((s) => s.name);
  const nav = [`<a href="#tasks">Tasks</a>`, ...names.map((n) =>
    `<a href="#${esc(n)}">${esc(model.sectionTitles[n] ?? DEFAULT_TITLES[n] ?? titleCase(n))}</a>`)].join("");
  const banner = opts.banner
    ? `<div class="banner ${opts.banner.kind === "ended" ? "b-off" : "b-bad"}" role="status">${esc(opts.banner.text)}</div>`
    : "";
  const stamped = live.replace(/\{TS\}/g, stampShort(opts.now));

  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.title)} · status</title>
<style>
${CSS}
</style>
</head><body><main>
<h1>${esc(model.title)}</h1>
<div class="sub">Kept current by the firstmate-deck plugin · last update <b>${esc(stampLong(opts.now))}</b></div>
<p class="chan"><b>This page is our channel.</b> Comment on any card or block, then Send; the first mate answers here.</p>
<div class="trail-slot" data-trail-slot="page"></div>
<div class="banner b-bad" id="fd-stale" role="status" hidden>${esc(STALE_TEXT)}</div>
${banner}
<nav>${nav}</nav>

<h2 id="tasks">Tasks</h2>
<div class="m">Each task once: its state, its crew agent live, and what it depends on. Titles and “Open in Paseo” go to the agent in the Paseo web UI.</div>
<div id="live"><!--LIVE-START-->${stamped}<!--LIVE-END--></div>
${names.map((n) => renderSection(model, n)).join("\n")}
<script>
${pageScript(model.project, liveFile, opts.tickSeconds)}
</script>
</main></body></html>
`;
  return { page, live, signature: sig };
}
