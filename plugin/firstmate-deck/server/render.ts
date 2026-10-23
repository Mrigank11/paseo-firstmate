// renderProject: ProjectModel + live agent views -> { page, live, signature }. Pure, no I/O.
import { createHash } from "node:crypto";
import { cut } from "./humanize.ts";
import { cardHash } from "./marks.ts";
import { inline, markdown } from "./markdown.ts";
import { ICON, svg } from "./icons.ts";
import { navScript } from "./nav-script.ts";
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

export type Banner = { kind: "unreachable" | "ended" | "plugin-down" | "state"; text: string };

export type RenderOpts = {
  now: Date;
  paseoAgentUrl: (id: string) => string;
  banner?: Banner;
  tickSeconds: number;
  /** How often the plugin re-renders even when nothing changed (it says so in the page text). Default 20. */
  refreshSeconds?: number;
  /** Basename of the page file; its `.live.js` sibling is polled. Defaults to the project's configured page, else "page.html". */
  pageFile?: string;
  /** Where the page syncs its read marks (the plugin's marks endpoint, e.g. http://host:4398/<project>/state). Without it the marks live in the browser only. */
  marksUrl?: string;
};

export type Rendered = { page: string; live: string; signature: string };

const GROUPS = [
  ["you", "Needs you"],
  ["fm", "With the first mate"],
  ["running", "Running"],
  ["blocked", "Blocked"],
  ["next", "Next up"],
  ["parked", "Parked"],
  ["done", "Done"],
] as const;
type GroupKey = (typeof GROUPS)[number][0];

/** Each stage's navigator icon. A Record over GroupKey, so a new stage cannot ship without one. */
const STAGE_ICON: Record<GroupKey, string> = {
  you: ICON.you, fm: ICON.fm, running: ICON.running, blocked: ICON.blocked, next: ICON.next, parked: ICON.parked, done: ICON.done,
};
/** A navigator stage longer than this shows its first NAV_SHOW titles and an "N more" button. */
const NAV_CAP = 7;
const NAV_SHOW = 5;

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
  if (t.status === "blocked") return "blocked";
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
    const who = t.provider ? `<span class="facts">${esc(t.provider)}</span>` : "";
    return `<div class="ag"><span class="pill p-${cls}"><span class="dot"></span>${label}</span>${who}<a class="open" href="${url}">Open in Paseo</a></div>`;
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
  // Paseo has no record of the agent (or none yet): fall back to the provider/model the task itself names
  const model = [a.model || t.provider, a.thinking].filter(Boolean).join(" ");
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

/** Where a comment stands: sending… / first mate has it / answered (from the inbox flags). */
export function chipHtml(c: { at: string; delivered: boolean; answered: boolean }, now: Date): string {
  if (c.answered) return `<span class="st st-answered">answered</span>`;
  if (c.delivered) return `<span class="st st-has">first mate has it</span>`;
  return `<span class="st ${now.getTime() - Date.parse(c.at) > LATE_MS ? "st-late" : "st-send"}">sending…</span>`;
}

/**
 * The captain's comment trail for one target: latest comment, a count, and where it stands. Exactly the comments on
 * `target`, plus any `also` accepts (a card also shows the comments on asks that are no longer open).
 */
