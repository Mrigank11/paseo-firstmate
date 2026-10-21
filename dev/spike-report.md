# Paseo plugin feasibility spike (daemon 0.12.0, sandbox ~/.paseo-deck)

Spike plugin: `/home/mrigank/projects/llm-exp/paseo-firstmate-deck/plugin/spike/` (installed and running on the sandbox). Live daemon untouched.

## Verdicts

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1a | Child process alive 10+ min | YES | `npx -y lavish-axi poll ...` spawned from `contribute()`, alive 10:27 at the check (08:01:33 to 08:12:00), 30 s heartbeat log `/tmp/spike-heartbeat.log` never missed. No timeout killed it. |
| 1b | Timeouts | NO timeout on `contribute()` background work | The 30 s limit applies to hook callbacks only. `setInterval` in the entry ran for the whole life of the plugin process. |
| 1c | `node:child_process` / `node:fs` | YES | Both work. Needs `@types/node` devDependency + `"node"` in tsconfig `types`, else typecheck fails. SDK also exports `spawnProcess`, `execCommand`, `terminateProcess` from `@getpaseo/plugin/server`. |
| 1d | Cleanup on reload / disable / daemon stop | YES | Returned cleanup function was called on `plugin reload`, `plugin disable` and `daemon stop` (`cleanup.called` in events log). `child.kill("SIGTERM")` on the `npm exec` wrapper also took down the grandchild node process (no orphans). Without cleanup (kill -9 of the plugin) the child is ORPHANED (ppid 1) and keeps running. |
| 1e | Plugin restarts after `sandbox.sh restart-daemon` | YES | Plugin status `running` again, new plugin pid, `contribute()` re-ran, child re-spawned. |
| 1f | Kill the plugin process | NOT auto-restarted | `kill -9 <plugin pid>` -> status `failed`, error `Plugin process exited: spike`; still failed 18 s later. Recovery needs `paseo plugin reload spike` or a daemon restart. Child was orphaned. |
| 2 | Events | YES | `agent.created`, `agent.turn_started`, `agent.turn_ended`, `agent.permission_requested`, `agent.archived`, `agent.closed` all landed in `/tmp/spike-events.jsonl` (sample copy in `spike-shots/events.sample.jsonl`). |
| 3 | `send()` | YES | `paseo.agents.ref(id).send(text, opts?)`. Idle agent: starts a new turn (`foreground-turn-2`). Running agent: default = INTERRUPTS (old turn ends `canceled/"Interrupted"`, new turn starts); `{activeTurnBehavior:"steer"}` = steered into the running turn (no new foreground turn; message honoured, agent replied STEERED). Not rejected in either case. |
| 4 | Find by label | YES | `paseo.agents.list({ filter: { labels: { firstmate: "true" } } })` -> `{entries:[{agent:{id,labels,status,...}, project}]}`. CLI: `paseo run --label firstmate=true`. |
| 5 | Server timeline row | YES | `paseo.agents.ref(id).timeline.append({type:"plugin",id,kind,version:1,data})` -> `{seq, epoch}`. Row rendered in the web UI. 0.12.0 daemon bundle contains `pluginTimelineItems: true`. |
| 6 | Client UI | YES | Sidebar header item, workspace panel (new-tab menu), timeline renderer all render in the web UI. Screenshots below. |
| 7 | Settings + RPC | YES (RPC full, settings read) | `defineRpc` + `server.handle` + `useRpc` round trip worked from the panel (returned server pid and child pid). `registerSettings` + `useSettings` read worked (defaults, revision `"missing"`); server `settings.read()` worked. `save()` was not exercised. |

## Working code

