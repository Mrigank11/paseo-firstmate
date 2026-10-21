import type { PluginServerContext } from "@getpaseo/plugin/server";
import { COMMENT_ROW_KIND, COMMENT_ROW_VERSION, deckSettings, summaryRpc } from "./shared/contract.ts";
import { resolveConfig, type SettingsValues } from "./server/config.ts";
import { detectHome, makeExec } from "./server/paseo-cli.ts";
import { Deck } from "./server/runtime.ts";

const AGENT_EVENTS = [
  "agent.turn_started",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.archived",
  "agent.closed",
] as const;

export default function contribute(server: PluginServerContext) {
  const log = (m: string) => console.log(`[firstmate-deck] ${m}`);
  const home = detectHome();
  log(`starting (pid ${process.pid}, daemon home ${home ?? "default"})`);

  // The SDK handle only reaches hooks and RPC handlers; keep the latest one for the timeline rows.
  let paseoRef: any = null;
  const grab = (ctx: { paseo?: unknown }) => { if (ctx?.paseo) paseoRef = ctx.paseo; };

  const settings = server.registerSettings(deckSettings);
  const deck = new Deck({
    exec: makeExec(home),
    home,
    log,
    readConfig: async () => {
      const st = await settings.read();
      const v: SettingsValues = st.status === "ready" ? st.values : {};
      if (st.status !== "ready") log(`settings invalid (${st.error}); using environment`);
      return resolveConfig(v, process.env);
    },
    timelineRow: async (agentId, id, data) => {
      if (!paseoRef) { log("timeline row skipped: no SDK handle yet (none of the hooks or RPCs has fired)"); return; }
      await paseoRef.agents.ref(agentId).timeline.append({ type: "plugin", id, kind: COMMENT_ROW_KIND, version: COMMENT_ROW_VERSION, data });
      log(`timeline row ${id} appended to ${agentId}`);
    },
  });
  deck.start().catch((e) => log(`start failed: ${e?.stack ?? e}`));
  const unsub = settings.subscribe(() => void deck.configure().catch((e) => log(`reconfigure failed: ${e}`)));

  server.handle(summaryRpc, async (input, ctx) => {
    grab(ctx);
    return deck.summary(input.project);
  });

  for (const name of AGENT_EVENTS) {
    server.on(name, (event, ctx) => {
      grab(ctx);
      deck.onAgentEvent(event.agent.id);
    });
  }
  server.on("agent.created", (_e, ctx) => grab(ctx));
  server.on("workspace.created", (_e, ctx) => grab(ctx));

  return async () => {
    log("cleanup");
    unsub();
    deck.stop();
  };
}
