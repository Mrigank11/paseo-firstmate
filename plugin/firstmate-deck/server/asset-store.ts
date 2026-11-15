// Crew screenshots live on disk, content-addressed, and reach the page as links to the deck's own web server
// (`<base>/asset/<hash>`, see marks-server.ts) instead of base64 inside the page payload. The text the deck keeps
// carries ASSET_MARK in place of the server's address (which differs per page: it follows the host the captain
// reached the page on); `resolveAssets` swaps it in when the page is written.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ASSET_MARK = "__FD_ASSET__";
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
export const ASSET_HASH = /^[0-9a-f]{32}$/;

export const assetDir = (root: string) => join(root, "state", "assets");

/** Keep a picture's bytes under its hash. Idempotent; a mime that is not an image is refused (false). */
export function saveAsset(dir: string, hash: string, mime: string, bytes: Uint8Array): boolean {
  const ext = EXT[mime.split(";")[0].trim().toLowerCase()];
  if (!ext || !ASSET_HASH.test(hash)) return false;
  const file = join(dir, `${hash}.${ext}`);
  if (existsSync(file)) return true;
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  return true;
}

export function readAsset(dir: string, hash: string): { mime: string; bytes: Buffer } | null {
  if (!ASSET_HASH.test(hash)) return null;
  for (const ext of Object.keys(MIME)) {
    try { return { mime: MIME[ext], bytes: readFileSync(join(dir, `${hash}.${ext}`)) }; } catch {}
  }
  return null;
}

export const assetLink = (hash: string) => `${ASSET_MARK}/asset/${hash}`;

const DATA_IMG = /(<img\b[^>]*?\ssrc=")data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)(")/g;
const memo = new Map<string, string>();

/** Turn every data: picture in `html` (a snapshot written before pictures were linked) into a stored picture and a link. Memoised, so a page render costs one hash of the text. */
export function externalizeImages(html: string, dir: string): string {
  if (!html.includes("data:image/")) return html;
  // keyed by the text itself: the same string instance (state.ts caches file text) is not re-hashed on every render
  const key = html;
  const had = memo.get(key);
  if (had !== undefined) return had;
  const out = html.replace(DATA_IMG, (all, a: string, mime: string, b64: string, z: string) => {
    const bytes = Buffer.from(b64, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    return saveAsset(dir, hash, mime, bytes) ? a + assetLink(hash) + z : all;
  });
  if (memo.size >= 32) memo.delete(memo.keys().next().value!);
  memo.set(key, out);
  return out;
}

const LINK = new RegExp(`${ASSET_MARK}/asset/([0-9a-f]{32})`, "g");

/** Put the deck server's address (`http://host:port`) in place of the mark. With no address the bytes go back inline, so a page is whole without the server. */
export function resolveAssets(text: string, base: string, dir: string): string {
  if (!text.includes(ASSET_MARK)) return text;
  if (base) return text.replaceAll(ASSET_MARK, base);
  return text.replace(LINK, (all, h: string) => {
    const a = readAsset(dir, h);
    return a ? `data:${a.mime};base64,${a.bytes.toString("base64")}` : all;
  });
}
