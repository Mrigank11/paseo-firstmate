// One agent lifecycle event, from a daemon hook (this host) or from remote-events (another one), to everything that cares.
import type { Enforcer } from "./enforcer.ts";
import type { Gate, HookAgent } from "./gate.ts";
import type { Permission } from "./permission.ts";
import type { Deck } from "./runtime.ts";

export type Dispatched = {
  deck: Pick<Deck, "onTurnStarted" | "onAgentEvent">;
  gate: Pick<Gate, "onTurnEnded" | "onClosed">;
  enforcer: Pick<Enforcer, "onTurnEnded">;
  permission: Pick<Permission, "onRequested">;
};

export const dispatcher = (to: Dispatched) => (name: string, event: unknown): void => {
  const { agent, startedAt } = event as { agent: HookAgent; startedAt?: string };
  // another host's turn may have started well before we saw it, so its own start time counts
  if (name === "agent.turn_started") to.deck.onTurnStarted(agent.id, agent.serverId ? startedAt : undefined);
  to.deck.onAgentEvent(agent.id, agent.serverId);
  if (name === "agent.turn_ended") { void to.gate.onTurnEnded(event as never); to.enforcer.onTurnEnded(agent.id); }
  if (name === "agent.permission_requested") void to.permission.onRequested(event as never);
  if (name === "agent.closed") void to.gate.onClosed(event as never);
};
