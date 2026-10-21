// Post one comment into a Lavish session the way a person does: open the session URL in headless Chrome,
// click an element inside the artifact, type, press Ctrl+Enter ("send"). Prints {"sentAt": <epoch ms>}.
//   node dev/post-comment.mjs <session-url> <css selector inside the page> "<comment>"
// One Chrome at a time. Uses playwright-core from the paseo checkout and branded Chrome (rendering only).
import { chromium } from "/home/mrigank/projects/llm-exp/paseo/node_modules/playwright-core/index.mjs";

const [url, selector, text] = process.argv.slice(2);
if (!url || !selector || !text) { console.error('usage: post-comment.mjs <session-url> <selector> "<comment>"'); process.exit(2); }
const b = await chromium.launch({
  executablePath: "/opt/google/chrome/chrome",
  args: ["--headless=new", "--no-sandbox"],
  env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "/tmp/deck-xdg" },
});
try {
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await p.goto(url, { waitUntil: "load" });
  const f = p.frameLocator('iframe[src*="/artifact/"]'); // re-resolved on every use: Lavish may reload the frame
  await f.locator(selector).first().waitFor({ timeout: 20000 });
  await p.waitForTimeout(2000); // Lavish's annotate layer attaches after the artifact loads
  const box = f.locator('textarea[placeholder^="Tell the agent"]');
  for (let i = 0; i < 4 && !(await box.isVisible()); i++) {
    await f.locator(selector).first().click({ timeout: 10000 });
    await p.waitForTimeout(800);
  }
  await box.waitFor({ timeout: 5000 });
  await box.fill(text);
  const sentAt = Date.now();
  await box.press("Control+Enter");
  await p.waitForTimeout(1200); // let the request leave before the browser closes
  console.log(JSON.stringify({ sentAt }));
} finally {
  await b.close();
}
