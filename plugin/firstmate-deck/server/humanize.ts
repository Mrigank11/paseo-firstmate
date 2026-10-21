// Port of live.py's shell_phrase / human: turn a raw agent step (tag, text) into a short readable phrase.

export function cut(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

const SKIP = new Set(["cd", "sleep", "echo", "set", "export", "true", "mkdir", "E", "}", "kill", "printf"]);

/** 'cd x && rtk npm run check >/dev/null 2>&1; echo …' -> 'Ran npm run check' */
export function shellPhrase(cmdIn: string): string {
  const cmd = cmdIn.replace(/\$\([^)]*\)/g, "…");
  for (let part of cmd.split(/\s*(?:&&|;|\|\|)\s*/)) {
    part = part.split(" | ")[0].trim().replace(/^\(+|\)+$/g, "");
    part = part.replace(/^(?:setsid |nohup |rtk proxy |rtk |timeout \d+ |[A-Za-z_]+=\S+ )+/, "");
    part = part.replace(/\s+\d?>>?&?\s*\S+/g, "").trim();
    part = part.replace(/^git -C \S+/, "git");
    let w = part.split(/\s+/).filter(Boolean);
    if (!w.length || /^[A-Za-z_]+=\S*$/.test(part) || SKIP.has(w[0])) continue;
    const last = w[w.length - 1];
    if (["sed", "head", "tail", "cat", "less", "wc", "jq"].includes(w[0]) && !"-'\"".includes(last[0])) {
      return "Read " + baseName(last);
    }
    if (["grep", "rg", "find", "ls"].includes(w[0])) {
      return "Searched " + cut(w.slice(1).filter((x) => !x.startsWith("-")).join(" "), 50);
    }
    if (w[0] === "curl") {
      const hit = w.find((x) => x.includes("http"));
      const u = hit ? hit.replace(/^["']+|["']+$/g, "") : "";
      return u ? "Called " + cut(u.split("?")[0].replace(/^https?:\/\//, ""), 60) : "Called an HTTP endpoint";
    }
    if (["python3", "python", "node", "bash"].includes(w[0]) && (w.length === 1 || ["-", "-c", "-e"].includes(w[1]))) {
      return `Ran a ${w[0].replace(/3+$/, "")} snippet`;
    }
    if (w[0] === "npx") w = w.slice(1).filter((x) => !x.startsWith("-"));
    return "Ran " + cut(w.slice(0, 4).join(" "), 60);
  }
  return "Ran a shell command";
}

export function human(tag: string, text: string): string {
  const t = text.trim();
  if (!t) return tag === "Bash" || tag === "Shell" ? "Running a shell command" : tag;
  if (tag === "Shell") return shellPhrase(t);
  if (tag === "Task notification") {
    const p = shellPhrase(t);
    return "Finished: " + p[0].toLowerCase() + p.slice(1);
  }
  if (tag === "Thought") return "Thinking: " + cut(t.split(/(?<=[.!?])\s/)[0], 110);
  if (tag === "Read" || tag === "Edit" || tag === "Write") {
    const verb = { Read: "Reading ", Edit: "Editing ", Write: "Writing " }[tag];
    return t ? verb + baseName(t.split(/\s+/)[0]) : tag;
  }
  if (tag === "Skill") return "Loading skill " + cut(t, 60);
  return `${tag}: ${cut(t, 100)}`;
}

const STEP = /^\[(?!Message received\]|User\])([A-Za-z][\w ]*)\]\s*(.*)/;

/** Parse one `paseo logs` line into [tag, text], or null when it is not a step line. */
export function parseStep(line: string): [string, string] | null {
  const m = STEP.exec(line);
  return m ? [m[1], m[2]] : null;
}
