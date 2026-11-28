// renderProject: ProjectModel + live agent views -> { page, live, signature }. Pure, no I/O.
import { createHash } from "node:crypto";
import { cut } from "./humanize.ts";
import type { Recap } from "./recap.ts";
import { cardHash } from "./marks.ts";
import { inline, markdown } from "./markdown.ts";
import { ICON, svg } from "./icons.ts";
import { navScript } from "./nav-script.ts";
import { pageScript } from "./page-script.ts";
import { IDIOMORPH_SOURCE } from "./morph-source.ts";
import { CSS, scaleText } from "./style.ts";
import type { ProjectModel, Task, TrailComment } from "./state.ts";
import { activeSinceOf, applyStalled, computeStage, currentAgent, stageAgentsFor, type GroupKey, type LabeledAgent, type Stage, type StageFlag } from "./stage.ts";
import { attentionOf, type Attention } from "./attention.ts";
import { canvasInput, clickedPick, SAFE_ASK } from "./canvas-view.ts";
import type { CanvasData, FmSummary } from "./canvas-port.ts";

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
  /** Paseo agents found by their `fm.task` label, per task id (runtime.ts). Without them a v1 task's `agentId` stands in. */
  labeled?: Record<string, LabeledAgent[]>;
  /** What agent-canvas says about those agents (canvas-port.ts). Absent = no canvas: cards and stages are the registry's and Paseo's alone. */
  canvas?: CanvasData;
  /** Tasks the enforcer gave up on: the first mate ignored them (enforcer.ts). Applied only while the task is still in the situation (`fp`) it was judged in. */
  stalled?: Record<string, { fp: string; why: string }>;
};

/** The body of a card the page shows as one line until it is opened: its html, the scoped stylesheet its canvas needs, and the content hash that names its file. */
export type Body = { hash: string; html: string; css: string };

export type Rendered = { page: string; live: string; signature: string; attention: Attention; bodies: Record<string, Body> };

const GROUPS = [
  ["you", "Needs you"],
  ["fm", "With the first mate"],
  ["running", "Running"],
  ["blocked", "Blocked"],
  ["next", "Next up"],
  ["parked", "Parked"],
  ["done", "Done"],
] as const;

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




const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A fixed past moment as the page writes it: the time, with the date when it was not today. */
function sinceLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}

/** "mac offline since 14:03": why a crew on that host is unknown. */
export const offlineText = (o: { label: string; since: string }, now: Date): string => `${o.label} offline since ${sinceLabel(o.since, now)}`;

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The task's computed stage (stage.ts): from the registry's intent, its asks, and the Paseo agents carrying its label. */
export function stageOf(t: Task, live: boolean, o: { now: Date; labeled?: RenderOpts["labeled"]; canvas?: CanvasData; comments?: TrailComment[]; stalled?: RenderOpts["stalled"] }, view: (id: string) => AgentView | undefined = () => undefined): Stage {
  if (!live) return computeStage(t, t.agents?.length ? [{ id: t.agents[t.agents.length - 1], status: "idle", archived: false, pendingPermissions: 0 }] : [], o.now, { archived: true });
  const agents = stageAgentsFor(o.labeled?.[t.id], view);
  const cur = currentAgent(agents);
  const canvas = cur && o.canvas?.status === "ok" ? canvasInput(o.canvas.summaries[cur.id], t.id, o.comments ?? [], activeSinceOf(cur)) : undefined;
  const st = computeStage(t, agents, o.now, { canvas });
  const sl = o.stalled?.[t.id];
  return sl && sl.fp === st.fp ? applyStalled(st, sl.why) : st;
}

export function groupOf(t: Task, live: boolean, now = new Date(), labeled?: RenderOpts["labeled"], view?: (id: string) => AgentView | undefined): GroupKey {
  return stageOf(t, live, { now, labeled }, view).group;
}

function pill(group: GroupKey, ast: string): [string, string] {
  if (ACTIVE.has(ast)) return ["running", "running"];
  if (ast === "error") return ["error", "error"];
  if (group === "you") return ["you", "waiting on you"];
  if (group === "done") return ["done", "done"];
  return ["idle", ast || "idle"];
}

// a flag that counts time ("silent 41 min") carries when it began and the browser writes the count (page-script.ts clocks)
const flagBadges = (flags: StageFlag[]) => flags.map((f) => `<span class="fl${f.drift ? " fl-d" : ""}" title="${esc(f.key)}">${f.since ? `${esc(f.text.replace(/\s*\d+ min$/, ""))} <span class="ck" data-ago="${f.since}"></span>` : esc(f.text)}</span>`).join("");