export function trailHtml(all: TrailComment[], target: string, now: Date, also?: (c: TrailComment) => boolean): string {
  const mine = all.filter((c) => (c.target === target || also?.(c)) && (!c.answered || now.getTime() - Date.parse(c.at) < DAY_MS));
  if (!mine.length) return "";
  const last = mine.reduce((a, b) => (Date.parse(b.at) >= Date.parse(a.at) ? b : a));
  const d = new Date(last.at);
  const hm = isNaN(d.getTime()) ? "" : ` · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const said = last.choice
    ? last.stale
      ? `clicked <b>${esc(cut(last.choice.option, 100))}</b> <span class="tr-stale">(that question was already closed, so it was not applied)</span>`
      : `picked <b>${esc(cut(last.choice.option, 100))}</b>`
    : `“${esc(cut(last.text.replace(/\s+/g, " ").trim(), 100))}”`;
  const n = mine.length > 1 ? `<span class="tr-n">${mine.length} comments</span>` : "";
  return `<div class="trail"><span class="tr-who">💬 You${hm}</span><span class="tr-txt">${said}</span>${n}${chipHtml(last, now)}</div>`;
}

type Ctx = { byId: Map<string, Task>; unblocks: Map<string, string[]>; agents: Record<string, AgentView>; o: RenderOpts; comments: TrailComment[] };

/**
 * An ask's context repeats the ask text when it came from a longer text (the first sentence, bold or not). Show it once:
 * drop that leading sentence from the displayed context. The stored context file is not changed.
 */
export function contextBody(text: string, md: string): string {
  const want = text.replace(/\s+/g, " ").trim();
  let i = 0, j = 0;
  while (j < want.length && i < md.length) {
    if (md[i] === "*") { i++; continue; }
    if (/\s/.test(md[i]) && /\s/.test(want[j])) { while (i < md.length && /\s/.test(md[i])) i++; j++; continue; }
    if (md[i] !== want[j]) return md;
    i++; j++;
  }
  if (j < want.length) return md;
  const rest = md.slice(i);
  // the first sentence ended inside a bold span ("**BLUF: a. b.**"): the rest of that span stays bold
  const tail = rest.replace(/^\s+/, "");
  if (/^\*\*(\s|$)/.test(tail)) return tail.replace(/^\*\*\s*/, "").replace(/^\s+/, ""); // the span closed right after the sentence
  return ((tail.match(/\*\*/g) ?? []).length % 2 === 1 ? "**" : "") + tail;
}

const NOTES_MARK = "\n\n## Notes\n\n";
/** A done card with a brief and notes: the brief is the body, the notes sit in a collapsed <details>. */
function cardHtml(t: Task): string {
  const i = t.card.indexOf(NOTES_MARK);
  if (i < 0) return markdown(t.card);
  return `${markdown(t.card.slice(0, i))}<details class="cnotes" id="n-${esc(t.id)}"><summary>Notes</summary>${markdown(t.card.slice(i + NOTES_MARK.length))}</details>`;
}

/** A done task whose card the captain can mark read: it has a non-empty card.md. */
export const markable = (t: Task): boolean => t.card.trim() !== "";

function row(t: Task, group: GroupKey, ctx: Ctx, idx = 0): string {
  const name = esc(t.title || t.intent || t.id);
  const title = t.agentId ? `<a href="${esc(ctx.o.paseoAgentUrl(t.agentId))}">${name}</a>` : name;
  const failed = t.status === "failed";
  const chip = failed ? `<span class="chip c-fail">failed</span>` : "";
  // Done cards carry their position (data-i) so the page can put a card back in order when it moves it between the
  // unread and read groups, and (when they have a card) the hash the read mark is keyed by (data-h) and a button.
  const done = group === "done";
  const mark = done && markable(t);
  const data = done ? ` data-i="${idx}"${mark ? ` data-h="${cardHash(t.card)}"` : ""}` : "";
  const btn = mark ? `<button class="mr" type="button">Mark read</button>` : "";
  const out = [
    `<article class="task s-${group}${failed ? " s-failed" : ""}" id="t-${esc(t.id)}"${data}>`,
    `<div class="tt"><span class="ttl">${title}</span>${chip}${btn}</div>`,
    // card-level comments, plus comments on asks that are gone (an answered ask takes its own trail with it)
    trailHtml(ctx.comments, `t-${t.id}`, ctx.o.now, (c) => c.target.startsWith(`t-${t.id}#`) && !t.asks.some((a) => c.target === `t-${t.id}#${a.id}`)),
  ];
  t.asks.forEach((a) => {
    const box: string[] = [];
    const asked = `<div class="ask asked">${inline(a.text)}</div>`;
    const key = `ask-${t.id}-${a.id}`;
    const buttons = (picked?: string) => (a.options ?? []).map((o, k) => {
      const on = picked !== undefined && o === picked;
      return `<button type="button" class="opt${on ? " on" : ""}" id="o-${esc(t.id)}-${esc(a.id)}-${k + 1}" data-task="${esc(t.id)}" data-ask="${esc(a.id)}" data-opt="${esc(o)}" data-title="${name}" aria-pressed="${on}"${picked !== undefined && !on ? " disabled" : ""}>${esc(o)}</button>`;
    }).join("");
    const reply = { at: a.repliedAt ?? "", delivered: a.replyDelivered === true, answered: a.replyAnswered === true };
    let trail = "";
    if (a.repliedAt && a.replyChoice) {
      box.push(asked);
      const line = `<div class="pickline" role="status">You picked <b>${esc(a.replyChoice)}</b> · the first mate is applying it ${chipHtml(reply, ctx.o.now)}</div>`;
      box.push(a.options?.includes(a.replyChoice)
        ? `<div class="opts" data-key="${esc(key)}"><div class="opt-row">${buttons(a.replyChoice)}</div>${line}</div>`
        : `<div class="ask replied picked">${line}</div>`);
    } else if (a.repliedAt && a.replyText !== undefined) {
      const d = new Date(a.repliedAt);
      const hm = isNaN(d.getTime()) ? "" : ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      box.push(asked, `<div class="ask replied">You replied${hm}: “${esc(cut(a.replyText, 120))}” · the first mate is on it ${chipHtml(reply, ctx.o.now)}</div>`);
    } else if (a.repliedAt) { // marked pending by the first mate (bin/page reply --followup), no comment to quote
      box.push(asked, `<div class="ask replied">The first mate is working on a follow-up</div>`);
    } else {
      // a "BLUF: ..." text is its own label: no "Your call:" in front of it (no doubled colon), and it is the bold one-liner
      box.push(/^BLUF:/i.test(a.text) ? `<div class="ask"><b>${inline(a.text)}</b></div>` : `<div class="ask"><b>Your call:</b> ${inline(a.text)}</div>`);
      if (a.options?.length) {
        box.push(`<div class="opts" data-key="${esc(key)}"><div class="opt-row">${buttons()}<span class="hint">or comment on the card</span></div><div class="pickline" role="status" hidden></div></div>`);
      }
      trail = trailHtml(ctx.comments, `t-${t.id}#${a.id}`, ctx.o.now); // this ask's own comments, right under it
    }
    if (trail) box.push(trail);
    const ctxMd = contextBody(a.text, a.contextMd);
    if (ctxMd.trim()) {
      // open by default while the ask needs the captain (the page remembers a collapse per browser)
      const open = group === "you" && !a.repliedAt ? " open" : "";
      box.push(`<details class="actx" id="x-${esc(t.id)}-${esc(a.id)}"${open}><summary>Context</summary><div>${markdown(ctxMd)}</div></details>`);
    }
    // One block per ask: a comment anywhere inside it (text, option buttons, context) targets this ask.
    out.push(`<div class="askbox" id="a-${esc(t.id)}-${esc(a.id)}">${box.join("")}</div>`);
  });
  // asks the first mate already answered stay readable on the finished card
  if (group === "done") for (const a of t.answered ?? []) {
    const ctxMd = contextBody(a.text, a.contextMd);
    const ans = a.text ? `<div class="ask asked">${inline(a.text)}</div>` : "";
    const detail = ctxMd.trim() ? `<details class="actx" id="x-${esc(t.id)}-${esc(a.id)}"><summary>Context</summary><div>${markdown(ctxMd)}</div></details>` : "";
    if (ans || detail) out.push(`<div class="askbox answered" id="a-${esc(t.id)}-${esc(a.id)}"><div class="ask-tag">Answered</div>${ans}${detail}</div>`);
  }
  if (t.agentId) out.push(agentBlock(t, group, ctx.agents[t.agentId], ctx.o));
  if (group === "blocked") out.push(`<div class="bo"><b>Blocked on:</b> ${esc(t.blocked_on || "an outside dependency")}</div>`);
  const body = t.card.trim() ? cardHtml(t) : esc(t.notes);
  if (body) out.push(`<div class="nt">${body}</div>`);
  // a done card with a card.md keeps its notes in the same place; a report on disk is pointed at, not inlined
  if (group === "done" && t.card.trim() && t.notes.trim() && !t.card.includes(t.notes.trim())) {
    out.push(`<details class="cnotes" id="fn-${esc(t.id)}"><summary>Notes</summary>${markdown(t.notes)}</details>`);
  }
  if (group === "done" && t.hasReport) out.push(`<div class="dp">Report: <code>state/tasks/${esc(t.id)}/report.md</code></div>`);
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

