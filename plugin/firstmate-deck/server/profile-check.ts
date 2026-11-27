// Every crew launch must come from a firstmate Paseo profile. Paseo records no profile id on an agent (neither create_agent
// nor the CLI takes one), so "from a profile" means "its settings are a profile's settings".
//
// Two daemon hooks, because neither sees everything: `agent.create.before` has the launch settings but no labels, so it stamps
// the settings into the new agent's metadata; `agent.open.before` has the labels and that metadata, and throwing there cancels
// the launch before any session exists. The caller gets `Plugin firstmate-deck agent.open.before failed: <message>`.
//
// Only a deliberate refusal throws: unreadable profiles or a bug here let the launch through (logged `unchecked`).
// `profile-check: off` in state/decisions.md switches it off. Refusals are appended to state/profile-log.jsonl.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PluginServerContext } from "@getpaseo/plugin/server";

export const METADATA_KEY = "firstmate-deck";
const PARENT_LABEL = "paseo.parent-agent-id";
const PLANNING = "fm-planning";

type Options = Record<string, unknown>;

export type Profile = {
  id: string;
  name?: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Options;
  options?: Options;
  [key: string]: unknown;
};

/** The settings of one launch that a profile can be compared with. */
export type Launch = { provider: string; model?: string; modeId?: string; thinkingOptionId?: string; options?: Options };

/** `exact` is false for the repo snapshot used on a daemon with no firstmate profiles: provider, model and thinking only. */
type ProfileSet = { profiles: Profile[]; exact: boolean };

type OpenRequest = { agentId: string; reason: string; labels?: Readonly<Record<string, string>>; metadata?: Readonly<Record<string, unknown>> };

type CreateConfig = {
  provider?: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Options;
  providerOptions?: Options;
};

export type ProfileCheckOptions = { paseoHome: string; root: () => string; log: (m: string) => void; now?: () => number };

