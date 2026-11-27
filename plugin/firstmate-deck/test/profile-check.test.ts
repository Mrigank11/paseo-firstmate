// The profile check: a crew launch that matches no firstmate profile is refused by the two before-hooks
// (server/profile-check.ts). Each launch runs both hooks, as the daemon does: create (config, no labels), then open (labels).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METADATA_KEY, ProfileCheck, registerProfileCheck, type Profile } from "../server/profile-check.ts";

const SHIPPED = JSON.parse(readFileSync(new URL("../../../config/paseo-profiles.json", import.meta.url), "utf8")) as Profile[];

const OPUS = { provider: "claude", model: "claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "medium" };
const SONNET = { provider: "claude", model: "claude-sonnet-5-5", modeId: "bypassPermissions", thinkingOptionId: "medium" };
const OPUS_HIGH = { ...OPUS, thinkingOptionId: "high" };
const SHIP = { "fm.task": "t1", "fm.shape": "ship", "paseo.parent-agent-id": "fm" };
const SCOUT = { "fm.task": "t1", "fm.shape": "scout", "paseo.parent-agent-id": "fm" };
const ID = "11111111-2222-4333-8444-555555555555";

type Launch = Record<string, unknown>;

function setup(o: { daemon?: unknown; rawConfig?: string | null; snapshot?: Profile[] | null; decisions?: string; check?: { log?: (m: string) => void } } = {}) {
  const base = mkdtempSync(join(tmpdir(), "profcheck-"));
  const home = join(base, "home");
  const root = join(base, "fm");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  const configText = o.rawConfig !== undefined ? o.rawConfig : JSON.stringify({ daemon: { agentProfiles: o.daemon ?? SHIPPED } });
  if (configText !== null) writeFileSync(join(home, "config.json"), configText);
  if (o.snapshot !== null) writeFileSync(join(root, "config", "paseo-profiles.json"), JSON.stringify(o.snapshot ?? SHIPPED));
  if (o.decisions) writeFileSync(join(root, "state", "decisions.md"), o.decisions);
  const logs: string[] = [];
  const check = new ProfileCheck({ paseoHome: home, root: () => root, log: (m) => logs.push(m) });
  const open = (labels: Record<string, string>, metadata: Record<string, unknown>, reason = "create", agentId = ID) =>
    check.onOpen({ agentId, reason, labels, metadata });
  const launch = (config: Launch, labels: Record<string, string>, reason = "create") => {
    const created = check.onCreate({ config: { cwd: "/w", ...config } });
    open(labels, created.metadata, reason);
  };
  const entries = (): any[] => { try { return readFileSync(join(root, "state", "profile-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
  return { home, root, check, open, launch, logs, entries };
}

const refusal = (fn: () => void): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  assert.fail("the launch was allowed");
};

test("a ship on the contributor settings and a scout on the planning settings pass, and nothing is logged", () => {
  const s = setup();
  s.launch(SONNET, SHIP);
  s.launch(SONNET, SCOUT);
  s.launch(OPUS, SCOUT);
  assert.deepEqual(s.entries(), []);
});

test("a ship on fm-planning is refused and told to use fm-contributor", () => {
  const m = refusal(() => setup().launch(OPUS, SHIP));
  assert.match(m, /^Launch refused: .*fm\.shape=ship.*fm-planning is only for planning scouts/);
  assert.match(m, /fm-contributor: provider "claude\/claude-sonnet-5-5", settings \{"modeId":"bypassPermissions","thinkingOptionId":"medium"\}/);
  assert.match(m, /fm-fallback/);
});

test("any setting that differs from every profile is refused, and the message names a launch that would pass", () => {
  const s = setup();
  const bad: Launch[] = [
    OPUS_HIGH,
    { ...SONNET, thinkingOptionId: "low" },
    { ...SONNET, thinkingOptionId: undefined },
    { ...SONNET, modeId: "default" },
    { ...SONNET, model: undefined },
    { ...SONNET, provider: "claude-work" },
  ];
  for (const config of bad) {
    const m = refusal(() => s.launch(config, SCOUT));
    assert.match(m, /^Launch refused: .* matches no firstmate profile/, JSON.stringify(config));
    assert.match(m, /fm-contributor: provider "claude\/claude-sonnet-5-5", settings \{"modeId":"bypassPermissions","thinkingOptionId":"medium"\}/);
    assert.match(m, /fm-planning \(planning scouts only\): provider "claude\/claude-opus-5-5"/);
  }
  assert.match(refusal(() => s.launch(OPUS_HIGH, SCOUT)), /claude\/claude-opus-5-5, thinking high, mode bypassPermissions/);
  assert.ok(!refusal(() => s.launch(OPUS_HIGH, SHIP)).includes("fm-planning (planning scouts only)"), "a ship is never offered the planning profile");
});

test("scope: a parent label alone makes it a crew; captain agents and first mates are exempt", () => {
  const s = setup();
  assert.match(refusal(() => s.launch(OPUS_HIGH, { "paseo.parent-agent-id": "x" })), /Launch refused/);
  assert.match(refusal(() => s.launch(OPUS_HIGH, { "fm.task": "t1" })), /Launch refused/);
  s.launch(OPUS_HIGH, {});
  s.launch(OPUS_HIGH, { canvas: "on" });
  s.launch(OPUS_HIGH, { firstmate: "true", "paseo.parent-agent-id": "x" });
  assert.match(refusal(() => s.launch(OPUS_HIGH, { firstmate: "true", "fm.task": "t1" })), /Launch refused/, "a task label wins over firstmate=true");
});

test("only a first session is checked: resume, refresh, import and a relaunch of a stored agent pass", () => {
  const s = setup();
  for (const reason of ["resume", "refresh", "import"]) s.launch(OPUS_HIGH, SHIP, reason);
  mkdirSync(join(s.home, "agents", "some-cwd"), { recursive: true });
  writeFileSync(join(s.home, "agents", "some-cwd", `${ID}.json`), "{}");
  s.launch(OPUS_HIGH, SHIP);
  assert.deepEqual(s.entries(), []);
});

test("every fm-* daemon profile counts (a captain's own one too); other profiles do not", () => {
  const extra = { id: "fm-extra", name: "x", ...OPUS_HIGH };
  setup({ daemon: [...SHIPPED, extra] }).launch(OPUS_HIGH, SHIP);
  const s = setup({ daemon: [...SHIPPED, { ...extra, id: "my-opus" }] });
  assert.match(refusal(() => s.launch(OPUS_HIGH, SHIP)), /Launch refused/);
});

test("the daemon's profile wins over the repo snapshot", () => {
  const s = setup({ daemon: SHIPPED.map((p) => (p.id === "fm-planning" ? { ...p, thinkingOptionId: "high" } : p)) });
  s.launch(OPUS_HIGH, SCOUT);
  assert.match(refusal(() => s.launch(OPUS, SCOUT)), /Launch refused/);
});

test("a ship passes when a non-planning profile has the same settings as fm-planning", () => {
  setup({ daemon: SHIPPED.map((p) => (p.id === "fm-contributor" ? { ...p, ...OPUS } : p)) }).launch(OPUS, SHIP);
});

test("a profile's options must be set on the launch; extra launch options are fine", () => {
  const opencode = { id: "fm-contributor", name: "c", provider: "opencode", model: "opencode-go/muse", modeId: "build", featureValues: { auto_accept: true } };
  const s = setup({ daemon: [opencode] });
  const base = { provider: "opencode", model: "opencode-go/muse", modeId: "build" };
  s.launch({ ...base, providerOptions: { auto_accept: true, other: 1 } }, SHIP);
  s.launch({ ...base, featureValues: { auto_accept: true } }, SHIP);
  assert.match(refusal(() => s.launch(base, SHIP)), /settings \{"modeId":"build","features":\{"auto_accept":true\}\}/);
  assert.match(refusal(() => s.launch({ ...base, providerOptions: { auto_accept: false } }, SHIP)), /Launch refused/);
  const o = setup({ daemon: [{ ...opencode, featureValues: undefined, options: { auto_accept: true } }] });
  assert.match(refusal(() => o.launch(base, SHIP)), /Launch refused/);
});

test("a daemon with no fm profiles (a remote host) matches provider, model and thinking against the repo snapshot", () => {
  for (const daemon of [[], [{ id: "mine", name: "m", provider: "codex" }]]) {
    const s = setup({ daemon });
    s.launch({ ...SONNET, modeId: "default" }, SHIP);
    assert.match(refusal(() => s.launch(OPUS_HIGH, SCOUT)), /Launch refused/);
    assert.match(refusal(() => s.launch({ ...OPUS, modeId: "default" }, SHIP)), /fm-planning is only for planning scouts/);
  }
  const s = setup({ rawConfig: JSON.stringify({ daemon: {} }) });
  s.launch({ ...SONNET, modeId: undefined }, SHIP);
});

test("fail open: unreadable profiles or a missing stamp let the launch through and are logged", () => {
  for (const rawConfig of [null, "{ half"]) {
    const s = setup({ rawConfig });
    s.launch(OPUS_HIGH, SHIP);
    assert.deepEqual(s.entries().map((e) => [e.decision, e.agentId, e.task]), [["unchecked", ID, "t1"]], String(rawConfig));
    assert.match(s.entries()[0].reason, /could not read/);
  }
  const noSnapshot = setup({ daemon: [], snapshot: null });
  noSnapshot.launch(OPUS_HIGH, SHIP);
  assert.equal(noSnapshot.entries()[0].decision, "unchecked");
  const noStamp = setup();
  noStamp.open(SHIP, {});
  assert.match(noStamp.entries()[0].reason, /no launch settings/);
});

test("fail open: a bug inside the check does not block the launch", () => {
  const s = setup({ daemon: [null] });
  s.launch(OPUS_HIGH, SHIP);
  assert.equal(s.entries()[0].decision, "unchecked");
});

test("`profile-check: off` in decisions.md switches the check off", () => {
  setup({ decisions: "- profile-check: off\n" }).launch(OPUS_HIGH, SHIP);
  assert.match(refusal(() => setup({ decisions: "- profile-check: on\n" }).launch(OPUS_HIGH, SHIP)), /Launch refused/);
});

test("the create hook only adds its stamp: config, env and other metadata are kept", () => {
  const s = setup();
  const request = { config: { cwd: "/w", ...SONNET }, env: { A: "1" }, metadata: { "other-plugin": { x: 1 }, [METADATA_KEY]: { kept: true } } };
  const out = s.check.onCreate(structuredClone(request));
  assert.deepEqual(out.config, request.config);
  assert.deepEqual(out.env, request.env);
  assert.deepEqual(out.metadata["other-plugin"], { x: 1 });
  assert.deepEqual(out.metadata[METADATA_KEY], { kept: true, launch: SONNET });
});

test("each refusal is appended to state/profile-log.jsonl with the agent, task and settings", () => {
  const s = setup();
  refusal(() => s.launch(OPUS_HIGH, SHIP));
  const [e] = s.entries();
  assert.deepEqual([e.decision, e.agentId, e.task, e.shape, e.parent], ["refused", ID, "t1", "ship", "fm"]);
  assert.deepEqual(e.launch, OPUS_HIGH);
  assert.match(e.reason, /^Launch refused/);
  assert.ok(Date.parse(e.at));
  assert.ok(s.logs.some((l) => l.includes("Launch refused")));
});

test("registration: both before-hooks are added, the open hook rejects, and an old daemon is only logged", async () => {
  const s = setup();
  const hooks = new Map<string, (p: any) => Promise<any>>();
  const logs: string[] = [];
  registerProfileCheck({ addHook: ((name: string, h: any) => { hooks.set(name, h); return () => {}; }) as never }, s.check, (m) => logs.push(m));
  assert.deepEqual([...hooks.keys()], ["agent.create.before", "agent.open.before"]);
  const created = await hooks.get("agent.create.before")!({ request: { config: { cwd: "/w", ...OPUS_HIGH } } });
  const request = { agentId: ID, reason: "create", labels: SHIP, metadata: created.metadata };
  await assert.rejects(hooks.get("agent.open.before")!({ request }), /Launch refused/);
  assert.equal(await hooks.get("agent.open.before")!({ request: { ...request, reason: "resume" } }), undefined);
  registerProfileCheck({} as never, s.check, (m) => logs.push(m));
  assert.match(logs.join("\n"), /profile check unavailable/);
});