/**
 * The task navigator's data: every non-empty stage in GROUPS order, each with its titles linking to the cards. It rides
 * in the live block as a hidden template; the page script (nav-script.ts) builds the rail, the spine, the flyouts and the
 * phone bar from it, so the navigator updates with the cards and a new stage in GROUPS needs no client change.
 */
export function navHtml(buckets: Record<GroupKey, { t: Task }[]>): string {
  return GROUPS.filter(([k]) => buckets[k].length).map(([k, label]) => {
    const items = buckets[k];
    const cap = items.length > NAV_CAP;
    const lis = items.map(({ t }) => {
      const name = esc(t.title || t.intent || t.id);
      const fail = t.status === "failed" ? ` class="fail"` : "";
      return `<li${fail}><a class="tn-a" href="#t-${esc(t.id)}" data-t="t-${esc(t.id)}" title="${name}">${name}</a></li>`;
    }).join("");
    const more = cap ? `<button class="tn-more" type="button" aria-expanded="false" data-more="${items.length - NAV_SHOW} more">${svg(ICON.more)}<span>${items.length - NAV_SHOW} more</span></button>` : "";
    return `<div class="tn-st t-${k}" data-k="${k}" data-n="${items.length}" data-label="${esc(label)}"${cap ? " data-cap" : ""}>` +
      `<button class="tn-h" type="button" aria-expanded="true">${svg(STAGE_ICON[k])}<span class="tn-l">${esc(label)}</span><span class="tn-c">${items.length}</span>${svg(ICON.down)}</button><ul>${lis}</ul>${more}</div>`;
  }).join("");
}

