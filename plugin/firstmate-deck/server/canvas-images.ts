// A crew canvas's pictures arrive in the card as `<img src=".../asset/<hash>">`: host-less for a Markdown image, and the
// daemon's own public address for an <Image>. Neither loads in the page the captain reads (the page is another origin, and
// a snapshot outlives the daemon's asset cache), so the deck swaps each for the bytes themselves as a data: URI.
const IMG = /(<img\b[^>]*?\ssrc=")(?:https?:\/\/[^"\/]+)?\/asset\/([0-9a-f]{32})(")/g;

export type LoadedImage = { mime: string; bytes: Uint8Array };

/** Replace every canvas asset link in `html` with a data: URI. A picture `load` cannot fetch keeps its link, so the card stays whole. */
export async function inlineImages(html: string, load: (hash: string) => Promise<LoadedImage | null>): Promise<string> {
  const hashes = [...new Set([...html.matchAll(IMG)].map((m) => m[2]))];
  if (!hashes.length) return html;
  const got = new Map<string, string>();
  await Promise.all(hashes.map(async (h) => {
    const img = await load(h).catch(() => null);
    if (img && /^image\/(png|jpeg|webp|gif)$/.test(img.mime)) got.set(h, `data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}`);
  }));
  return html.replace(IMG, (all, a: string, h: string, z: string) => (got.has(h) ? a + got.get(h) + z : all));
}

/** Like inlineImages, but each picture is stored (`save`) and the card links to it (`link(hash)`): the page payload stays small. A picture that cannot be loaded or stored keeps its original link. */
export async function linkImages(html: string, load: (hash: string) => Promise<LoadedImage | null>,
  save: (hash: string, img: LoadedImage) => boolean, link: (hash: string) => string): Promise<string> {
  const hashes = [...new Set([...html.matchAll(IMG)].map((m) => m[2]))];
  if (!hashes.length) return html;
  const got = new Set<string>();
  await Promise.all(hashes.map(async (h) => {
    const img = await load(h).catch(() => null);
    if (img && save(h, img)) got.add(h);
  }));
  return html.replace(IMG, (all, a: string, h: string, z: string) => (got.has(h) ? a + link(h) + z : all));
}
