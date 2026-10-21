#!/usr/bin/env bash
# dev/demo-reset.sh — wipe the deck-demo run so the demo can start from scratch. SANDBOX ONLY:
#   archives every sandbox agent and worktree workspace, ends the deck-demo Lavish session,
#   removes deck-demo from this checkout's state/, and deletes the throwaway deck-demo repo.
# Then run dev/demo-setup.sh again. Refuses to run unless PASEO_HOME is the sandbox.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/dev/sandbox.env"
[[ "$PASEO_HOME" == */.paseo-deck ]] || { echo "refusing: PASEO_HOME is not the sandbox" >&2; exit 1; }
H="$PASEO_HOME"
DEMO="${DECK_DEMO_DIR:-$HOME/projects/llm-exp/deck-demo}"
P=deck-demo

for id in $(paseo ls --home "$H" --json 2>/dev/null | jq -r '.[].id'); do
  paseo archive "$id" --force --home "$H" >/dev/null && echo "archived agent $id"
done
# every sandbox workspace except this checkout's own (crew worktrees, test leftovers)
for ws in $(paseo workspace ls --home "$H" --json 2>/dev/null | jq -r --arg r "$ROOT" '.[] | select(((.cwd // "") | sub("^~"; env.HOME)) != $r) | .workspaceId'); do
  paseo workspace archive "$ws" --home "$H" >/dev/null && echo "archived workspace $ws"
done

page="$ROOT/state/projects/$P/page.html"
[[ -f "$page" ]] && npx -y lavish-axi end "$page" >/dev/null 2>&1 && echo "ended Lavish session for $P" || true

rm -rf "$ROOT/state/projects/$P"
for t in $(jq -r --arg p "$P" '.tasks[] | select(.project == $p) | .id' "$ROOT/state/fleet.json" 2>/dev/null); do rm -rf "$ROOT/state/tasks/$t"; done
tmp="$(mktemp)"; jq --arg p "$P" '.tasks |= map(select(.project != $p))' "$ROOT/state/fleet.json" >"$tmp" && mv "$tmp" "$ROOT/state/fleet.json"
if [[ -f "$ROOT/state/fleet-archive.jsonl" ]]; then
  tmp="$(mktemp)"; jq -c --arg p "$P" 'select(.project != $p)' "$ROOT/state/fleet-archive.jsonl" >"$tmp" && mv "$tmp" "$ROOT/state/fleet-archive.jsonl"
fi
echo "removed $P from state/"

if [[ -d "$DEMO/.git" ]] && [[ "$(git -C "$DEMO" log --format=%s | tail -1)" == "deck-demo: initial" ]]; then
  rm -rf "$DEMO" && echo "deleted throwaway repo $DEMO"
fi
echo "reset done; next: dev/demo-setup.sh"
