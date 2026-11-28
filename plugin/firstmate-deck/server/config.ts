// Plugin settings + environment -> the effective configuration. resolveConfig is pure; normalizeRoot touches the disk.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SettingsValues = { firstmateRoot?: string; firstmateLabel?: string; lavishPort?: number; lavishStateDir?: string; lavishBin?: string; readMarksPort?: number; readMarksHost?: string; notifyUrl?: string; canvasUrl?: string; canvasDir?: string };

export type DeckConfig = {
  root: string;
  firstmateLabel: string;
  lavishPort?: string;
  lavishStateDir?: string;
  /** Absolute path of a lavish-axi cli.mjs to use instead of the default lookup (settings only, no environment). */
  lavishBin?: string;
  /** Port of the read-marks endpoint (default 4398). 0 turns it off. */
  readMarksPort?: number;
  /** Fallback tailnet host to bind when `tailscale ip -4` finds none. */
  readMarksHost?: string;
  /** The https address of the read-marks endpoint for the "Notify me" window (no trailing slash); unset = its own http address. */
  notifyUrl?: string;
  /** Base URL of agent-canvas (default http://127.0.0.1:6790). "" = no canvas in the cards. */
  canvasUrl?: string;
  canvasDir?: string;
  /** Set by normalizeRoot when the root is unusable (missing, or no state/ inside). Shown in the app and the log. */
  rootProblem?: string;
};

export const LAVISH_DEFAULT_PORT = 4387;
export const READ_MARKS_DEFAULT_PORT = 4398;
export const CANVAS_DEFAULT_URL = "http://127.0.0.1:6790";

export function resolveConfig(s: SettingsValues, env: Record<string, string | undefined>): DeckConfig {
  // The settings schema always yields a port (default 4387, Lavish's own default), so "unset" means "still the
  // default": only then does the environment get a say.
  const port = s.lavishPort && s.lavishPort !== LAVISH_DEFAULT_PORT ? String(s.lavishPort) : env.LAVISH_AXI_PORT || (s.lavishPort ? String(s.lavishPort) : undefined);
  // like the Lavish port: the schema always yields a URL, so "still the default" lets the environment have a say; "off" disables
  const cu = (s.canvasUrl ?? "").trim();
  const canvasUrl = cu === "off" ? "" : cu && cu !== CANVAS_DEFAULT_URL ? cu : (env.AGENT_CANVAS_URL ?? "").trim() || cu || CANVAS_DEFAULT_URL;
  return {
    canvasUrl,
    canvasDir: s.canvasDir || env.AGENT_CANVAS_DIR || undefined,
    root: s.firstmateRoot || env.FIRSTMATE_ROOT || "",
    firstmateLabel: s.firstmateLabel || "firstmate=true",
    lavishPort: port,
    lavishStateDir: s.lavishStateDir || env.LAVISH_AXI_STATE_DIR || undefined,
    lavishBin: s.lavishBin?.trim() || undefined,
    readMarksPort: Number.isInteger(s.readMarksPort) && (s.readMarksPort as number) >= 0 && (s.readMarksPort as number) < 65536 ? (s.readMarksPort as number) : READ_MARKS_DEFAULT_PORT,
    readMarksHost: s.readMarksHost || "",
    notifyUrl: /^https?:\/\/[^\s/]/i.test((s.notifyUrl ?? "").trim()) ? (s.notifyUrl as string).trim().replace(/\/+$/, "") : undefined,
  };
}

/**
 * Expand `~`, make the root absolute and resolve symlinks. A root that does not exist, or has no state/ in it,
 * comes back with `problem` set; the caller logs it and shows it instead of going silently idle.
 */
export function normalizeRoot(root: string): { root: string; problem?: string } {
  if (!root) return { root };
  let r = root.trim();
  if (r === "~" || r.startsWith("~/")) r = join(homedir(), r.slice(1));
  r = resolve(r);
  try { r = realpathSync(r); } catch { return { root: r, problem: `firstmateRoot ${r} does not exist` }; }
  if (!existsSync(join(r, "state"))) return { root: r, problem: `firstmateRoot ${r} has no state/ directory: it must be the paseo-firstmate checkout` };
  return { root: r };
}
