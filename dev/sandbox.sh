#!/usr/bin/env bash
# dev/sandbox.sh — an isolated Paseo daemon + Lavish server for building and demoing firstmate-deck.
#
#   dev/sandbox.sh up               write the sandbox config (if missing) and start the daemon
#   dev/sandbox.sh down             stop the sandbox daemon and the sandbox Lavish server
#   dev/sandbox.sh status           show both, plus the live daemon for comparison
#   dev/sandbox.sh restart-daemon   stop, wait 20 s, start (the "Paseo restarts" demo step)
#   dev/sandbox.sh config           regenerate the sandbox config from the live one
#
# The live daemon (~/.paseo) is only ever READ (its config.json, for provider definitions).
# Never run `paseo daemon config set` against the sandbox: it rewrites config.json down to its
# defaults, which drops the listen address back to 127.0.0.1:6767.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=dev/sandbox.env
source "$ROOT/dev/sandbox.env"
LIVE_CONFIG="$HOME/.paseo/config.json"

die() { echo "sandbox: $*" >&2; exit 1; }

write_config() {
  mkdir -p "$PASEO_HOME" "$LAVISH_AXI_STATE_DIR"
  local tmp; tmp="$(mktemp "$PASEO_HOME/config.json.XXXXXX")"
  jq --arg listen "$PASEO_DECK_LISTEN" '{version, agents, features, app,
      daemon: (.daemon | .listen = $listen | .relay = {enabled: false}),
      pluginsEnabled: true}' "$LIVE_CONFIG" >"$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$PASEO_HOME/config.json"
  echo "config: $PASEO_HOME/config.json (listen $PASEO_DECK_LISTEN, plugins on, relay off)"
}

check_listen() { # refuse to start if the config would collide with the live daemon
  local l; l="$(jq -r '.daemon.listen // ""' "$PASEO_HOME/config.json")"
  [[ "$l" == "$PASEO_DECK_LISTEN" ]] || die "sandbox config listens on '$l', expected $PASEO_DECK_LISTEN; run: dev/sandbox.sh config"
}

running() { [[ "$(paseo status --home "$PASEO_HOME" --json 2>/dev/null | jq -r '.localDaemon // ""')" == running ]]; }

cmd_up() {
  [[ -f "$PASEO_HOME/config.json" ]] || write_config
  check_listen
  if running; then echo "daemon: already running"; else paseo start --home "$PASEO_HOME" --timeout 90 | tail -1; fi
  cmd_status
}

cmd_down() {
  running && paseo daemon stop --home "$PASEO_HOME" | tail -1 || echo "daemon: not running"
  npx -y lavish-axi stop >/dev/null 2>&1 && echo "lavish: sandbox server stopped" || echo "lavish: not running"
}

cmd_status() {
  echo "sandbox daemon: $(paseo status --home "$PASEO_HOME" --json 2>/dev/null | jq -r '"\(.localDaemon) \(.listen // "-") \(.serverId // "")"')"
  echo "live daemon:    $(paseo status --home "$HOME/.paseo" --json 2>/dev/null | jq -r '"\(.localDaemon) \(.listen // "-")"') (not touched)"
  echo "sandbox lavish: port $LAVISH_AXI_PORT, state $LAVISH_AXI_STATE_DIR"
  echo "web UI:         http://$PASEO_DECK_LISTEN"
}

cmd_restart_daemon() {
  check_listen
  paseo daemon stop --home "$PASEO_HOME" | tail -1
  echo "daemon down for 20 s: comment on the page now to test queued delivery"
  sleep 20
  paseo start --home "$PASEO_HOME" --timeout 90 | tail -1
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  restart-daemon) cmd_restart_daemon ;;
  config) write_config ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
