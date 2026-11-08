// The crew's recap ("You asked / I did"): a top-level <Markdown id="recap"> every strict crew writes on a canvas that asks the
// captain something or is done (agent-canvas needs-you.ts). Live, agent-canvas lifts it into its summary; a done task keeps it in
// canvas.final.tsx, parsed here. The card shows it as a strip of its own and the embedded canvas leaves it out.
export type Recap = { asked: string; did: string };

const clean = (t: string) => t.replace(/\s+/g, " ").trim();

/** The two halves of a recap's Markdown, or null when either is missing. */
export function parseRecapText(md: string): Recap | null {
  const m = /you asked:\s*([\s\S]*?)\s*\bi did:\s*([\s\S]*)/i.exec(md.replace(/\*\*|__/g, ""));
  return m && clean(m[1]) && clean(m[2]) ? { asked: clean(m[1]), did: clean(m[2]) } : null;
}

/** The recap of a canvas source (`canvas.final.tsx`). Null when there is none. */
export function recapOfSource(tsx: string): Recap | null {
  const m = /<Markdown\b[^>]*\bid="recap"[^>]*>([\s\S]*?)<\/Markdown>/.exec(tsx);
  return m ? parseRecapText(m[1].replace(/&lt;/g, "<").replace(/&amp;/g, "&")) : null;
}
