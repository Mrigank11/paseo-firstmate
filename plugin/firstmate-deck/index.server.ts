import type { PluginServerContext } from "@getpaseo/plugin/server";
import { deckSettings, summaryRpc } from "./shared/contract.ts";
import { resolveConfig, type SettingsValues } from "./server/config.ts";
import { CliPort, detectHome, makeExec } from "./server/paseo-cli.ts";
import { PortSelector } from "./server/paseo-port.ts";
import { Deck } from "./server/runtime.ts";

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
    log,
    readConfig: async () => {
      const st = await settings.read();
      const v: SettingsValues = st.status === "ready" ? st.values : {};
      if (st.status !== "ready") log(`settings invalid (${st.error}); using environment`);
      return resolveConfig(v, process.env);
    },
  });
  deck.start().catch((e) => log(`start failed: ${e?.stack ?? e}`));
  const unsub = settings.subscribe(() => void deck.configure().catch((e) => log(`reconfigure failed: ${e}`)));

  server.handle(summaryRpc, async (input, ctx) => {
    ports.capture(ctx, "rpc summary");
    return deck.summary(input.project);
  });

  for (const name of AGENT_EVENTS) {
    server.on(name, (event, ctx) => {
      ports.capture(ctx, `hook ${name}`);
      deck.onAgentEvent(event.agent.id);
    });
  }
  // no pill depends on these, but any callback can be the first to carry a handle
  server.on("agent.created", (_e, ctx) => ports.capture(ctx, "hook agent.created"));
  server.on("workspace.created", (_e, ctx) => ports.capture(ctx, "hook workspace.created"));
  server.on("workspace.archived", (_e, ctx) => ports.capture(ctx, "hook workspace.archived"));

  return async () => {
    log("cleanup");
    unsub();
    deck.stop();
  };
}