function agentBlock(t: Task, group: GroupKey, view: AgentView | undefined, o: RenderOpts, st: Stage, withCanvas = false): string {
  const aid = st.agentId;
  if (!aid) { // no agent to show: Dispatching and Lost still say where the task stands, and so does any drift flag
    if (!st.flags.length && group !== "running" && group !== "fm") return "";
    return `<div class="ag"><span class="pill p-idle"><span class="dot"></span>${esc(st.stage)}</span>${flagBadges(st.flags)}</div>`;
  }
  const url = esc(o.paseoAgentUrl(aid));
  const crew = o.labeled?.[t.id]?.find((x) => x.id === aid);
  if (group === "done") { // frozen: the agent id may be reused later, so show none of its live state
    const [cls, label] = st.failed ? ["error", "failed"] : ["done", "done"];
    const who = t.provider ? `<span class="facts">${esc(t.provider)}</span>` : "";
    return `<div class="ag"><span class="pill p-${cls}"><span class="dot"></span>${label}</span>${who}${flagBadges(st.flags)}<a class="open" href="${url}">Open in Paseo</a></div>`;
  }
  const a: AgentView = view ?? { status: "unknown", stepCount: 0, recent: [] };
  const away = crew?.hostOffline; // its host is offline: what the view says is only what was last seen
  const ast = away || a.stale ? "unknown" : a.status;
  const [cls, label] = away ? ["idle", `unknown · ${offlineText(away, o.now)}`] : a.stale ? ["idle", STALE_PILL] : pill(group, ast);
  const c = a.createdAt ? new Date(a.createdAt) : null;
  const u = a.updatedAt ? new Date(a.updatedAt) : null;
  const ok = (d: Date | null): d is Date => !!d && !isNaN(d.getTime());
  // a running agent's elapsed time moves with the clock, so the payload carries only when it started (data-so) and the browser
  // writes "N min so far" (page-script.ts clocks); a finished one's duration is fixed text
  const el = !away && !a.stale && ok(c) && ok(u)
    ? ACTIVE.has(ast) ? `<span class="ck" data-so="${c.getTime()}"></span>` : esc(`took ${dur((u.getTime() - c.getTime()) / 1000)}`)
    : "";
  // Paseo has no record of the agent (or none yet): fall back to the provider/model the task itself names
  const model = [a.model || t.provider, a.thinking].filter(Boolean).join(" ");
  const facts = [a.stepCount ? esc(`${a.stepCount}${a.stepsAtLeast ? "+" : ""} steps`) : "", el, esc(model), ast === "archived" ? "archived" : ""].filter(Boolean).join(" · ");
  // the pill already says which host is away and since when
  const stage = away && st.stage.startsWith("Unknown") ? "" : `<span class="stg">${esc(st.stage)}</span>`;
  const flags = flagBadges(away ? st.flags.filter((f) => f.key !== "host-offline") : st.flags);
  const cur = ACTIVE.has(ast) && a.recent.length ? a.recent[a.recent.length - 1] : a.final || a.recent[a.recent.length - 1] || "";
  // with a canvas fragment the links move below it (cvLinks) and the canvas's BLUF/steps/Now replace the recent-steps block
  const head =
    `<div class="ag"><span class="pill p-${cls}"><span class="dot"></span>${esc(label)}</span>` +
    `${stage}${flags}<span class="facts">${facts}</span>${withCanvas ? "" : `<a class="open" href="${url}">Open in Paseo</a>`}</div>`;
  if (withCanvas || !cur) return head;
  if (!a.recent.length) return head + `<div class="cur">${esc(cut(cur, 160))}</div>`;
  const lis = a.recent.map((s) => `<li>${esc(s)}</li>`).join("");
  return (
    head +
    `<details class="stp" id="s-${esc(t.id)}"><summary class="cur">${esc(cut(cur, 160))}</summary>` +
    `<ol start="${Math.max(1, a.stepCount - a.recent.length + 1)}">${lis}</ol></details>`
  );
}


const verdictTone = (label: string) => (label === "Error" ? "bad" : label === "Needs you" || label === "Disputed" || label === "Stale" ? "warn" : label === "Done" ? "ok" : "mut");

/**
 * The agent's canvas inside its card: verdict, BLUF, steps strip with the Now row. `compact` is what a grouped list shows;
 * the full embed card (agent-canvas `/api/fm/card`) sits in a collapsed "Full canvas" fold, open and replacing it in the focus view (style.ts, nav-script.ts).
 * `full` (a Needs-you card) shows the whole canvas open, BLUF uncut, in place of the compact strip: the crew's canvas is structured and short by then.
 * `away` (the crew's host is offline): the verdict is dated, as it is only what was last seen.
 */
export function canvasFragment(s: FmSummary, card?: string, full = false, away = false): string {
  const flags = s.verdict.flags.map((f) => `<span class="fl" title="${esc(f.signal)}">${esc(f.text)}</span>`).join("");
  const total = Math.min(s.steps.total, 24);
  const done = s.steps.total > 24 ? Math.round((s.steps.done / s.steps.total) * 24) : s.steps.done;
  const segs = Array.from({ length: total }, (_, i) => `<i class="${i < done ? "on" : i === done && s.steps.current ? "now" : ""}"></i>`).join("");
  const steps = s.steps.total
    ? `<div class="cv-steps"><span class="cv-bar" aria-hidden="true">${segs}</span><span class="cv-n">${s.steps.done}/${s.steps.total} steps</span>${s.steps.current ? `<span class="cv-now"><b>Now</b> ${esc(cut(s.steps.current, 100))}</span>` : ""}</div>`
    : "";
  const whole = full && !!card;
  const compact =
    `<div class="cv-c"><div class="cv-top"><span class="cv-v cv-${away ? "mut" : verdictTone(s.verdict.label)}">${away ? "last seen: " : ""}${esc(s.verdict.label)}</span>${flags}${s.auto ? `<span class="fl" title="no canvas was written: this is the one agent-canvas drew from the agent's timeline">auto canvas</span>` : ""}</div>` +
    // a whole canvas carries its own BLUF and steps: the strip keeps only the verdict
    `${whole ? "" : s.bluf ? `<div class="cv-bluf">${esc(full ? s.bluf : cut(s.bluf, 280))}</div>` : ""}${whole ? "" : steps}</div>`;
  return `<div class="cv${card ? " has-full" : ""}${whole ? " cv-whole" : ""}" data-rev="${s.rev}">${compact}${card ? `<details class="cnotes cv-d" id="cvd-${esc(s.agentId)}"${whole ? " open" : ""}><summary>Full canvas</summary><div class="cv-f acv">${card}</div></details>` : ""}</div>`;
}