function launchOf(config: CreateConfig): Launch {
  const options = { ...config.featureValues, ...config.providerOptions };
  return {
    provider: String(config.provider),
    ...(config.model ? { model: config.model } : {}),
    ...(config.modeId ? { modeId: config.modeId } : {}),
    ...(config.thinkingOptionId ? { thinkingOptionId: config.thinkingOptionId } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
}

const profileOptions = (p: Profile): Options => ({ ...p.featureValues, ...p.options });

function matches(p: Profile, l: Launch, exact: boolean): boolean {
  if (p.provider !== l.provider || (p.model || undefined) !== l.model || (p.thinkingOptionId || undefined) !== l.thinkingOptionId) return false;
  if (!exact) return true;
  // a profile that sets no mode leaves it to the daemon, which fills one in
  if (p.modeId && p.modeId !== l.modeId) return false;
  return Object.entries(profileOptions(p)).every(([k, v]) => isDeepStrictEqual(l.options?.[k], v));
}

const describeLaunch = (l: Launch) =>
  `${l.provider}/${l.model ?? "(default model)"}, thinking ${l.thinkingOptionId ?? "(default)"}, mode ${l.modeId ?? "(default)"}`;

/** The create_agent arguments that launch a profile. */
function howTo(p: Profile): string {
  const features = profileOptions(p);
  const settings = { modeId: p.modeId, thinkingOptionId: p.thinkingOptionId, features: Object.keys(features).length ? features : undefined };
  return `provider "${p.provider}${p.model ? `/${p.model}` : ""}", settings ${JSON.stringify(settings)}`;
}

function replacement(profiles: Profile[], ship: boolean): string {
  const find = (id: string) => profiles.find((p) => p.id === id);
  const offers = [
    ["fm-contributor", "fm-contributor"],
    ...(ship ? [] : [[PLANNING, `${PLANNING} (planning scouts only)`]]),
    ["fm-fallback", "if fm-contributor cannot start, fm-fallback"],
  ].flatMap(([id, label]) => (find(id) ? [`${label}: ${howTo(find(id)!)}`] : []));
  const list = offers.length ? offers : profiles.map((p) => `${p.id}: ${howTo(p)}`);
  return `Relaunch with ${list.join("; ")}. Copy the values from list_profiles (dispatch-routing section 3).`;
}

export class ProfileCheck {
  private o: ProfileCheckOptions;

  constructor(o: ProfileCheckOptions) {
    this.o = o;
  }

  /** `agent.create.before`: remember what is being launched; the labels are only known one hook later. */
  onCreate<R extends { config: object; metadata?: object }>(request: R): R & { metadata: Record<string, any> } {
    const metadata = (request.metadata ?? {}) as Record<string, any>;
    return { ...request, metadata: { ...metadata, [METADATA_KEY]: { ...metadata[METADATA_KEY], launch: launchOf(request.config as CreateConfig) } } };
  }

  /** `agent.open.before`: throws to cancel a crew's first session when its settings are no profile's. */
  onOpen(r: OpenRequest): void {
    const labels = r.labels ?? {};
    const crew = !!labels["fm.task"] || (!!labels[PARENT_LABEL] && labels.firstmate !== "true");
    if (r.reason !== "create" || !crew) return;
    const launch = (r.metadata?.[METADATA_KEY] as { launch?: Launch } | undefined)?.launch;
    let refusal: string | null;
    try {
      if (this.switchedOff() || this.stored(r.agentId)) return;
      if (!launch) throw new Error("no launch settings stamped on the agent");
      refusal = this.judge(launch, labels["fm.shape"] === "ship");
    } catch (e) {
      this.record(r, "unchecked", (e as Error).message, launch);
      return;
    }
    if (!refusal) return;
    this.record(r, "refused", refusal, launch);
    throw new Error(refusal);
  }

  private judge(launch: Launch, ship: boolean): string | null {
    const { profiles, exact } = this.profiles();
    const found = profiles.filter((p) => matches(p, launch, exact));
    if (!found.length) return `Launch refused: ${describeLaunch(launch)} matches no firstmate profile. ${replacement(profiles, ship)}`;
    if (ship && found.every((p) => p.id === PLANNING)) {
      return `Launch refused: this is a ship (fm.shape=ship) on ${describeLaunch(launch)}, and ${PLANNING} is only for planning scouts. ${replacement(profiles, ship)}`;
    }
    return null;
  }

  /** The daemon's `fm-*` profiles, read on every launch; a daemon without any (a remote host) uses the repo snapshot. */
  private profiles(): ProfileSet {
    const fm = (list: Profile[]) => list.filter((p) => p.id.startsWith("fm-"));
    const read = (path: string) => {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        throw new Error(`could not read ${path}: ${(e as Error).message}`);
      }
    };
    const own = fm(read(join(this.o.paseoHome, "config.json"))?.daemon?.agentProfiles ?? []);
    if (own.length) return { profiles: own, exact: true };
    const root = this.o.root();
    if (!root) throw new Error("could not read any firstmate profile: none in the daemon and no first mate checkout");
    const snapshot = fm(read(join(root, "config", "paseo-profiles.json")));
    if (!snapshot.length) throw new Error("could not read any firstmate profile: none in the daemon or the repo snapshot");
    return { profiles: snapshot, exact: false };
  }

  /** A stored record means the agent already exists (a relaunch of one whose provider kept no session). */
  private stored(agentId: string): boolean {
    const dir = join(this.o.paseoHome, "agents");
    try {
      return readdirSync(dir).some((d) => existsSync(join(dir, d, `${agentId}.json`)));
    } catch {
      return false;
    }
  }

  private switchedOff(): boolean {
    const root = this.o.root();
    if (!root) return false;
    try {
      const text = readFileSync(join(root, "state", "decisions.md"), "utf8");
      return /^[ \t]*(?:[-*][ \t]+)?[*`_]*profile-check[*`_]*[ \t]*:[*`_]*[ \t]*off[*`_]*[ \t]*$/im.test(text);
    } catch {
      return false;
    }
  }

  private record(r: OpenRequest, decision: "refused" | "unchecked", reason: string, launch: Launch | undefined): void {
    this.o.log(`profile check ${decision} agent ${r.agentId}: ${reason}`);
    const root = this.o.root();
    if (!root) return;
    const entry = {
      at: new Date((this.o.now ?? Date.now)()).toISOString(), decision, agentId: r.agentId,
      task: r.labels?.["fm.task"] ?? null, shape: r.labels?.["fm.shape"] ?? null, parent: r.labels?.[PARENT_LABEL] ?? null,
      launch: launch ?? null, reason,
    };
    try {
      mkdirSync(join(root, "state"), { recursive: true });
      appendFileSync(join(root, "state", "profile-log.jsonl"), JSON.stringify(entry) + "\n");
    } catch (e) {
      this.o.log(`profile-log write failed: ${e}`);
    }
  }
}

export function registerProfileCheck(server: Pick<PluginServerContext, "addHook">, check: ProfileCheck, log: (m: string) => void): void {
  if (typeof server.addHook !== "function") return log("profile check unavailable: this Paseo cannot veto a launch (no addHook)");
  server.addHook("agent.create.before", async ({ request }) => check.onCreate(request));
  server.addHook("agent.open.before", async ({ request }) => check.onOpen(request));
}
