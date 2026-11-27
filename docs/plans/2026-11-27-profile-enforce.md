# Profile Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The deck plugin refuses a crew launch that does not match a firstmate Paseo profile, in the daemon, whatever harness the launcher runs on.

**Architecture:** Two Paseo before-hooks in `plugin/firstmate-deck`. `agent.create.before` sees the launch config but no labels, so it stamps the config into the new agent's metadata. `agent.open.before` (reason `create`) sees labels and that metadata, decides, and throws to cancel the launch.

**Tech Stack:** TypeScript (Node type stripping), `@getpaseo/plugin` 0.15.3 types, daemon 0.17.4, `node --test`.

**Spec:** the "Design" section below.

## Design

**Why:** crews were launched by hand on Opus high, including ships. The check has to live in Paseo, since a first mate may run on any harness.

**Evidence (Paseo 0.17.4 source):**

- `@getpaseo/plugin/dist/server/lifecycle.d.ts`: `agent.create.before` and `agent.open.before` are request hooks marked `waits: true`.
- `@getpaseo/server/dist/server/server/plugins/runtime.js` `before()`: a throwing hook rethrows as `Plugin <id> <hook> failed: <message>`.
- `agent/agent-manager.js` `createAgentInternal`: both hooks run before `client.createSession` and `registerSession`, so a refusal leaves no agent.
- The create hook payload is `{config, env, metadata}`: no labels, no agent id. The open hook payload has `labels`, `metadata`, `reason`, `agentId`, but no model.
- No profile id exists in `create_agent_request`, the MCP tool, `paseo run`, or the stored agent. Only the settings are observable.

**Approaches:**

1. Refuse in the before-hooks (chosen). No agent is created, no tokens are spent, the launcher gets the reason as its tool error, so no flag or wake is needed.
2. Flag after creation on the card and wake the parent. Only needed if no veto existed; the crew would already be running.
3. Rewrite the launch config to the profile in the create hook. Silent, and the hook cannot see the labels there.

**Rules:**

- Checked: agents with an `fm.task` or `paseo.parent-agent-id` label, on their first session only. Exempt: `firstmate=true` with no `fm.task`; agents with neither label.
- Allowed profiles: every daemon profile whose id starts `fm-`. A captain override of the model is therefore a temporary `fm-<name>` profile made in Paseo.
- Match on a daemon with `fm-*` profiles: provider, model, mode, thinking level, and every option the profile declares.
- Match on a daemon with none (a remote host): provider, model, thinking level, against `config/paseo-profiles.json` of the first mate checkout.
- `fm.shape=ship` whose only matching profile is `fm-planning`: refused.
- Fail open, with a log line, when the profiles cannot be read, the stamp is missing, or the check itself throws. Only a deliberate refusal blocks a launch.
- `profile-check: off` in `state/decisions.md` switches the check off.
- Refusals and fail-open launches are appended to `state/profile-log.jsonl`.

**Non-goals:** agents whose settings are changed after launch, re-tasked agents, imported sessions, daemons that do not run the plugin, detecting whether `fm-contributor` really failed before `fm-fallback`.

## Global Constraints

- No new runtime dependency. Server files use `.ts` import specifiers and no TypeScript-only runtime syntax (no parameter properties, no enums).
- Scratch and `TMPDIR` under `/home/mrigank/.i-t/fm-profile-enforce`, never `/tmp`.
- No push, merge, `bin/page install` or plugin reload against the live daemon.
- Soft-wrapped Markdown.

## Review Focus

- A relaunch of an already-existing agent (stored record, no provider session) must not be refused.
- An unreadable or half-written daemon `config.json` must not block launches.
- A plugin bug inside the check must not block launches.
- Another plugin's metadata on the agent must survive the stamp.
- A refusal message must name a launch that would pass: provider, model and every setting.

---

### Task 1: The check

**Files:**
- Create: `plugin/firstmate-deck/server/profile-check.ts`
- Test: `plugin/firstmate-deck/test/profile-check.test.ts`

**Interfaces:**
- Produces: `class ProfileCheck { constructor(o: { paseoHome: string; root: () => string; log: (m: string) => void; now?: () => number }); onCreate(request): request & { metadata }; onOpen(request): void }`, `METADATA_KEY = "firstmate-deck"`.
- `onOpen` throws `Error` whose message starts `Launch refused:` and nothing else.

- [ ] **Step 1: Write the failing tests** (temp daemon home with `config.json`, temp root; each test runs `onCreate` then `onOpen`):

| Test | Expect |
| --- | --- |
| contributor settings, ship | passes |
| planning settings, scout | passes |
| planning settings, ship | throws, names `fm-contributor` and `fm-planning` |
| Opus high; Sonnet low; no thinking; wrong mode; other provider | throws, names the replacement provider and settings |
| parent label only, Opus high | throws |
| no `fm.task`, no parent; `firstmate=true` with parent and no `fm.task` | passes |
| `firstmate=true` with `fm.task`, Opus high | throws |
| reason `resume` / `refresh` / `import` | passes |
| reason `create` with an existing `agents/*/<id>.json` | passes |
| a hand-made `fm-extra` daemon profile | passes; a non-`fm` profile does not |
| profile with `featureValues` | needs the option (from `providerOptions` or `featureValues`); extra launch options are fine |
| daemon with no `fm-*` profiles | snapshot match ignores mode; Opus high still throws |
| config unreadable and no snapshot; missing stamp | passes, logged `unchecked` |
| `profile-check: off` | passes |
| stamp | keeps other metadata keys, does not change `config` or `env` |
| log | one `refused` line per refusal with agent id, task, launch |

- [ ] **Step 2:** `node --test test/profile-check.test.ts` fails (module missing).
- [ ] **Step 3:** Implement. Read profiles from `<paseoHome>/config.json` `daemon.agentProfiles` on every launch.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `Deck: refuse crew launches that skip a firstmate profile`.

### Task 2: Register the hooks

**Files:**
- Modify: `plugin/firstmate-deck/index.server.ts`
- Test: `plugin/firstmate-deck/test/profile-check.test.ts`

**Interfaces:**
- Produces: `registerProfileCheck(server: Pick<PluginServerContext, "addHook">, check: ProfileCheck, log)` in `profile-check.ts`, called from `contribute`. On a daemon without `addHook` it logs that enforcement is unavailable and registers nothing.

- [ ] **Step 1:** Failing test: a fake server records both hook names; its handlers refuse an Opus-high crew end to end; a fake without `addHook` logs and does not throw.
- [ ] **Step 2:** Run, fails. **Step 3:** Implement. **Step 4:** Passes, `npm run typecheck` clean.
- [ ] **Step 5:** Commit `Deck: register the profile check hooks`.

### Task 3: Docs

**Files:** `.claude/skills/dispatch-routing/SKILL.md` (section 1 override, section 3), `.claude/skills/task-tree/SKILL.md` (second mate launch), `docs/PROFILES.md`, `docs/ISOLATED.md` (demo launch command), `plugin/firstmate-deck/OVERVIEW.md`.

- [ ] State the refusal, remove the raw-spec override, make every launch instruction use a profile. Commit `Docs: crew launches must use a firstmate profile`.

### Task 4: Verify

- [ ] Full per-file suite on the branch, compared with main's baseline: no new failure.
- [ ] Isolated daemon demo on `~/.paseo-fm-v2`: one refused and one accepted launch through the real daemon, and a check that a refused launch leaves no agent.
