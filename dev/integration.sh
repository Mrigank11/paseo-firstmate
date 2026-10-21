#!/usr/bin/env bash
# Live integration run of firstmate-deck on the SANDBOX daemon (never the live one).
#   dev/integration.sh            full run, including the daemon restart (about 2 minutes)
#   dev/integration.sh --no-restart
# Needs: sandbox daemon up (dev/sandbox.sh up), headless Chrome (dev/post-comment.mjs), jq, node.
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=dev/sandbox.env
source "$R/dev/sandbox.env"
[[ "$PASEO_HOME" == */.paseo-deck ]] || { echo "refusing: PASEO_HOME is not the sandbox" >&2; exit 1; }
H="$PASEO_HOME"
export LAVISH_AXI_NO_OPEN=1 XDG_CONFIG_HOME=/tmp/deck-xdg
IT=/tmp/deck-it
export FIRSTMATE_ROOT="$IT"
PROJ="$IT/state/projects/it-demo"
RESTART=1; [[ "${1:-}" == "--no-restart" ]] && RESTART=0

now() { date +%s%3N; }
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1 ${2:-}"; fail=$((fail+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1" "[$2]"; fi; }
until_true() { # <timeout-ms> <cmd...>: poll every 20 ms; echo elapsed-since-start isn't needed, caller times it
  local t0 now_; t0=$(now)
  while ! eval "$2"; do now_=$(now); (( now_ - t0 > $1 )) && return 1; sleep 0.02; done
}
epoch_ms() { date -d "$1" +%s%3N; }
plugin_log() { paseo plugin logs firstmate-deck --home "$H" 2>&1; }

echo "== 1. fresh root, plugin settings, plugin installed =="
rm -rf "$IT"; mkdir -p "$IT/state/projects" /tmp/deck-it-agent
cat >"$IT/state/fleet.json" <<'J'
{"tasks":[{"id":"ab-gap","intent":"Fill the gap in the endpoints doc","shape":"ship","status":"queued","project":"it-demo","title":"Fill the endpoints gap","depends_on":[],"asks":[],"notes":"seeded for the integration run"}]}
J
cat >"$IT/state/page.env" <<E
export LAVISH_AXI_PORT=$LAVISH_AXI_PORT
export LAVISH_AXI_STATE_DIR=$LAVISH_AXI_STATE_DIR
export LAVISH_AXI_NO_OPEN=1
export PASEO_HOME=$H
E
mkdir -p "$H/plugin-settings/firstmate-deck"
printf '{"version":1,"values":{"firstmateRoot":"%s","firstmateLabel":"firstmate=true","lavishPort":%s,"lavishStateDir":"%s"}}' "$IT" "$LAVISH_AXI_PORT" "$LAVISH_AXI_STATE_DIR" >"$H/plugin-settings/firstmate-deck/deck.json"
chmod 600 "$H/plugin-settings/firstmate-deck/deck.json"
if paseo plugin ls --json --home "$H" | jq -e 'map(select(.id=="firstmate-deck"))|length>0' >/dev/null; then
  paseo plugin reload firstmate-deck --home "$H" >/dev/null
else
  paseo plugin install "$R/plugin/firstmate-deck" --home "$H" >/dev/null
fi
sleep 2
check "plugin is running" 'paseo plugin ls --json --home "$H" | jq -e "map(select(.id==\"firstmate-deck\"))|first|.status==\"running\"" >/dev/null'

echo "== 2. first mate agent (label firstmate=true) =="
FM="$(paseo ls --label firstmate=true --json --home "$H" | jq -r '.[0].id // empty')"
if [[ -z "$FM" ]]; then
  FM="$(cd /tmp/deck-it-agent && paseo run --label firstmate=true --home "$H" --provider claude --model claude-sonnet-5-5 --name it-firstmate -q "reply only with the word ready, then wait" | tail -1)"
fi
echo "first mate: $FM"
# one turn after the plugin loaded, so a hook fires and the plugin holds an SDK handle for the timeline row
paseo send "$FM" --home "$H" "reply only with pong" >/dev/null
check "first mate is findable by label" '[[ -n "$FM" ]]'

echo "== 3. bin/page start =="
OUT="$("$R/bin/page" start it-demo --page "$PROJ/page.html" --title "IT demo" --reopen)"
echo "$OUT"
URL="$(jq -r .url <<<"$OUT")"
check "page file exists" '[[ -f "$PROJ/page.html" ]]'
check "page.json session open" '[[ "$(jq -r .session "$PROJ/page.json")" == open ]]'
check "plugin started polling the page" 'until_true 8000 "pgrep -f \"lavish-axi/dist/cli.mjs poll $PROJ/page.html\" >/dev/null"'
check ".poll.pid written" '[[ -s "$PROJ/.poll.pid" ]]'

