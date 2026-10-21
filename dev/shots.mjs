// Screenshots of the sandbox Paseo web UI after a demo run: sidebar, the first mate's chat (page-comments
// row) and the deck-demo project panel. One headless Chrome; never points at the live daemon.
//   node dev/shots.mjs <out-dir>
import { chromium } from "/home/mrigank/projects/llm-exp/paseo/node_modules/playwright-core/index.mjs";
const out = (process.argv[2] ?? "/tmp/deck-shots").replace(/\/?$/, "/");
const UI = "http://100.101.33.17:6777/";
const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--headless=new", "--no-sandbox"],
  env: { ...process.env, XDG_CONFIG_HOME: "/tmp/deck-shots-xdg" } });
const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const shot = async (name) => { await p.waitForTimeout(1200); await p.screenshot({ path: out + name }); console.log(out + name); };
await p.goto(UI, { waitUntil: "load" });
await p.waitForTimeout(5000);
await shot("1-sidebar.png");
// the first mate's workspace, then scroll its chat to the page-comments row
await p.getByText("first mate (sandbox)").first().click().catch(() => p.getByText("feat/project-deck").first().click());
await p.waitForTimeout(3500);
await p.getByText(/page comment/i).last().scrollIntoViewIfNeeded().catch(() => {});
await shot("2-first-mate-chat.png");
// Needs you screen
await p.getByText(/Needs you ·/).first().click().catch(() => {});
await shot("3-needs-you.png");
await b.close();