Server (`index.server.ts`):

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { spawn } from "node:child_process";
import { appendFileSync, openSync } from "node:fs";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(prefs);          // prefs = defineSettings({id,scope:"host",version:1,schema})
  server.handle(pingRpc, async (input, { paseo }) => ({ ... }));   // handler gets { paseo }

  server.on("agent.turn_ended", (event, { paseo, signal }) => { /* event.agent, event.turnId, event.outcome, event.timeline */ });
  // events: agent.created | closed | turn_started | turn_ended | permission_requested | permission_resolved | archived

  const out = openSync("/tmp/x.log", "a");
  const child = spawn("npx", ["-y","lavish-axi","poll","/tmp/spike-page.html","--owner","spike"],
    { env: { ...process.env, LAVISH_AXI_PORT: "4390", LAVISH_AXI_STATE_DIR: "..." }, stdio: ["ignore", out, out] });

  return async () => { child.kill("SIGTERM"); };            // cleanup runs on reload/disable/daemon stop
}
```

SDK calls (all via `paseo: PaseoApi`, only available inside hook/handler callbacks):

```ts
await paseo.agents.ref(id).send("text", { activeTurnBehavior: "steer" /* default: interrupt */ });
const r = await paseo.agents.list({ filter: { labels: { firstmate: "true" } } });   // r.entries[i].agent.id
await paseo.agents.ref(id).timeline.append({ type: "plugin", id: "row-1", kind: "spike-card", version: 1, data: { text: "..." } });
const h = paseo.agents.ref(id); await h.refresh(); h.status; h.activeTurn;
await paseo.agents.create({ config: { provider: "claude/claude-sonnet-5-5" }, cwd, labels: {..}, prompt });  // from SDK types
await paseo.agents.ref(id).respondToPermission({ requestId, response: { behavior: "allow" } });
```

Client (`index.client.tsx`):

```tsx
client.addSidebarHeaderItem({ id: "spike", title: "Spike", Component: SpikeItem });     // SidebarRow from "@getpaseo/plugin/client/ui"
client.addWorkspacePanel({ id: "spike", title: "Spike", icon: "FlaskConical", context: "workspace", Component: SpikePanel });
client.addTimelineRenderer({ kind: "spike-card", version: 1, schema: cardSchema, Component: SpikeCard });
// in components: useRpc(pingRpc), useSettings(prefs), theme.colors.* from props, View/Text from react-native
```

Hook payload shapes: `PluginHookAgent = {id, workspaceId, parentAgentId, provider, cwd, title}` (NO labels: to read labels, call `agents.list` / `ref(id).refresh()`). `turnId` looks like `foreground-turn-N` or `autonomous-turn-N` (background work finishing, e.g. a backgrounded shell command, starts an autonomous turn). Outcome `{kind:"completed"|"failed"|"canceled", ...}`.

## Gotchas

- `paseo` handle is only given to hooks and RPC handlers, not to `contribute(server)`. To use it from a background loop, capture `context.paseo` from the first hook/RPC (the spike did this via `server.on("agent.created"|"agent.turn_started"|"workspace.created")`). Nothing fires at startup, so the loop idles until the first event or RPC. Alternative: the child's own process can talk to the daemon via the `paseo` CLI / `@getpaseo/client`.
- Typecheck: scaffold lacks Node types. `npm i -D @types/node` and add `"node"` to `tsconfig.json` `types`. `server/` and `shared/` dirs are mandatory for non-entry modules.
- The plugin runs in its own Node subprocess (`.../@getpaseo/server/dist/server/server/plugins/plugin-process.js`), child of the daemon; `process.pid` != daemon pid.
- No hot reload: `paseo plugin reload spike --home ~/.paseo-deck` after edits. zsh does not word-split `$H`: pass `--home` literally.
- `paseo plugin disable/enable/reload/ls/logs` all accept `--home`. Plugin logs (`paseo plugin logs spike`) only show lifecycle lines plus stdout/stderr; the daemon log is `~/.paseo-deck/daemon.log`.
- Kill -9 of the plugin leaves status `failed` and no auto-restart; orphaned child must be killed by hand. A supervising design needs either a pid file (kill stale child on start) or a detached process owning its own lifecycle.
- `addSidebarHeaderItem` row calling `openScreen({screenId})` for an unregistered screen does nothing visible (the spike registered no screen).
- Opening a workspace URL directly (`/h/<serverId>/workspace/<wid>`) in a fresh headless browser redirected to `/open-project`; navigate by clicking sidebar rows instead.
- Lavish poll child: not tested with actual human feedback delivery (no browser comment was posted), so exit-on-feedback and re-poll semantics are unverified here. `lavish-axi poll` prints a "Poll interrupted" notice on SIGTERM and exits 143.
- `ps -ef | grep` was unreliable in this shell (rtk hook); use `pgrep -af` and `ps -p`.

## Web UI access

`http://100.101.33.17:6777` serves the app from the daemon; same-origin, it connects to the daemon automatically with no pairing or login (relay is disabled in sandbox config). Headless branded Chrome worked: `/opt/google/chrome/chrome` via playwright-core with `--headless=new --no-sandbox`, `XDG_CONFIG_HOME=/tmp/spike-xdg`. Script copy: `spike-shots/shot.mjs.txt`. Human: just open the URL, click a workspace, press `+` in the tab bar and choose Spike.

## Screenshots (`/home/mrigank/projects/llm-exp/paseo-firstmate-deck/dev/spike-shots/`)

- `01-landing.png`: sidebar with the "Spike" header item (flask icon).
- `05-timeline-card.png`: green-bordered "SPIKE CARD: server row" appended by the server.
- `06-newtab-menu.png`: new-tab menu listing the Spike workspace panel.
- `07-workspace-panel.png`: panel showing RPC result (`pluginPid`, `childPid`) and settings default.
- `04-agent-tab-late-scroll.png`: agent tab, shows interrupt-test result.

## Recommendation

The plugin CAN own the Lavish poll for the lifetime of the daemon: the child survives 10+ minutes, the cleanup hook reliably kills it on reload, disable and daemon stop, and the plugin restarts with the daemon. The weak spot is an ungraceful plugin death (crash, kill -9, OOM): the plugin is not restarted automatically and the child is orphaned. Recommended design: the plugin owns the poll but writes a pid file and, on start, kills any stale child from the pid file before spawning; it should also run a re-spawn loop (the poll exits whenever feedback is delivered, so a supervisor loop is needed regardless). If unattended recovery after plugin crashes matters, move the poll into a separate detached process (systemd user unit) that talks to the daemon with the `paseo` CLI, and keep the plugin for UI and hooks only. For the demo, plugin-owned is fine.
