// Which agents on another Paseo host are this daemon's. agent-canvas applies the same rule. An agent there is ours only when
//   - its label paseo.parent-server-id is this daemon's own server id (this daemon started it), or
//   - its label canvas.relay is exactly the id of a live (not archived) agent on this daemon.
// Everything else on another host is someone else's, whatever its fm.* labels say: never listed, stored, read, sent to,
// answered or relabelled. A crew shown to be ours once stays ours: its record in state/remote-agents.json carries `owner`,
// the server id it was shown to belong to. Dependency-free (bin/fleet runs it without installing the plugin).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PARENT_SERVER_LABEL = "paseo.parent-server-id";
export const RELAY_LABEL = "canvas.relay";

export type Self = {
  /** This daemon's server id; "" when it cannot be told. */
  serverId: string;
  /** Is `id` exactly a live agent on this daemon? Rejects when that cannot be told. */
  isLocal: (id: string) => Promise<boolean>;
};

/** Do the labels show the agent to be ours? A failed local lookup claims nothing. */
export async function claims(labels: Record<string, string> | undefined, self: Self): Promise<boolean> {
  if (self.serverId && labels?.[PARENT_SERVER_LABEL] === self.serverId) return true;
  const relay = labels?.[RELAY_LABEL];
  if (!relay) return false;
  try { return await self.isLocal(relay); }
  catch { return false; }
}

/** Does a stored record count for the daemon `serverId` ("" when unknown)? */
export const ownedBy = (record: { owner?: unknown }, serverId: string): boolean =>
  typeof record.owner === "string" && (!record.owner || !serverId || record.owner === serverId);

/** The server id of the daemon whose home is `home` (default: PASEO_HOME, else ~/.paseo); "" when unreadable. */
export function daemonServerId(home: string | undefined = process.env.PASEO_HOME): string {
  try { return readFileSync(join(home || join(homedir(), ".paseo"), "server-id"), "utf8").trim(); }
  catch { return ""; }
}
