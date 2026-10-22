// The contract between the plugin's daemon side (server/) and its app side (client/).
// Server owns the data; the client only renders it. Keep both sides importing from here.
import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Host-scoped settings. firstmateRoot is the first-mate checkout whose state/ the plugin reads.
export const deckSettings = defineSettings({
  id: "deck",
  scope: "host",
  version: 1,
  schema: z.object({
    firstmateRoot: z.string().default(""),
    firstmateLabel: z.string().default("firstmate=true"),
    lavishPort: z.number().int().default(4387),
    lavishStateDir: z.string().default(""),
    // Read marks ("Done, unread" cards): the port of the plugin's tiny CORS endpoint, bound to 127.0.0.1 and the tailnet IP.
    // 4398, so it does not collide with a hand-run page's own 4399 while both run.
    readMarksPort: z.number().int().default(4398),
    // The tailnet IP (or host) to bind when `tailscale ip -4` finds none. Empty = loopback only.
    readMarksHost: z.string().default(""),
  }),
});

const askSchema = z.object({
  taskId: z.string(),
  askId: z.string().nullable().optional(), // bin/fleet's stable ask id ("a2"); null for a task that needs you without an ask
  taskTitle: z.string(),
  text: z.string(), // the BLUF question
  since: z.string(),
});

const runningSchema = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  agentId: z.string().nullable(),
  agentStatus: z.string(), // initializing | idle | running | error | closed | archived | unknown
  current: z.string(), // humanized current step, may be ""
  startedAt: z.string().nullable(),
});

export const projectSummarySchema = z.object({
  project: z.string(),
  title: z.string(),
  repo: z.string().nullable(), // absolute path, used to match a Paseo workspace to its project
  pageUrl: z.string().nullable(), // Lavish session URL, null until the page has been opened
  session: z.enum(["open", "ended", "stopped", "unknown"]),
  needsYou: z.array(askSchema),
  running: z.array(runningSchema),
  counts: z.object({ needsYou: z.number(), withFirstMate: z.number().optional(), running: z.number(), blocked: z.number().optional(), next: z.number(), parked: z.number(), done: z.number(), failed: z.number().optional() }), // failed tasks are not counted as done
  undelivered: z.number(), // comments not yet delivered to the first mate
  banner: z.string().nullable(), // e.g. "first mate unreachable, 2 comments queued"
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

// deck.summary: every project page, or one when `project` is given.
export const summaryRpc = defineRpc({
  name: "deck.summary",
  input: z.object({ project: z.string().optional() }),
  output: z.object({
    projects: z.array(projectSummarySchema),
    firstmateAgentId: z.string().nullable(),
    /** Set when the plugin cannot work at all, e.g. firstmateRoot points nowhere. Absent on older plugin builds. */
    problem: z.string().nullable().optional(),
  }),
});

// Timeline row appended to the first mate's chat when page comments are delivered.
export const COMMENT_ROW_KIND = "page-comments";
export const COMMENT_ROW_VERSION = 1;
export const commentRowSchema = z.object({
  project: z.string(),
  pageUrl: z.string().nullable(),
  at: z.string(),
  comments: z.array(z.object({ target: z.string(), text: z.string() })), // target: "t-<taskId>", a section id, or "page"
  replied: z.boolean(),
});
export type CommentRow = z.infer<typeof commentRowSchema>;
