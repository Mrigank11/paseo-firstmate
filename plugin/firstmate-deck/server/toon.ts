// Decode `lavish-axi poll` output (TOON) and classify it. The decoder is the @toon-format/toon plugin
// dependency; if it is not installed we fall back to the copy inside the resolved lavish-axi install.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type Prompt = { uid?: string; prompt: string; selector?: string; tag?: string; text?: string; [k: string]: unknown };

export type PollOutcome = {
  kind: "feedback" | "ended" | "disconnected" | "listener-active" | "error" | "waiting";
  prompts: Prompt[];
  /** The session is over: deliver `prompts` (possibly none), then stop polling. */
  ended: boolean;
  endedBy?: string;
  /** For listener-active: the label of the other holder. */
  holder?: string;
  message?: string;
};

type Decoder = (text: string) => unknown;
let decoder: Decoder | null = null;

export async function loadDecoder(lavishBin?: string): Promise<Decoder> {
  if (decoder) return decoder;
  try {
    const m: any = await import("@toon-format/toon");
    return (decoder = m.decode as Decoder);
  } catch {}
  if (lavishBin) {
    // <install>/node_modules/lavish-axi/dist/cli.mjs -> <install>/node_modules/@toon-format/toon
    const nm = dirname(dirname(dirname(lavishBin)));
    const pkgDir = join(nm, "@toon-format", "toon");
    const pkgFile = join(pkgDir, "package.json");
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
      const exp = pkg.exports?.["."];
      const rel = (typeof exp === "string" ? exp : exp?.import ?? exp?.default) ?? pkg.module ?? pkg.main ?? "dist/index.mjs";
      const m: any = await import(pathToFileURL(join(pkgDir, rel)).href);
      return (decoder = m.decode as Decoder);
    }
  }
  throw new Error("no TOON decoder: install @toon-format/toon in the plugin directory");
}

export async function decodePoll(stdout: string, lavishBin?: string): Promise<any> {
  const text = stdout.split("\n").filter((l) => !l.startsWith("[lavish-axi]")).join("\n").trim();
  if (!text) throw new Error("empty poll output");
  return (await loadDecoder(lavishBin))(text);
}

export function classifyPoll(doc: any): PollOutcome {
  const base = { prompts: [] as Prompt[], ended: false };
  if (!doc || typeof doc !== "object") return { ...base, kind: "error", message: "unreadable poll output" };
  if (doc.code === "LISTENER_ACTIVE") {
    const m = /current listener: ([^;)]+?)(?:;|\))/.exec(String(doc.error ?? ""));
    return { ...base, kind: "listener-active", holder: m?.[1], message: String(doc.error ?? "") };
  }
  const s = doc.session;
  if (!s || typeof s !== "object") return { ...base, kind: "error", message: String(doc.error ?? doc.code ?? "no session in poll output") };
  const prompts: Prompt[] = Array.isArray(doc.prompts)
    ? doc.prompts.filter((p: any) => p && typeof p === "object").map((p: any) => ({ ...p, prompt: String(p.prompt ?? "") }))
    : [];
  const status = String(s.status ?? "");
  const endedBy = s.ended_by ? String(s.ended_by) : undefined;
  const ended = status === "ended" || status === "user-ended" || s.session_ended === true || !!endedBy;
  if (ended) return { kind: "ended", prompts, ended: true, endedBy };
  if (status === "browser_disconnected") return { kind: "disconnected", prompts, ended: false };
  if (prompts.length) return { kind: "feedback", prompts, ended: false };
  return { kind: "waiting", prompts, ended: false };
}