/**
 * The crew's own canvas questions that no curated ask mirrors yet: raw, clickable at once, and still delivered through the
 * first mate (their buttons use the option-click path, target `t-<task>#c-<id>`). A pick waits as "sent to the first mate".
 */
function rawAsks(t: Task, s: FmSummary, comments: TrailComment[], now: Date, activeSince?: string | null, away = ""): string[] {
  const out: string[] = [];
  for (const a of s.openAsks) {
    if (t.asks.some((x) => x.ref?.block === a.id)) continue; // curated: the registry ask above is the one to answer
    const key = `ask-${t.id}-c-${a.id}`;
    const clicked = clickedPick(t.id, a.id, comments, activeSince);
    const picked = a.pending ?? clicked;
    const name = esc(t.title || t.intent || t.id);
    const tag = picked !== undefined ? "Sent to the first mate" : "Uncurated · from the crew";
    const q = `<div class="ask"><b>Your call:</b> ${inline(a.question)}${a.blocking ? ` <span class="fl">blocking</span>` : ""}</div>`;
    let body: string;
    if (!SAFE_ASK.test(a.id) || a.options.length < 2) {
      // say why there are no buttons, and link the canvas itself (the card's "Open canvas" link may sit far below)
      const why = a.options.length < 2 ? `this question has ${a.options.length === 1 ? "only one option" : "no options"}` : `its id “${cut(a.id, 40)}” is not one the page can carry in a button`;
      body = `${q}<div class="m">No buttons here: ${why}. <a href="${esc(s.url)}">Answer it on the canvas ↗</a>, or comment on this card.</div>`;
    } else {
      const btns = a.options.map((o, k) => {
        const on = picked !== undefined && o.value === picked;
        return `<button type="button" class="opt${on ? " on" : ""}" id="o-${esc(t.id)}-c-${esc(a.id)}-${k + 1}" data-task="${esc(t.id)}" data-ask="c-${esc(a.id)}" data-opt="${esc(o.value)}" data-title="${name}" aria-pressed="${on}"${picked !== undefined && !on ? " disabled" : ""}>${esc(o.label)}</button>`;
      }).join("");
      const line = picked !== undefined
        ? `<div class="pickline" role="status">You picked <b>${esc(cut(picked, 100))}</b> · the first mate is delivering it</div>`
        : `<div class="pickline" role="status" hidden></div>`;
      const hint = picked === undefined ? `<span class="hint">or comment on the card</span>` : "";
      body = `${q}<div class="opts" data-key="${esc(key)}"><div class="opt-row">${btns}${hint}</div>${line}</div>`;
    }
    const trail = picked === undefined ? trailHtml(comments, `t-${t.id}#c-${a.id}`, now) : "";
    out.push(`<div class="askbox raw" id="a-${esc(t.id)}-c-${esc(a.id)}"><div class="ask-tag">${tag}</div>${body}${away}${trail}</div>`);
  }
  return out;
}

/** Under an open question of a crew whose host is offline: the answer is taken here, but cannot reach the crew yet. */
const awayNote = (label: string) => `<div class="m away">${esc(label)} is offline: your answer is saved here. The crew can only get it once ${esc(label)} is back.</div>`;

const DAY_MS = 24 * 3600 * 1000;
const LATE_MS = 10_000;