/** Tasks with an `order` come first, lowest first; the rest keep their incoming order (a stable sort). */
export function byOrder<T extends { order?: number }>(items: T[]): T[] {
  return items
    .map((x, i) => [x, i] as const)
    .sort(([a, i], [b, j]) => (a.order === undefined ? 1 : 0) - (b.order === undefined ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0) || i - j)
    .map(([x]) => x);
}

function renderLive(model: ProjectModel, agents: Record<string, AgentView>, o: RenderOpts): string {
  const liveIds = new Set(model.tasks.map((t) => t.id));
  const archive = model.archive.filter((t) => !liveIds.has(t.id)).reverse(); // newest first
  const all = [...model.tasks, ...archive];
  const byId = new Map(all.map((t) => [t.id, t]));
  const unblocks = new Map<string, string[]>();
  for (const t of all) for (const d of t.depends_on) unblocks.set(d, [...(unblocks.get(d) ?? []), t.id]);
  const ctx: Ctx = { byId, unblocks, agents, o, comments: model.comments };

  const buckets: Record<GroupKey, { t: Task; g: GroupKey }[]> = { you: [], fm: [], running: [], blocked: [], next: [], parked: [], done: [] };
  for (const t of model.tasks) buckets[groupOf(t, true)].push({ t, g: groupOf(t, true) });
  for (const t of archive) buckets.done.push({ t, g: "done" });
  // Done: most recently updated (lastEvent) first, live and archived together. An explicit `order` still pins a task ahead of the rest in any group.
  buckets.done.sort((a, b) => b.t.updatedMs - a.t.updatedMs);
  for (const k of Object.keys(buckets) as GroupKey[]) buckets[k] = byOrder(buckets[k].map((x) => ({ ...x, order: x.t.order }))).map(({ t, g }) => ({ t, g }));

  const busy = GROUPS.filter(([k]) => k !== "done").flatMap(([k]) => buckets[k])
    .filter(({ t }) => t.agentId && ACTIVE.has(agents[t.agentId]?.status ?? "")).length;
  const failedN = buckets.done.filter(({ t }) => t.status === "failed").length;
  const countOf = (k: GroupKey) => (k === "done" ? buckets.done.length - failedN : buckets[k].length); // a failed task is not "done"
  // Done cards with a card.md start "unread" (the page moves the ones the captain has marked read into the Done group)
  // The captain's marks (state/projects/<p>/ui-state.json) are applied here too, so the first paint already has the right split.
  const cands = buckets.done.filter(({ t }) => markable(t) && t.status !== "failed");
  const isRead = (t: Task) => model.marks?.[`t-${t.id}`] === cardHash(t.card);
  const unread = cands.filter(({ t }) => !isRead(t));
  const unreadIds = new Set(unread.map(({ t }) => t.id));
  const readN = buckets.done.length - failedN - unread.length;
  let summary = GROUPS.filter(([k]) => countOf(k))
    .map(([k, n]) => {
      if (k === "done" && cands.length) {
        return `<a href="#g-doneu" class="sum c-done" data-k="u"${unread.length ? "" : " hidden"}>${unread.length} done, unread</a><a href="#g-done" class="sum c-done" data-k="d"${readN ? "" : " hidden"}>${readN} done</a>`;
      }
      return `<a href="#g-${k}" class="sum c-${k}">${countOf(k)} ${k === "you" ? "needs you" : n.toLowerCase()}</a>`;
    })
    .join("");
  if (failedN) summary += `<a href="#g-done" class="sum c-fail">${failedN} failed</a>`;
  if (busy) summary += `<span class="sum c-running">${busy} agent${busy > 1 ? "s" : ""} working</span>`;
  const parts = [`<div class="summary">${summary}<span class="m">live: the page checks ${o.tickSeconds === 1 ? "every second" : `every ${o.tickSeconds} s`}; the plugin refreshes it on every change and at least every ${o.refreshSeconds ?? 20} s (last refresh {TS})</span></div>`];
  for (const [k, n] of GROUPS) {
    const items = buckets[k];
    if (!items.length) continue;
    if (k === "done" && cands.length) {
      const rowsOf = (list: typeof items) => list.map((x) => row(x.t, x.g, ctx, items.indexOf(x))).join("\n");
      const rest = items.filter((x) => !unreadIds.has(x.t.id));
      parts.push(
        `<section class="grp" id="g-doneu"${unread.length ? "" : " hidden"}><h3>Done, unread <span class="n">(<span class="cn">${unread.length}</span>)</span> <button class="mra" type="button">Mark all read</button></h3>\n<div class="rows">${rowsOf(unread)}</div></section>`,
        `<details class="grp" id="g-done"${rest.length ? "" : " hidden"}><summary><h3>Done <span class="n">(<span class="cn">${rest.length}</span>)</span></h3></summary>\n<div class="rows">${rowsOf(rest)}</div></details>`,
      );
      continue;
    }
    const rows = items.map(({ t, g }) => row(t, g, ctx, items.findIndex((x) => x.t === t))).join("\n");
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
  parts.push(`<div hidden data-tn>${navHtml(buckets)}</div>`);
  return parts.join("\n");
}

function renderSection(model: ProjectModel, name: string): string {
  const s = model.sections.find((x) => x.name === name)!;
  const title = model.sectionTitles[name] ?? DEFAULT_TITLES[name] ?? titleCase(name);
  const body = s.kind === "html" ? s.content : markdown(s.content);
  const slot = `<div class="trail-slot" data-trail-slot="${esc(name)}"></div>`;
  if (model.collapsedSections.includes(name)) {
    // the subtitle is trusted HTML written by the first mate (project.json sectionSubtitles), e.g. "· 19 commits, local only"
    const sub = model.sectionSubtitles[name];
    return `<details class="sec" id="${esc(name)}" data-section="${esc(name)}"><summary><h2>${esc(title)}</h2>${sub ? ` <span class="m">${sub}</span>` : ""}</summary>\n${slot}\n${body}\n</details>`;
  }
  return `<section id="${esc(name)}" data-section="${esc(name)}"><h2>${esc(title)}</h2>\n${slot}\n${body}\n</section>`;
}

/**
 * `iso` is when the plugin produced this payload and `seq` a counter that grows with every payload. The page script
 * never compares `iso` with the browser clock (they can disagree by minutes); it only notices that the payload keeps
 * changing, on its own clock.
 */
export function liveJs(liveHtml: string, iso?: string, seq?: number): string {
  const extra = iso || seq !== undefined ? `,${JSON.stringify(iso ?? "")}${seq !== undefined ? `,${seq}` : ""}` : "";
  return `window.__fdLive&&window.__fdLive(${JSON.stringify(liveHtml)}${extra});\n`;
}

export const STALE_TEXT = "This page stopped updating. Your comments may not reach the first mate until it's fixed (the first mate can run bin/page heal).";

export function renderProject(model: ProjectModel, agents: Record<string, AgentView>, opts: RenderOpts): Rendered {
  const live = renderLive(model, agents, opts);
  const pageFile = opts.pageFile ?? (model.page ? model.page.slice(model.page.lastIndexOf("/") + 1) : "page.html");
  const liveFile = pageFile.replace(/\.[^./]*$/, "") + ".live.js";

  const sig = createHash("sha1")
    .update(JSON.stringify([
      { ...model, comments: undefined },
      opts.banner ?? null,
      opts.marksUrl ?? null,
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
</head><body>
<!-- the task navigator: data-lavish-action keeps its clicks working in Lavish's annotate mode -->
<aside class="tn" id="tn" aria-label="Tasks by stage" data-lavish-action hidden><div class="tn-spine"><button class="tn-tg" id="tn-open" type="button" aria-expanded="false" aria-controls="tn-full" aria-label="Show task titles" title="Show task titles">${svg(ICON.panelOpen)}</button><button class="tn-tg tn-fx" type="button" aria-pressed="false" aria-label="Focus view: show only the selected task" title="Focus view: show only the selected task">${svg(ICON.focus)}</button><div class="tn-bds" id="tn-bds"></div></div><div class="tn-full" id="tn-full"><div class="tn-top"><button class="tn-tg" id="tn-close" type="button" aria-expanded="true" aria-controls="tn-full" aria-label="Fold the task list" title="Fold the task list">${svg(ICON.panelClose)}</button><b>Tasks</b><button class="tn-tg tn-fx" type="button" aria-pressed="false" aria-label="Focus view: show only the selected task" title="Focus view: show only the selected task">${svg(ICON.focus)}</button></div><div class="tn-fl" id="tn-fl"></div></div></aside>
<div class="tn-fly" id="tn-fly" role="region" aria-label="Stage titles" data-lavish-action hidden></div>
<div class="tn-back" id="tn-back" data-lavish-action hidden></div>
<div class="tn-sheet" id="tn-sheet" role="dialog" aria-modal="true" aria-label="Tasks by stage" data-lavish-action hidden><div class="tn-sb" id="tn-sl"></div><div class="tn-sf"><button class="tn-fx tn-fxl" type="button" aria-pressed="false">${svg(ICON.focus)}<span>Focus view</span></button><button class="tn-sx" id="tn-sx" type="button">Close</button></div></div>
<main>
<h1>${esc(model.title)}</h1>
<div class="sub">Kept current by the firstmate-deck plugin · last update <b>${esc(stampLong(opts.now))}</b></div>
<p class="chan"><b>This page is our channel.</b> Comment on any card or block, then Send; the first mate answers here.</p>
<div class="trail-slot" data-trail-slot="page"></div>
<div class="banner b-bad" id="fd-stale" role="status" hidden>${esc(STALE_TEXT)}</div>
${banner}
<nav>${nav}</nav>
<button class="tn-bar" id="tn-bar" type="button" data-lavish-action aria-haspopup="dialog" aria-expanded="false" aria-controls="tn-sheet" hidden></button>

<h2 id="tasks">Tasks</h2>
<div class="m">Each task once: its state, its crew agent live, and what it depends on. Titles and “Open in Paseo” go to the agent in the Paseo web UI.</div>
<div class="tn-fbar" id="tn-fbar" role="status" data-lavish-action hidden></div>
<div id="live"><!--LIVE-START-->${stamped}<!--LIVE-END--></div>
${names.map((n) => renderSection(model, n)).join("\n")}
<script>
${navScript()}
${pageScript(model.project, liveFile, opts.tickSeconds, opts.marksUrl)}
</script>
</main></body></html>
`;
  return { page, live, signature: sig };
}
