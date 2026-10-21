#!/usr/bin/env bash
# dev/demo-setup.sh — everything deterministic before the firstmate-deck demo, in one idempotent run:
#   1. sandbox daemon up (dev/sandbox.sh up), with FIRSTMATE_ROOT exported to the plugin
#   2. a throwaway demo project repo (deck-demo), if missing
#   3. the sandbox first mate's state/: decisions.md (demo lanes) and state/page.env
#   4. the firstmate-deck plugin installed (or reloaded) on the sandbox daemon
#   5. the sandbox first mate launched with label firstmate=true (unless one is already live)
# Prints the web UI URL and the first mate's agent id. Never touches ~/.paseo.
#
#   dev/demo-setup.sh            set everything up
#   dev/demo-setup.sh --no-agent skip step 5 (for e2e runs that bring their own first mate)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/dev/sandbox.env"
H="$PASEO_HOME"
DEMO="${DECK_DEMO_DIR:-$HOME/projects/llm-exp/deck-demo}"
FM_MODEL="${DECK_FM_MODEL:-claude-work/claude-sonnet-5-5}"
PLUGIN="$ROOT/plugin/firstmate-deck"
step() { printf '\n== %s\n' "$*"; }

step "sandbox daemon"
"$ROOT/dev/sandbox.sh" up

step "demo project at $DEMO"
if [[ ! -d "$DEMO/.git" ]]; then
  mkdir -p "$DEMO"
  cat >"$DEMO/package.json" <<'JSON'
{ "name": "deck-demo", "private": true, "type": "module",
  "scripts": { "start": "node server.js", "test": "node --test" } }
JSON
  cat >"$DEMO/server.js" <<'JS'
import { createServer } from "node:http";
const items = [{ id: 1, name: "first" }, { id: 2, name: "second" }];
createServer((req, res) => {
  if (req.url === "/items") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(items)); return; }
  res.statusCode = 404; res.end("not found");
}).listen(process.env.PORT ?? 4500);
JS
  printf '# deck-demo\n\nA tiny HTTP server used to demo first-mate project pages.\n' >"$DEMO/README.md"
  git -C "$DEMO" init -q -b main && git -C "$DEMO" add -A && git -C "$DEMO" commit -q -m "deck-demo: initial"
  echo "created"
else
  echo "exists"
fi

step "sandbox first-mate state"
mkdir -p "$ROOT/state"
if [[ ! -f "$ROOT/state/decisions.md" ]]; then
  sed -e "s#^- \`planning\` .*#- \`planning\`    — \`$FM_MODEL\` · \`bypassPermissions\` · thinking \`medium\`#" \
      "$ROOT/state/decisions.example.md" >"$ROOT/state/decisions.md"
  printf '\n## Demo\n\n- This is the firstmate-deck SANDBOX. Every Paseo call goes to the sandbox daemon on :6777.\n- Delivery mode for deck-demo: `local-only` (no pushes, no PRs).\n' >>"$ROOT/state/decisions.md"
fi
[[ -f "$ROOT/state/fleet.json" ]] || echo '{"tasks":[]}' >"$ROOT/state/fleet.json"
cat >"$ROOT/state/page.env" <<ENV
export LAVISH_AXI_PORT=$LAVISH_AXI_PORT
export LAVISH_AXI_STATE_DIR=$LAVISH_AXI_STATE_DIR
export PASEO_HOME=$PASEO_HOME
ENV
echo "decisions.md, fleet.json, page.env ready"

step "firstmate-deck plugin"
if paseo plugin ls --home "$H" --json 2>/dev/null | jq -e '.[] | select(.id == "firstmate-deck")' >/dev/null; then
  paseo plugin reload firstmate-deck --home "$H" | tail -1
else
  paseo plugin install "$PLUGIN" --home "$H" | tail -1
fi
for _ in $(seq 1 30); do
  st="$(paseo plugin ls --home "$H" --json 2>/dev/null | jq -r '.[] | select(.id == "firstmate-deck") | .status')"
  [[ "$st" == running ]] && break; sleep 1
done
echo "plugin: ${st:-missing}"
[[ "${st:-}" == running ]] || { paseo plugin logs firstmate-deck --home "$H" | tail -20; exit 1; }

if [[ "${1:-}" == "--no-agent" ]]; then exit 0; fi

step "sandbox first mate"
fm="$(paseo ls --home "$H" --label firstmate=true --json 2>/dev/null | jq -r '.[0].id // empty')"
if [[ -z "$fm" ]]; then
  fm="$(paseo run --home "$H" --no-wait --json --cwd "$ROOT" --title "first mate (sandbox)" \
        --label firstmate=true --provider "$FM_MODEL" --thinking medium --mode bypassPermissions \
        --env "PASEO_HOME=$PASEO_HOME" --env "LAVISH_AXI_PORT=$LAVISH_AXI_PORT" --env "LAVISH_AXI_STATE_DIR=$LAVISH_AXI_STATE_DIR" \
        "Ahoy. You are the first mate in the firstmate-deck SANDBOX: read CLAUDE.md, then state/decisions.md. Your demo project repo is $DEMO (project slug deck-demo). Reply with one line saying you're ready, then wait for the captain." \
        | jq -r '.id // .agentId // empty')"
  echo "launched first mate $fm"
else
  echo "first mate already live: $fm"
fi

step "ready"
echo "web UI:     http://$PASEO_DECK_LISTEN"
echo "first mate: $fm"
echo "next:       tell it \"start a page for deck-demo, then add a /health endpoint and a README section\""