/** Where a comment stands: sending… / first mate has it / answered (from the inbox flags). */
export function chipHtml(c: { at: string; delivered: boolean; answered: boolean }, now: Date): string {
  if (c.answered) return `<span class="st st-answered">answered</span>`;
  if (c.delivered) return `<span class="st st-has">first mate has it</span>`;
  // "late" is the browser's call (page-script.ts clocks, after LATE_MS on screen): the payload must not change as time passes
  return `<span class="st st-send" data-late="${LATE_MS}">sending…</span>`;
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

/**
 * The recap strip at the top of a card the captain is coming back to (Needs you, With the first mate, Done): what they asked and
 * what the crew did, as the crew wrote it in the canvas's recap block (the embedded canvas leaves that block out). When the
 * captain commented after the crew last wrote, the strip shows that comment and says it is not acted on yet instead of pairing
 * an old answer with a new request. Empty when the crew wrote no recap.
 */
export function recapStrip(t: Task, group: GroupKey, recap: Recap | null | undefined, crewAt: number | null | undefined, comments: TrailComment[], now: Date): { html: string; consumes?: string } {
  if (!recap || (group !== "you" && group !== "fm" && group !== "done")) return { html: "" };
  const mine = comments.filter((c) => (c.target === `t-${t.id}` || c.target.startsWith(`t-${t.id}#`)) && !c.stale && !(c.choice && !c.choice.option));
  const last = mine.reduce<TrailComment | undefined>((a, b) => (!a || Date.parse(b.at) >= Date.parse(a.at) ? b : a), undefined);
  const newer = !!last && !!crewAt && Date.parse(last.at) > crewAt;
  const hm = (ms: number) => { const d = new Date(ms); return isNaN(d.getTime()) ? "" : ` · ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const row = (k: string, v: string, full: string, extra = "") => `<div class="rc-row"><span class="rc-k">${k}</span><span class="rc-v" title="${esc(full)}">${v}${extra}</span></div>`;
  if (newer && last) {
    const said = last.choice ? `picked ${last.choice.option}` : last.text.replace(/\s+/g, " ").trim();
    return {
      html: `<div class="recap rc-new">${row(`You asked${hm(Date.parse(last.at))}`, esc(cut(said, 200)), said, chipHtml(last, now))}${row("Crew did", `<i>Not acted on yet</i> · ${group === "done" ? "the crew had finished" : group === "fm" ? "with the first mate" : "waiting on the first mate"}`, "")}</div>`,
      consumes: last.target === `t-${t.id}` ? last.id : undefined,
    };
  }
  return { html: `<div class="recap">${row("You asked", esc(cut(recap.asked, 200)), recap.asked)}${row(`Crew did${crewAt ? hm(crewAt) : ""}`, esc(cut(recap.did, 200)), recap.did)}</div>` };
}

type Ctx = { bodies: Map<string, Body>; snapCss: Set<string>; byId: Map<string, Task>; unblocks: Map<string, string[]>; agents: Record<string, AgentView>; o: RenderOpts; comments: TrailComment[]; stages: Map<string, Stage>; canvas?: CanvasData };

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

/** Removes the `<div class="${cls}"…>` element (balanced, nested divs counted) from `html`; the rest is returned untouched. */
function dropDiv(html: string, cls: string): string {
  const at = html.indexOf(`<div class="${cls}`);
  if (at < 0) return html;
  const tag = /<(\/?)div\b/g;
  tag.lastIndex = at;
  for (let depth = 0, m: RegExpExecArray | null; (m = tag.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(0, at) + html.slice(html.indexOf(">", m.index) + 1);
  }
  return html;
}

/**
 * Splits a `canvas.final.html` snapshot (canvas-cmd.ts) into the stylesheet and the canvas body, without the run chrome the
 * snapshot froze in (the status line and the title row repeat the card's own header). Undefined when it is not that shape.
 */
export function snapshotParts(doc: string): { css: string; body: string } | undefined {
  const css = /<style>([\s\S]*?)<\/style>/.exec(doc)?.[1];
  const at = doc.indexOf('<div class="cv-snap acv">');
  const end = doc.lastIndexOf("</div>\n</body>");
  if (css === undefined || at < 0 || end < at) return undefined;
  const body = dropDiv(dropDiv(doc.slice(at + '<div class="cv-snap acv">'.length, end), "statusline"), "trow")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  // the page and wrapper rules (body, .cv-snap) belong to the standalone document, not to the card
  const scoped = css.replace(/(?<=^|\})\s*(?:body|\.cv-snap)\s*\{[^}]*\}/g, "").replace(/@import[^;]*;/gi, "").trim();
  return { css: scoped, body };
}

/**
 * The final canvas snapshot of a done task, expanded in the card and set inline like a running canvas: natural height, the
 * deck's tokens (`.cv-f`), no frame. Its stylesheet is scoped under `.acv` and hoisted once per page through `css`.
 * A snapshot that is not the expected shape falls back to a sandboxed frame.
 */
const finalCanvas = (t: Task, css: Set<string>, label = "Final canvas"): string => {
  const parts = snapshotParts(t.canvasFinal);
  if (!parts) return `<details class="cnotes cv-d" id="cvf-${esc(t.id)}" open><summary>${label}</summary><iframe class="cv-final" title="${label}" sandbox srcdoc="${esc(t.canvasFinal)}"></iframe></details>`;
  if (parts.css) css.add(parts.css);
  return `<details class="cnotes cv-d" id="cvf-${esc(t.id)}" open><summary>${label}</summary><div class="cv-f cv-fin acv">${parts.body}</div></details>`;
};

/** A done task whose card the captain can mark read: it has a non-empty card.md. */
export const markable = (t: Task): boolean => t.card.trim() !== "";

function row(t: Task, group: GroupKey, ctx: Ctx, idx = 0): string {
  const name = esc(t.title || t.intent || t.id);
  const st = ctx.stages.get(t.id)!;
  const aid = st.agentId;
  const title = aid ? `<a href="${esc(ctx.o.paseoAgentUrl(aid))}">${name}</a>` : name;
  const failed = st.failed;
  const chip = failed ? `<span class="chip c-fail">failed</span>` : "";
  // Done cards carry their position (data-i) so the page can put a card back in order when it moves it between the
  // unread and read groups, and (when they have a card) the hash the read mark is keyed by (data-h) and a button.
  const done = group === "done";
  const mark = done && markable(t);
  const data = done ? ` data-i="${idx}"${mark ? ` data-h="${cardHash(t.card)}"` : ""}` : "";
  const btn = mark ? `<button class="mr" type="button">Mark read</button>` : "";
  // the agent's canvas, when agent-canvas has one for it: the card shows it under the stage line and answers its raw asks
  // an auto canvas (drawn from the timeline, nothing written) never outranks the crew's saved snapshot
  const live = group === "done" || !aid ? undefined : ctx.canvas?.summaries[aid];
  const sum = live?.auto && t.canvasFinal ? undefined : live;
  const curAgent = currentAgent(ctx.o.labeled?.[t.id] ?? []);
  const crew = ctx.o.labeled?.[t.id]?.find((x) => x.id === aid);
  // a finished task keeps its host name, but nothing on it waits for that host
  const away = group === "done" ? undefined : crew?.hostOffline;
  const note = away ? awayNote(away.label) : "";
  const host = crew?.host ? `<span class="chip c-host">on ${esc(crew.host)}</span>` : "";
  const raw = sum ? rawAsks(t, sum, ctx.comments, ctx.o.now, activeSinceOf(curAgent), note) : [];
  const rawTargets = new Set((sum?.openAsks ?? []).filter((a) => !t.asks.some((x) => x.ref?.block === a.id)).map((a) => `t-${t.id}#c-${a.id}`));
  const recapSum = group === "done" ? undefined : sum;
  // an open card whose crew is gone (archived, no live canvas) shows the snapshot taken when the ask was made, like a done card does
  const snapOnly = group !== "done" && !sum && !!t.canvasFinal;
  const strip = group === "done" || snapOnly ? recapStrip(t, group, t.canvasRecap, t.canvasFinalAt, ctx.comments, ctx.o.now) : recapStrip(t, group, recapSum?.recap, recapSum?.updatedAt, ctx.comments, ctx.o.now);
  // one long explanation per card: when a crew canvas is on it, the first mate's context folds (a short note stays open)
  const hasCanvas = !!sum || !!t.canvasFinal;
  // Done and parked cards are one line until opened (the page loads their body by `data-bh`): LH has hundreds of them and they
  // were 88% of the page. A card the captain commented on, or that still asks something, stays whole.
  const lite = (group === "done" || group === "parked") && !t.asks.length && !ctx.comments.some((c) => c.target === `t-${t.id}` || c.target.startsWith(`t-${t.id}#`));
  const css = lite ? new Set<string>() : ctx.snapCss;
  const out = [
    `<article class="task s-${group}${failed ? " s-failed" : ""}" id="t-${esc(t.id)}"${data}>`,
    `<div class="tt"><span class="ttl">${title}</span>${host}${chip}${btn}</div>`,
    strip.html,
    // card-level comments, plus comments on asks that are gone (an answered ask takes its own trail with it); the strip already shows a newer one
    trailHtml(ctx.comments.filter((c) => c.id !== strip.consumes), `t-${t.id}`, ctx.o.now, (c) => c.target.startsWith(`t-${t.id}#`) && !t.asks.some((a) => c.target === `t-${t.id}#${a.id}`) && !rawTargets.has(c.target)),
  ];
  if (sum) out.push(agentBlock(t, group, aid ? ctx.agents[aid] : undefined, ctx.o, st, true), canvasFragment(sum, ctx.canvas?.cards[sum.agentId], group === "you", !!away));
  else if (snapOnly) out.push(finalCanvas(t, css, "Crew canvas"));
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
    } else if (a.ref && sum && !sum.openAsks.some((x) => x.id === a.ref!.block)) {
      // the crew's canvas question this ask mirrors was answered or removed: nothing left to click, the first mate closes it
      box.push(asked, `<div class="ask replied">Resolved on canvas · the first mate will close this</div>`);
    } else {
      // a "BLUF: ..." text is its own label: no "Your call:" in front of it (no doubled colon), and it is the bold one-liner
      box.push(/^BLUF:/i.test(a.text) ? `<div class="ask"><b>${inline(a.text)}</b></div>` : `<div class="ask"><b>Your call:</b> ${inline(a.text)}</div>`);
      if (a.options?.length) {
        box.push(`<div class="opts" data-key="${esc(key)}"><div class="opt-row">${buttons()}<span class="hint">or comment on the card</span></div><div class="pickline" role="status" hidden></div></div>`);
      }
      trail = trailHtml(ctx.comments, `t-${t.id}#${a.id}`, ctx.o.now); // this ask's own comments, right under it
    }
    if (note && !(a.ref && sum && !sum.openAsks.some((x) => x.id === a.ref!.block))) box.push(note);
    if (trail) box.push(trail);
    const ctxMd = contextBody(a.text, a.contextMd);
    if (ctxMd.trim()) {
      // a note is short and open while the ask needs the captain; a full context is open only when there is no canvas to read instead
      // (the page remembers a collapse per browser)
      const waiting = group === "you" && !a.repliedAt;
      const open = waiting && (a.note || !hasCanvas) ? " open" : "";
      box.push(`<details class="actx${a.note ? " note" : ""}" id="x-${esc(t.id)}-${esc(a.id)}"${open}><summary>${a.note ? "First mate adds" : "Context"}</summary><div>${markdown(ctxMd)}</div></details>`);
    }
    // One block per ask: a comment anywhere inside it (text, option buttons, context) targets this ask.
    out.push(`<div class="askbox" id="a-${esc(t.id)}-${esc(a.id)}">${box.join("")}</div>`);
  });
  // asks the first mate already answered stay readable on the finished card
  if (group === "done") for (const a of t.answered ?? []) {
    const ctxMd = contextBody(a.text, a.contextMd);
    const ans = a.text ? `<div class="ask asked">${inline(a.text)}</div>` : "";
    const detail = ctxMd.trim() ? `<details class="actx${a.note ? " note" : ""}" id="x-${esc(t.id)}-${esc(a.id)}"><summary>${a.note ? "First mate adds" : "Context"}</summary><div>${markdown(ctxMd)}</div></details>` : "";
    if (ans || detail) out.push(`<div class="askbox answered" id="a-${esc(t.id)}-${esc(a.id)}"><div class="ask-tag">Answered</div>${ans}${detail}</div>`);
  }
  if (sum) {
    out.push(...raw, `<div class="cv-links"><a class="cv-open" href="${esc(sum.url)}">Open canvas ↗</a><a class="open" href="${esc(ctx.o.paseoAgentUrl(sum.agentId))}">Open in Paseo</a></div>`);
  } else out.push(agentBlock(t, group, aid ? ctx.agents[aid] : undefined, ctx.o, st));
  if (group === "blocked") out.push(`<div class="bo"><b>Blocked on:</b> ${esc(t.blocked_on || "an outside dependency")}</div>`);
  const body = t.card.trim() ? cardHtml(t) : esc(t.notes);
  // a done task with a final canvas shows it expanded; the short card is the fallback when there is none, else it folds away
  if (group === "done" && t.canvasFinal) {
    out.push(finalCanvas(t, css));
    if (body) out.push(`<details class="cnotes" id="cd-${esc(t.id)}"><summary>Card</summary><div class="nt">${body}</div></details>`);
  } else if (body) out.push(`<div class="nt">${body}</div>`);
  // a done card with a card.md keeps its notes in the same place; a report on disk is pointed at, not inlined
  if (group === "done" && t.card.trim() && t.notes.trim() && !t.card.includes(t.notes.trim())) {
    out.push(`<details class="cnotes" id="fn-${esc(t.id)}"><summary>Notes</summary>${markdown(t.notes)}</details>`);
  }
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
  if (lite) {
    const html = out.slice(2).join("");
    const sheet = [...css].map(scaleText).join("\n").replace(/<\/style/gi, "<\\/style");
    const hash = createHash("sha1").update(html).update("\0").update(sheet).digest("hex").slice(0, 12);
    ctx.bodies.set(t.id, { hash, html, css: sheet });
    return `${out[0].replace(/>$/, ` data-bh="${hash}">`)}${out[1]}<details class="lz" id="lz-${esc(t.id)}"><summary>Show card</summary><div class="lzb"></div></details></article>`;
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
      const fail = t.state === "failed" ? ` class="fail"` : "";
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

/** Stage of every task the page shows (live ones from Paseo + intent, archive lines frozen), keyed by task id. */
export function stagesOf(model: ProjectModel, agents: Record<string, AgentView>, o: { now: Date; labeled?: RenderOpts["labeled"]; canvas?: CanvasData; stalled?: RenderOpts["stalled"] }): Map<string, Stage> {
  const out = new Map<string, Stage>();
  const so = { ...o, comments: model.comments };
  for (const t of model.archive) out.set(t.id, stageOf(t, false, so));
  for (const t of model.tasks) out.set(t.id, stageOf(t, true, so, (id) => agents[id]));
  return out;
}

function renderLive(model: ProjectModel, agents: Record<string, AgentView>, o: RenderOpts): { html: string; attention: Attention; bodies: Map<string, Body> } {
  const liveIds = new Set(model.tasks.map((t) => t.id));
  const archive = model.archive.filter((t) => !liveIds.has(t.id)).reverse(); // newest first
  const all = [...model.tasks, ...archive];
  const byId = new Map(all.map((t) => [t.id, t]));
  const unblocks = new Map<string, string[]>();
  for (const t of all) for (const d of t.depends_on) unblocks.set(d, [...(unblocks.get(d) ?? []), t.id]);
  const stages = stagesOf(model, agents, o);
  const ctx: Ctx = { bodies: new Map(), snapCss: new Set(), byId, unblocks, agents, o, comments: model.comments, stages, canvas: o.canvas };

  const buckets: Record<GroupKey, { t: Task; g: GroupKey }[]> = { you: [], fm: [], running: [], blocked: [], next: [], parked: [], done: [] };
  for (const t of model.tasks) buckets[stages.get(t.id)!.group].push({ t, g: stages.get(t.id)!.group });
  for (const t of archive) buckets.done.push({ t, g: "done" });
  // Done: most recently updated (lastEvent) first, live and archived together. An explicit `order` on a live task still pins it
  // ahead of the rest in any group. An archive line's `order` is ignored: it is the position the task had in a group of the
  // hand-run page it was migrated from, and would otherwise pin every migrated task above all newer finished work.
  buckets.done.sort((a, b) => b.t.updatedMs - a.t.updatedMs);
  // Parked: most recently parked (`since`, set when the state changed) first; an explicit `order` still pins a live task.
  buckets.parked.sort((a, b) => b.t.updatedMs - a.t.updatedMs);
  const archivedIds = new Set(archive.map((t) => t.id));
  for (const k of Object.keys(buckets) as GroupKey[]) buckets[k] = byOrder(buckets[k].map((x) => ({ ...x, order: archivedIds.has(x.t.id) ? undefined : x.t.order }))).map(({ t, g }) => ({ t, g }));

  const busy = GROUPS.filter(([k]) => k !== "done").flatMap(([k]) => buckets[k])
    .filter(({ t }) => { const a = stages.get(t.id)?.agentId; return a && ACTIVE.has(agents[a]?.status ?? "") && !o.labeled?.[t.id]?.find((x) => x.id === a)?.hostOffline; }).length;
  const failedN = buckets.done.filter(({ t }) => stages.get(t.id)?.failed ?? t.state === "failed").length;
  const countOf = (k: GroupKey) => (k === "done" ? buckets.done.length - failedN : buckets[k].length); // a failed task is not "done"
  // Done cards with a card.md start "unread" (the page moves the ones the captain has marked read into the Done group)
  // The captain's marks (state/projects/<p>/ui-state.json) are applied here too, so the first paint already has the right split.
  const cands = buckets.done.filter(({ t }) => markable(t) && !(stages.get(t.id)?.failed ?? t.state === "failed"));
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
  if (o.canvas?.status === "down") summary += `<span class="fl cv-down" title="agent-canvas could not be reached from the deck">canvas unavailable</span>`;
  const parts = [`<div class="summary">${summary}<span class="m">live: the page checks ${o.tickSeconds === 1 ? "every second" : `every ${o.tickSeconds} s`}; the plugin refreshes it on every change (last change <span data-chg="time"></span>)</span></div>`];
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
  if (ctx.snapCss.size) parts.push(`<style data-cv-snap>\n${[...ctx.snapCss].map(scaleText).join("\n").replace(/<\/style/gi, "<\\/style")}\n</style>`);
  if (parts.length === 1) parts.push(`<div class="m">No tasks for this project yet.</div>`);
  // Trails for the page and the sections live outside the live block (page.html is not rewritten per comment);
  // the page script copies these into their slots after every swap.
  const slots = ["page", ...model.sections.map((s) => s.name)]
    .map((k) => [k, trailHtml(model.comments, k, o.now)] as const).filter(([, h]) => h)
    .map(([k, h]) => `<div data-trail-for="${esc(k)}">${h}</div>`).join("");
  parts.push(`<div hidden data-trails>${slots}</div>`);
  // The two time-varying bits of the shell travel here too, so page.html stays still while the page is live.
  parts.push(`<div hidden data-slots><div data-slot-for="stamp"><span data-chg="long"></span></div><div data-slot-for="banner">${bannerHtml(o.banner)}</div></div>`);
  parts.push(`<div hidden data-tn>${navHtml(buckets)}</div>`);
  // What the browser tab says: the Needs-you count, the attention keys, and the keys the captain last saw (see attention.ts).
  // No stored "seen" yet (first render) means nothing is new: the runtime seeds it from these keys.
  const attention = attentionOf(model, [...model.tasks, ...archive], stages, o.canvas);
  parts.push(`<div hidden data-attn data-n="${attention.needsYou}" data-title="${esc(model.title)}" data-keys="${esc(JSON.stringify(attention.keys))}"${model.seen ? ` data-seen="${esc(JSON.stringify(model.seen))}"` : ""}></div>`);
  return { html: parts.join("\n"), attention, bodies: ctx.bodies };
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
export function liveJs(liveHtml: string, iso?: string, seq?: number, hash?: string): string {
  const extra = iso || seq !== undefined || hash ? `,${JSON.stringify(iso ?? "")}${seq !== undefined || hash ? `,${seq ?? "null"}` : ""}${hash ? `,${JSON.stringify(hash)}` : ""}` : "";
  return `window.__fdLive&&window.__fdLive(${JSON.stringify(liveHtml)}${extra});\n`;
}

/** The signature a page file was written with (render.ts embeds it right after the doctype); "" for a file without one. */
export function pageSigOf(head: string): string {
  return /<!--fd-sig:([0-9a-f]{40})-->/.exec(head)?.[1] ?? "";
}

/** A card body's file (named by its content hash, so it is immutable): the page loads it when the card is opened. */
export function bodyJs(id: string, b: Body): string {
  return `window.__fdBody&&window.__fdBody(${JSON.stringify(id)},${JSON.stringify(b.hash)},${JSON.stringify(b.html)},${JSON.stringify(b.css)});\n`;
}
/** Folder next to the page that holds the body files, and a body file's name in it. */
export const bodyDirOf = (pageFile: string) => pageFile.replace(/\.[^./]*$/, "") + ".d";
export const bodyFileName = (id: string, hash: string) => `b.${id.replace(/[^\w.-]/g, "_")}.${hash}.js`;

/** The tiny file an open page polls every second: the payload's content hash (the page fetches the full file only when it moved) and the growing sequence number its staleness check watches. */
export function liveVersionJs(hash: string, iso: string, seq: number, chg?: string): string {
  const more = chg ? `,${JSON.stringify(chg)}` : "";
  return `window.__fdVer&&window.__fdVer(${JSON.stringify(hash)},${seq},${JSON.stringify(iso)}${more});\n`;
}

export const liveFileOf = (pageFile: string) => pageFile.replace(/\.[^./]*$/, "") + ".live.js";
export const liveVersionFileOf = (pageFile: string) => pageFile.replace(/\.[^./]*$/, "") + ".live.v.js";

export const STALE_TEXT = "This page stopped updating. Your comments may not reach the first mate until it's fixed (the first mate can run bin/page heal).";

function bannerHtml(b: RenderOpts["banner"]): string {
  return b ? `<div class="banner ${b.kind === "ended" ? "b-off" : "b-bad"}" role="status">${esc(b.text)}</div>` : "";
}

export function renderProject(model: ProjectModel, agents: Record<string, AgentView>, opts: RenderOpts): Rendered {
  const { html: live, attention, bodies } = renderLive(model, agents, opts);
  const pageFile = opts.pageFile ?? (model.page ? model.page.slice(model.page.lastIndexOf("/") + 1) : "page.html");
  const liveFile = pageFile.replace(/\.[^./]*$/, "") + ".live.js";

  const names = model.sections.map((s) => s.name);
  const nav = [`<a href="#tasks">Tasks</a>`, ...names.map((n) =>
    `<a href="#${esc(n)}">${esc(model.sectionTitles[n] ?? DEFAULT_TITLES[n] ?? titleCase(n))}</a>`)].join("");
  // The shell is everything except the three things that change while the page is live: the task snapshot in #live,
  // the "last update" stamp and the session banner (the live payload carries the latter two in slots).
  const shell = (snapshot: string, stamp: string, banner: string, sig = "") => `<!doctype html>
<!--fd-sig:${sig}-->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.title)} · status</title>
<style>
${CSS}
</style>${opts.canvas?.css ? `\n<style>\n${scaleText(opts.canvas.css).replace(/<\/style/gi, "<\\/style")}\n</style>` : ""}
</head><body>
<!-- the task navigator: data-lavish-action keeps its clicks working in Lavish's annotate mode -->
<aside class="tn" id="tn" aria-label="Tasks by stage" data-lavish-action hidden><div class="tn-spine"><button class="tn-tg" id="tn-open" type="button" aria-expanded="false" aria-controls="tn-full" aria-label="Show task titles" title="Show task titles">${svg(ICON.panelOpen)}</button><button class="tn-tg tn-fx" type="button" aria-pressed="false" aria-label="Focus view: show only the selected task" title="Focus view: show only the selected task">${svg(ICON.focus)}</button><div class="tn-bds" id="tn-bds"></div></div><div class="tn-full" id="tn-full"><div class="tn-top"><button class="tn-tg" id="tn-close" type="button" aria-expanded="true" aria-controls="tn-full" aria-label="Fold the task list" title="Fold the task list">${svg(ICON.panelClose)}</button><b>Tasks</b><button class="tn-tg tn-fx" type="button" aria-pressed="false" aria-label="Focus view: show only the selected task" title="Focus view: show only the selected task">${svg(ICON.focus)}</button></div><div class="tn-fl" id="tn-fl"></div></div></aside>
<div class="tn-fly" id="tn-fly" role="region" aria-label="Stage titles" data-lavish-action hidden></div>
<div class="tn-back" id="tn-back" data-lavish-action hidden></div>
<div class="tn-sheet" id="tn-sheet" role="dialog" aria-modal="true" aria-label="Tasks by stage" data-lavish-action hidden><div class="tn-sb" id="tn-sl"></div><div class="tn-sf"><button class="tn-fx tn-fxl" type="button" aria-pressed="false">${svg(ICON.focus)}<span>Focus view</span></button><button class="tn-sx" id="tn-sx" type="button">Close</button></div></div>
<main>
<h1>${esc(model.title)}</h1>
<div class="sub">Kept current by the firstmate-deck plugin · last update <b data-slot="stamp">${stamp}</b></div>
<p class="chan"><b>This page is our channel.</b> Comment on any card or block, then Send; the first mate answers here.</p>
<div class="trail-slot" data-trail-slot="page"></div>
<div class="banner b-bad" id="fd-stale" role="status" hidden>${esc(STALE_TEXT)}</div>
<div data-slot="banner">${banner}</div>
<nav>${nav}</nav>
<button class="tn-bar" id="tn-bar" type="button" data-lavish-action aria-haspopup="dialog" aria-expanded="false" aria-controls="tn-sheet" hidden></button>

<h2 id="tasks">Tasks</h2>
<div class="m">Each task once: its state, its crew agent live, and what it depends on. Titles and “Open in Paseo” go to the agent in the Paseo web UI.</div>
<div class="tn-fbar" id="tn-fbar" role="status" data-lavish-action hidden></div>
<div id="live"><!--LIVE-START-->${snapshot}<!--LIVE-END--></div>
${names.map((n) => renderSection(model, n)).join("\n")}
<script>
${navScript()}
${IDIOMORPH_SOURCE.replace(/<\/(script|body|head|html)/gi, "<\\/$1")}
${pageScript(model.project, liveFile, opts.tickSeconds, opts.marksUrl)}
</script>
</main></body></html>
`;
  // The signature is the shell with its volatile parts blanked, so any change to the frame (title, sections, CSS,
  // scripts, marks url) moves it and a task, agent or stage change does not: Lavish reloads the page when page.html is
  // rewritten, so that file must stay still while crews work.
  const signature = createHash("sha1").update(shell("", "", "")).digest("hex");
  // The page file holds the shell and nothing that moves: no task list, no stamp, no banner. Those arrive in the live payload, so the
  // file is the same bytes for as long as its frame is, and a plugin restart (which only re-renders) has no reason to rewrite it.
  // Its signature is written into it, so a restarted plugin can see the file on disk is already the right one.
  const page = shell(`<div class="m" id="fd-loading">Loading the page…</div>`, "", "", signature);
  return { page, live, signature, attention, bodies: Object.fromEntries(bodies) };
}
