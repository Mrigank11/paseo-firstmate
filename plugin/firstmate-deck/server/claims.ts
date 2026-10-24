// Who `bin/page claim` recorded as first mate. Dependency-free: bin/page runs it without the plugin's packages installed.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const agentIdIn = (file: string): string | null => {
  try {
    const id = JSON.parse(readFileSync(file, "utf8"))?.agentId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
};

/** The agent `bin/page claim` recorded in state/firstmate.json: the checkout-wide first mate, the fallback for every project without a claim of its own. */
export function claimedId(root: string): string | null {
  return agentIdIn(join(root, "state", "firstmate.json"));
}

/** The agent `bin/page claim <project>` recorded in state/projects/<project>/claim.json: that page's own first mate. */
export function projectClaimedId(root: string, project: string): string | null {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(project)) return null;
  return agentIdIn(join(root, "state", "projects", project, "claim.json"));
}
