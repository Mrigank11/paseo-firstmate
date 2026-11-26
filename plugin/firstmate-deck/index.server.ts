import type { PluginServerContext } from "@getpaseo/plugin/server";
import { deckSettings, summaryRpc } from "./shared/contract.ts";
import { resolveConfig, type SettingsValues } from "./server/config.ts";
import { CliPort, detectHome, makeExec } from "./server/paseo-cli.ts";
import { PortSelector } from "./server/paseo-port.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { Deck } from "./server/runtime.ts";
import { Gate } from "./server/gate.ts";
import { fetchSummary } from "./server/canvas-port.ts";
import { Permission } from "./server/permission.ts";
import { Enforcer } from "./server/enforcer.ts";

const AGENT_EVENTS = [
  "agent.turn_started",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
  "agent.closed",
] as const;

export default function contribute(server: PluginServerContext) {
  const log = (m: string) => console.log(`[firstmate-deck] ${m}`);
  const home = detectHome();
  log(`starting (pid ${process.pid}, daemon home ${home ?? "default"})`);

  // The SDK handle only reaches hooks and RPC handlers (never contribute()): every one of them hands it to the
  // selector, which switches the deck from the CLI to the SDK as soon as the first one arrives.
  const exec = makeExec(home);
  const ports = new PortSelector(new CliPort(exec), log);

  const settings = server.registerSettings(deckSettings);
  const deck = new Deck({
    exec,
    ports,
    home,
    extraBanner: (): string | null => permission.problem(),
    agentsDir: join(home ?? join(homedir(), ".paseo"), "agents"),
    log,
    readConfig: async () => {
      const st = await settings.read();
      const v: SettingsValues = st.status === "ready" ? st.values : {};
      if (st.status !== "ready") log(`settings invalid (${st.error}); using environment`);
      return resolveConfig(v, process.env);
    },
  });
  // The finish gate: audits every crew turn end (state/gate-log.jsonl) and, behind `notify: plugin`, wakes the first mate.
  const gate = new Gate({ ports, root: () => deck.root(), firstmateLabel: () => deck.firstmateLabel(), canvas: (id) => fetchSummary(deck.canvasUrl(), id), log });
  gate.start();
  const deckFirstHandle = ports.onFirstHandle;
  ports.onFirstHandle = () => {
    deckFirstHandle?.();
    void gate.sweep().catch((e) => log(`gate sweep failed: ${e}`));
  };
  // The enforcer: an idle first mate that still owns tasks is re-woken (twice at most per item), then the task shows as "first mate stalled".
  // Timings can be shortened through the daemon's environment (the isolated demo does).
  const num = (v: string | undefined) => (v && Number(v) > 0 ? Number(v) : undefined);
  const enforcer = new Enforcer({
    ports, root: () => deck.root(), snapshot: () => deck.snapshot(), log,
    settleMs: num(process.env.FM_ENFORCER_SETTLE_MS), gapMs: num(process.env.FM_ENFORCER_GAP_MS), syncMs: num(process.env.FM_ENFORCER_SYNC_MS),
    onChange: (crews, stalled) => deck.setEnforcement(crews, stalled),
  });
  deck.onStages((snap) => enforcer.onStages(snap));
  const enforcerTick = setInterval(() => enforcer.tick(), num(process.env.FM_ENFORCER_TICK_MS) ?? 30_000);
  enforcerTick.unref?.();
  // The permission hook: classifies crew permission requests against state/decisions.md (shadow: log only; enforce: auto-allow the safe ones).
  const permission = new Permission({ ports, root: (): string => deck.root(), paseoHome: home ?? join(homedir(), ".paseo"), log });
  deck.start().catch((e) => log(`start failed: ${e?.stack ?? e}`));
  const unsub = settings.subscribe(() => void deck.configure().catch((e) => log(`reconfigure failed: ${e}`)));

  server.handle(summaryRpc, async (input, ctx) => {
    ports.capture(ctx, "rpc summary");
    return deck.summary(input.project);
  });

  for (const name of AGENT_EVENTS) {
    server.on(name, (event, ctx) => {
      ports.capture(ctx, `hook ${name}`);
      if (name === "agent.turn_started") deck.onTurnStarted(event.agent.id);
      deck.onAgentEvent(event.agent.id);
      if (name === "agent.turn_ended") { void gate.onTurnEnded(event as never); enforcer.onTurnEnded(event.agent.id); }
      if (name === "agent.permission_requested") void permission.onRequested(event as never);
      if (name === "agent.closed") void gate.onClosed(event as never);
    });
  }
  // no pill depends on these, but any callback can be the first to carry a handle
  server.on("agent.created", (_e, ctx) => ports.capture(ctx, "hook agent.created"));
  server.on("workspace.created", (_e, ctx) => ports.capture(ctx, "hook workspace.created"));
  server.on("workspace.archived", (_e, ctx) => ports.capture(ctx, "hook workspace.archived"));

  return async () => {
    log("cleanup");
    unsub();
    gate.stop();
    clearInterval(enforcerTick);
    enforcer.stop();
    deck.stop();
  };
}