echo "== 4. a real comment, typed into the Lavish UI =="
BEFORE=0; [[ -f "$PROJ/inbox.jsonl" ]] && BEFORE=$(wc -l <"$PROJ/inbox.jsonl")
SENT_AT=$(node "$R/dev/post-comment.mjs" "$URL" "#t-ab-gap .ttl" "Integration comment: is the gap filled?" | jq -r .sentAt)
check "inbox line appears" 'until_true 8000 "[[ -f \"$PROJ/inbox.jsonl\" && \$(wc -l <\"$PROJ/inbox.jsonl\") -gt $BEFORE ]]"'
T_INBOX=$(now)
check "delivered:true after the send" 'until_true 20000 "jq -e -s \"last|.delivered\" \"$PROJ/inbox.jsonl\" >/dev/null"'
T_DELIVERED=$(now)
LINE="$(tail -1 "$PROJ/inbox.jsonl")"
echo "$LINE" | jq -c '{id,target,text,delivered,answered,selector:.prompt.selector}'
check "target is the task card" '[[ "$(jq -r .target <<<"$LINE")" == t-ab-gap ]]'
check "first mate got the exact message" 'paseo logs "$FM" --home "$H" | grep -qF -- "## Page comments · it-demo" && paseo logs "$FM" --home "$H" | grep -qF -- "- [t-ab-gap] \"Integration comment: is the gap filled?\""'
check "message ends with the reply hint" 'paseo logs "$FM" --home "$H" | grep -qF "Reply with: bin/page reply it-demo"'
check "timeline row appended" 'plugin_log | grep -q "timeline row pc-.* appended to $FM"'
INBOX_AT=$(epoch_ms "$(jq -r .at <<<"$LINE")")
echo "LATENCY comment sent -> inbox write (plugin's own timestamp): $(( INBOX_AT - SENT_AT )) ms"
echo "LATENCY comment sent -> first mate message accepted (delivered:true seen): $(( T_DELIVERED - SENT_AT )) ms"

echo "== 5. bin/page reply =="
"$R/bin/page" reply it-demo "Integration reply: the gap is filled."
check "comment marked answered" '[[ "$(tail -1 "$PROJ/inbox.jsonl" | jq -r .answered)" == true ]]'
"$R/bin/page" status

echo "== 6. bin/fleet set -> page file =="
T0=$(now)
FLEET_FILE="$IT/state/fleet.json" "$R/bin/fleet" set ab-gap title="Endpoints gap, now filled" >/dev/null
check "live.js carries the new title" 'until_true 5000 "grep -q \"now filled\" \"$PROJ/page.live.js\""'
T1=$(now)
echo "LATENCY fleet set -> page.live.js changed: $(( T1 - T0 )) ms"
FLEET_FILE="$IT/state/fleet.json" "$R/bin/fleet" set ab-gap status=running >/dev/null
check "page.html rewritten on a status change" 'until_true 5000 "grep -q \"class=.task s-running\" \"$PROJ/page.html\""'

echo "== 7. direct POST (no browser) latency, server side only =="
KEY="$(basename "$URL")"
BEFORE=$(wc -l <"$PROJ/inbox.jsonl")
T0=$(now)
curl -s -XPOST -H 'content-type: application/json' -H "Origin: http://localhost:$LAVISH_AXI_PORT" -H "Host: localhost:$LAVISH_AXI_PORT" \
  "localhost:$LAVISH_AXI_PORT/api/$KEY/prompts" -d '{"prompts":[{"prompt":"direct post","selector":"section#endpoints > h2","tag":"h2","text":"Endpoints"}]}' >/dev/null
until_true 8000 "[[ \$(wc -l <\"$PROJ/inbox.jsonl\") -gt $BEFORE ]]"; T1=$(now)
until_true 20000 "jq -e -s \"last|.delivered\" \"$PROJ/inbox.jsonl\" >/dev/null"; T2=$(now)
echo "LATENCY POST -> inbox line: $(( T1 - T0 )) ms; POST -> delivered: $(( T2 - T0 )) ms"
check "section target" '[[ "$(tail -1 "$PROJ/inbox.jsonl" | jq -r .target)" == endpoints ]]'

if (( RESTART )); then
  echo "== 8. comment while the daemon is down =="
  "$R/dev/sandbox.sh" restart-daemon >/tmp/deck-restart.log 2>&1 &
  RPID=$!
  sleep 6   # the daemon (and with it the plugin and its poll) is down for 20 s
  BEFORE=$(wc -l <"$PROJ/inbox.jsonl")
  node "$R/dev/post-comment.mjs" "$URL" "#t-ab-gap .ttl" "Comment sent while the daemon is down" >/dev/null
  wait "$RPID"
  cat /tmp/deck-restart.log
  check "plugin running after restart" 'until_true 30000 "paseo plugin ls --json --home \"$H\" | jq -e \"map(select(.id==\\\"firstmate-deck\\\"))|first|.status==\\\"running\\\"\" >/dev/null"'
  check "queued comment reached the inbox after restart" 'until_true 30000 "[[ \$(wc -l <\"$PROJ/inbox.jsonl\") -gt $BEFORE ]]"'
  check "and was delivered" 'until_true 60000 "jq -e -s \"last|.delivered\" \"$PROJ/inbox.jsonl\" >/dev/null"'
  check "first mate saw it" 'paseo logs "$FM" --home "$H" | grep -qF "Comment sent while the daemon is down"'
fi

echo
echo "integration: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
