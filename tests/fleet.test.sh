#!/usr/bin/env bash
# Tests for bin/fleet. Needs only bash + jq. Uses a temp FLEET_FILE.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
F="$HERE/bin/fleet"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export FLEET_FILE="$T/fleet.json"
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1 ${2:-}"; fail=$((fail+1)); }
check() { # name cond-exit
  if [[ "$2" -eq 0 ]]; then ok "$1"; else bad "$1" "${3:-}"; fi
}
reset() { rm -rf "$T"/*; echo '{"tasks":[]}' >"$FLEET_FILE"; }
eq() { [[ "$1" == "$2" ]]; }
# refused <name> cmd...: command must fail and leave the file byte-identical
refused() {
  local name="$1"; shift
  local before; before="$(cat "$FLEET_FILE")"
  if "$@" >/dev/null 2>&1; then bad "$name" "(command succeeded)"; return; fi
  [[ "$(cat "$FLEET_FILE")" == "$before" ]] && ok "$name" || bad "$name" "(file changed)"
}

reset
$F add a intent=x shape=ship status=queued project=deck title="Hello" >/dev/null
eq "$($F get a | jq -r '.project+"|"+.title+"|"+.status')" "deck|Hello|queued"; check "add with project/title/queued" $?
$F add b intent=x shape=scout status=parked >/dev/null; $F set b project=deck >/dev/null
eq "$($F get b | jq -r .project)" deck; check "set project" $?
$F set b project= >/dev/null
eq "$($F get b | jq -c .project)" null; check "empty project -> null" $?
$F set b title="new title" status=parked >/dev/null
eq "$($F get b | jq -r .title)" "new title"; check "set title" $?
for s in queued parked dispatched running needs-captain done failed; do
  $F set b status=$s >/dev/null 2>&1 || bad "status $s accepted"
done; ok "all enum statuses accepted"

refused "bad project slug" $F set a project=Bad_Slug
refused "bad project slug on add" $F add c intent=x shape=ship status=queued project=-x
refused "title over 80" $F set a title="$(printf 'x%.0s' $(seq 81))"
$F set a title="$(printf 'x%.0s' $(seq 80))" >/dev/null; check "title of 80 ok" $?
$F set a title=Hello >/dev/null
refused "bad status" $F set a status=bogus
refused "ask over 200" $F ask a "$(printf 'x%.0s' $(seq 201))"
refused "notes over 200" $F set a notes="$(printf 'x%.0s' $(seq 201))"

# depends
$F depend a z1 z2 >/dev/null; $F depend a z2 z3 >/dev/null
eq "$($F get a | jq -c .depends_on)" '["z1","z2","z3"]'; check "depend appends + dedupes (archived ids ok)" $?
$F undepend a z2 >/dev/null
eq "$($F get a | jq -c .depends_on)" '["z1","z3"]'; check "undepend" $?
refused "depend on unknown task" $F depend nope z1
refused "depend self" $F depend a a
refused "depend bad id" $F depend a 'Bad Id'

# ask context
printf 'long context\n' >"$T/ctx.md"
$F ask a "first" >/dev/null
$F ask a "second" --context-file "$T/ctx.md" >/dev/null
eq "$($F get a | jq -r '.asks[1].context')" "tasks/a/asks/2.md"; check "ask context path stored" $?
[[ -f "$T/tasks/a/asks/2.md" ]] && eq "$(cat "$T/tasks/a/asks/2.md")" "long context"; check "ask context file copied" $?
refused "ask missing context file" $F ask a "third" --context-file "$T/nope.md"
refused "ask context + overlong text" $F ask a "$(printf 'x%.0s' $(seq 201))" --context-file "$T/ctx.md"
[[ ! -e "$T/tasks/a/asks/3.md" ]]; check "refused ask leaves no file" $?
$F answer a 2 >/dev/null
[[ -f "$T/tasks/a/asks/2.md" ]]; check "answer leaves context file" $?
$F ask a "again" --context-file "$T/ctx.md" >/dev/null
eq "$($F get a | jq -r '.asks[-1].context')" "tasks/a/asks/3.md"; check "no clobber of lingering context" $?

# archive
refused "archive with open asks" $F archive a
$F answer a 1 >/dev/null; $F answer a 1 >/dev/null
refused "archive non-done" $F archive a
$F set a status=done >/dev/null; $F archive a >/dev/null
eq "$(jq -r '.project+"|"+.title' "$T/fleet-archive.jsonl")" "deck|Hello"; check "archive keeps project+title" $?

# queries
reset
$F add p1 intent=x shape=ship status=queued project=deck >/dev/null
$F add p2 intent=x shape=ship status=running project=deck agentId=ag >/dev/null
$F add p3 intent=x shape=ship status=running project=other >/dev/null
$F add p4 intent=x shape=ship status=parked >/dev/null
eq "$($F active | jq -r 'map(.id)|join(",")')" "p2,p3"; check "active unchanged (no queued/parked)" $?
eq "$($F active --project deck | jq -r 'map(.id)|join(",")')" "p2"; check "active --project" $?
eq "$($F project deck | jq -r .id | paste -sd,)" "p1,p2"; check "project lists all statuses, one per line" $?
eq "$($F project deck | wc -l)" 2; check "project compact lines" $?
for i in 1 2 3; do
  $F add d$i intent=x shape=ship status=done project=deck title="D$i" >/dev/null; $F archive d$i >/dev/null
done
$F add e intent=x shape=ship status=done project=other >/dev/null; $F archive e >/dev/null
eq "$($F project deck --archive | jq -r .id | paste -sd,)" "d1,d2,d3"; check "project --archive default" $?
eq "$($F project deck --archive 2 | jq -r .id | paste -sd,)" "d2,d3"; check "project --archive N" $?
eq "$($F project nothing --archive | wc -l)" 0; check "project --archive none" $?

# regression of old commands
reset
$F add r intent=x shape=scout status=dispatched agentId=A1 >/dev/null
$F ask r "q?" >/dev/null
[[ -n "$($F get r)" ]]; check "get" $?
eq "$($F by-agent A1 | jq -r .id)" r; check "by-agent" $?
eq "$($F active | jq -r '.[0].id')" r; check "active" $?
$F asks | grep -q '^r \[1\]: q?'; check "asks" $?
$F log r "hello" >/dev/null; grep -q hello "$T/tasks/r/log.md"; check "log" $?
$F preview r 4321 99 >/dev/null; eq "$($F get r | jq -c .preview)" '{"port":4321,"pid":99}'; check "preview" $?
$F clear-preview r >/dev/null; eq "$($F get r | jq -c '.preview')" null; check "clear-preview" $?
$F answer r 1 >/dev/null; eq "$($F get r | jq '.asks|length')" 0; check "answer" $?

# reask
reset
$F add q intent=x shape=scout status=needs-captain >/dev/null
$F ask q "first?" >/dev/null
$F ask q "second?" >/dev/null
jq '.tasks[0].asks |= map(.since = "2020-01-01T00:00:00Z")' "$FLEET_FILE" >"$T/f.tmp" && mv "$T/f.tmp" "$FLEET_FILE"
$F reask q 2 >/dev/null
eq "$($F get q | jq -r '.asks[1].since | startswith("2020") | not')" true; check "reask bumps since" $?
eq "$($F get q | jq -r '.asks[0].since')" "2020-01-01T00:00:00Z"; check "reask leaves other asks" $?
eq "$($F get q | jq -r '.asks[1].text')" "second?"; check "reask keeps text" $?
$F reask q 1 "sharper question?" >/dev/null
eq "$($F get q | jq -r '.asks[0].text')" "sharper question?"; check "reask replaces text" $?
echo "# details" >"$T/rctx.md"
$F reask q 1 "with details" --context-file "$T/rctx.md" >/dev/null
rel="$($F get q | jq -r '.asks[0].context')"
[[ -f "$T/$rel" ]] && eq "$(cat "$T/$rel")" "# details"; check "reask copies context file" $?
$F reask q 2 --context-file "$T/rctx.md" >/dev/null
eq "$($F get q | jq -r '.asks[1].text')" "second?" && [[ -n "$($F get q | jq -r '.asks[1].context')" ]]; check "reask context only keeps text" $?
refused "reask bad index (0)" $F reask q 0
refused "reask index past end" $F reask q 3
refused "reask non-numeric index" $F reask q x
refused "reask unknown task" $F reask nope 1
refused "reask text over 200" $F reask q 1 "$(printf 'x%.0s' $(seq 201))"
refused "reask empty text" $F reask q 1 ""
refused "reask missing context file" $F reask q 1 "t" --context-file "$T/nope.md"

echo "---- $pass passed, $fail failed"
[[ $fail -eq 0 ]]
