import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatMessage, keepAttachments, newEntries } from "../server/relay.ts";

const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "attach-"));
const known = { tasks: [], sections: [] };
const att = (path: string) => ({ type: "image", path, mime: "image/png", width: 800, height: 600 });

test("relay line names each attachment with its size", () => {
  const msg = formatMessage("p", [{ id: "c-1", target: "page", text: "look", prompt: { prompt: "look", attachments: [att("/a/x.png"), att("/a/y.png")] } }]);
  assert.match(msg, /\(c-1\) "look" \[image: \/a\/x\.png \(800x600\)\] \[image: \/a\/y\.png \(800x600\)\]/);
});

test("an image-only comment reads (image only), not an empty string", () => {
  const msg = formatMessage("p", [{ id: "c-1", target: "page", text: "", prompt: { prompt: "", attachments: [att("/a/x.png")] } }]);
  assert.match(msg, /\(c-1\) \(image only\) \[image: \/a\/x\.png \(800x600\)\]/);
});

test("a comment without attachments is unchanged", () => {
  const msg = formatMessage("p", [{ id: "c-1", target: "page", text: "hi", prompt: { prompt: "hi" } }]);
  assert.match(msg, /\(c-1\) "hi"$/m);
});

test("ingest copies attachments into the project and points inbox and relay at the copy", () => {
  const dir = scratch();
  try {
    const src = join(dir, "up.png");
    writeFileSync(src, "PNGDATA");
    const dest = join(dir, "project", "attachments");
    const [e] = newEntries("p", [{ prompt: "", attachments: [att(src)] } as any], known, new Date(), undefined, dest);
    const kept = (e.prompt as any).attachments[0];
    assert.ok(kept.path.startsWith(dest + "/"), kept.path);
    assert.equal(kept.original, src);
    assert.equal(kept.width, 800);
    rmSync(src); // Lavish's sweep
    assert.equal(readFileSync(kept.path, "utf8"), "PNGDATA");
    assert.ok(formatMessage("p", [e]).includes(`[image: ${kept.path} (800x600)]`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing source keeps the original path and does not throw", () => {
  const dir = scratch();
  try {
    const p = keepAttachments({ prompt: "x", attachments: [att(join(dir, "gone.png"))] } as any, join(dir, "a"), "c-1");
    assert.equal((p as any).attachments[0].path, join(dir, "gone.png"));
    assert.ok(!existsSync(join(dir, "a", "c-1-1-gone.png")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
