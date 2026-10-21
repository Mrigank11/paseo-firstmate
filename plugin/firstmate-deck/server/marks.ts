// Read marks: which "Done, unread" cards the captain has seen. A mark is keyed by the card's DOM id ("t-<task>") and the
// hash of its card.md, so editing a card makes it unread again. The page keeps its marks in the browser and syncs them
// to a tiny CORS endpoint the plugin serves (marks-server.ts); this file is the pure part, shared by the renderer, the
// endpoint and the importer.
import { createHash } from "node:crypto";

/** The hash a card carries in `data-h`: the first 8 hex digits of the sha1 of the card text, as the hand-run page did. */
export const cardHash = (card: string): string => createHash("sha1").update(card).digest("hex").slice(0, 8);

/** What the endpoint stores per project (and live.py's ui-state.json format): `o` = open/closed sections, `r` = read marks. */
export type UiState = { o: Record<string, number>; r: Record<string, string> };

export function emptyUi(): UiState {
  return { o: {}, r: {} };
}

/** Parse untrusted JSON into a UiState: only 0/1 section flags and short string hashes survive. */
export function cleanUi(raw: unknown): UiState {
  const out = emptyUi();
  const src = raw && typeof raw === "object" ? (raw as any) : {};
  for (const [k, v] of Object.entries(src.o && typeof src.o === "object" ? src.o : {})) {
    if (/^[\w.:-]{1,120}$/.test(k) && (v === 0 || v === 1)) out.o[k] = v as number;
  }
  for (const [k, v] of Object.entries(src.r && typeof src.r === "object" ? src.r : {})) {
    if (/^t-[\w.-]{1,120}$/.test(k) && typeof v === "string" && /^[0-9a-f]{1,64}$/.test(v)) out.r[k] = v;
  }
  return out;
}

/** Merge an incoming state into the stored one. Read marks only ever add (an incoming hash replaces an older one for the same card). */
export function mergeUi(cur: UiState, inc: UiState): UiState {
  return { o: { ...cur.o, ...inc.o }, r: { ...cur.r, ...inc.r } };
}
