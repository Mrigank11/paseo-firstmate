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

# blocked: waiting on an outside dependency, needs blocked_on, never active
refused "blocked without blocked_on (set)" $F set b status=blocked
refused "blocked without blocked_on (add)" $F add bl0 intent=x shape=ship status=blocked
refused "blocked_on without blocked status" $F set b blocked_on="Nemath key"
refused "empty blocked_on while blocked" $F set b status=blocked blocked_on=
refused "blocked_on over 200" $F set b status=blocked blocked_on="$(printf 'x%.0s' $(seq 201))"
$F set b status=blocked blocked_on="Nemath: Trigger Prod API key" >/dev/null; check "set blocked + blocked_on" $?
eq "$($F get b | jq -r '.status+"|"+.blocked_on')" "blocked|Nemath: Trigger Prod API key"; check "blocked_on stored" $?
$F set b notes="still waiting" >/dev/null
eq "$($F get b | jq -r .blocked_on)" "Nemath: Trigger Prod API key"; check "blocked_on kept across an unrelated set" $?
$F set b blocked_on="Nemath: staging key" >/dev/null
eq "$($F get b | jq -r .blocked_on)" "Nemath: staging key"; check "blocked_on updated while blocked" $?
$F set b status=running >/dev/null
eq "$($F get b | jq -c 'has("blocked_on")')" false; check "blocked_on dropped when status leaves blocked" $?
$F add bl1 intent=x shape=ship status=blocked blocked_on="legal sign-off" >/dev/null; check "add blocked with blocked_on" $?
eq "$($F active | jq -r 'map(.id)|join(",")' | grep -c bl1)" 0; check "blocked is not active" $?
$F set b status=parked >/dev/null; $F set bl1 status=queued >/dev/null

refused "bad project slug" $F set a project=Bad_Slug
refused "bad project slug on add" $F add c intent=x shape=ship status=queued project=-x
refused "title over 160" $F set a title="$(printf 'x%.0s' $(seq 161))"
$F set a title="$(printf 'x%.0s' $(seq 160))" >/dev/null; check "title of 160 ok" $?
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
eq "$(jq -rs '[.[] | [.id, .text, .context, (.answeredAt | length > 0)]] | tostring' "$T/tasks/a/asks.jsonl")" '[["a2","second","tasks/a/asks/2.md",true]]'; check "answer records the ask in tasks/<id>/asks.jsonl" $?
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
$F asks | grep -q '^r \[a1\]: q?'; check "asks" $?
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

# options
reset
$F add o intent=x shape=scout status=needs-captain >/dev/null
printf "ctx\n" >"$T/ctx.md"
$F ask o "Which design?" --options "A index card|B live console|C status board" >/dev/null
eq "$($F get o | jq -c '.asks[0].options')" '["A index card","B live console","C status board"]'; check "ask --options stored" $?
$F ask o "With ctx?" --context-file "$T/ctx.md" --options "yes|no" >/dev/null
eq "$($F get o | jq -c '.asks[1].options')" '["yes","no"]' && [[ -n "$($F get o | jq -r '.asks[1].context')" ]]; check "ask --options + --context-file" $?
$F ask o "plain?" >/dev/null
eq "$($F get o | jq -c '.asks[2] | has("options")')" false; check "ask without options has no options key" $?
refused "options: only one" $F ask o "q?" --options "solo"
refused "options: seven" $F ask o "q?" --options "a|b|c|d|e|f|g"
refused "options: over 60 chars" $F ask o "q?" --options "ok|$(printf 'x%.0s' $(seq 61))"
refused "options: empty choice" $F ask o "q?" --options "a||b"
refused "options: missing value" $F ask o "q?" --options
$F reask o 1 >/dev/null
eq "$($F get o | jq -c '.asks[0].options | length')" 3; check "reask keeps options" $?
$F reask o 1 --options "X|Y" >/dev/null
eq "$($F get o | jq -c '.asks[0].options')" '["X","Y"]'; check "reask replaces options" $?
$F reask o 1 "new text?" --options "P|Q|R" >/dev/null
eq "$($F get o | jq -r '.asks[0].text')" "new text?" && eq "$($F get o | jq -c '.asks[0].options')" '["P","Q","R"]'; check "reask text + options" $?
refused "reask bad options" $F reask o 1 --options "one"

# pending: the first mate's explicit "I'm on it" mark on an ask
reset
$F add pd intent=x shape=scout status=needs-captain >/dev/null
$F ask pd "First?" >/dev/null; $F ask pd "Second?" >/dev/null
$F pending pd 2 >/dev/null
eq "$($F get pd | jq -r '.asks[1].pendingSince | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")')" true; check "pending sets pendingSince on ask 2" $?
eq "$($F get pd | jq -c '.asks[0] | has("pendingSince")')" false; check "pending touches only the named ask" $?
refused "pending unknown task" $F pending nope 1
refused "pending ask index out of range" $F pending pd 3
refused "pending bad index" $F pending pd x
refused "pending needs both arguments" $F pending pd
$F reask pd 2 >/dev/null
eq "$($F get pd | jq -c '.asks[1] | has("pendingSince")')" false; check "reask clears pendingSince" $?
$F pending pd 1 >/dev/null; $F pending pd 2 >/dev/null
$F answer pd 1 >/dev/null
eq "$($F get pd | jq -c '[.asks[].text, (.asks[0] | has("pendingSince"))]')" '["Second?",true]'; check "answer removes the ask; the other keeps its mark" $?
$F reask pd 1 "Second, sharper?" >/dev/null
eq "$($F get pd | jq -c '.asks[0] | [.text, has("pendingSince")]')" '["Second, sharper?",false]'; check "reask with new text also clears the mark" $?

# stable ask ids (C1): assigned by ask, never reused, kept by reask/pending/answer; numbers still work
reset
$F add sid intent=x shape=scout status=needs-captain >/dev/null
eq "$($F ask sid "One?" --options "A|B")" a1; check "ask prints its id" $?
$F ask sid "Two?" >/dev/null; $F ask sid "Three?" >/dev/null
eq "$($F get sid | jq -c '[.asks[].id]')" '["a1","a2","a3"]'; check "asks get stable ids a1..a3" $?
$F answer sid a1 >/dev/null
eq "$($F get sid | jq -c '[.asks[] | [.id,.text]]')" '[["a2","Two?"],["a3","Three?"]]'; check "answering a1 leaves a2/a3 with their ids" $?
$F pending sid a3 >/dev/null
eq "$($F get sid | jq -c '[.asks[] | has("pendingSince")]')" '[false,true]'; check "pending by id hits ask a3 after a1 was answered" $?
$F reask sid a2 "Two, sharper?" >/dev/null
eq "$($F get sid | jq -c '[.asks[] | [.id,.text]]')" '[["a2","Two, sharper?"],["a3","Three?"]]'; check "reask by id keeps ids" $?
$F answer sid a2 >/dev/null
eq "$($F get sid | jq -c '[.asks[].text]')" '["Three?"]'; check "answer by id removes exactly that ask" $?
$F ask sid "Four?" >/dev/null
eq "$($F get sid | jq -c '[.asks[].id]')" '["a3","a4"]'; check "a new ask never reuses an answered id" $?
$F answer sid a4 >/dev/null; $F answer sid a3 >/dev/null
$F ask sid "Five?" >/dev/null
eq "$($F get sid | jq -c '[.asks[].id]')" '["a5"]'; check "ids keep counting after every ask was answered" $?
refused "answer an id that is gone" $F answer sid a1
refused "pending an id that is gone" $F pending sid a1
refused "reask an id that is gone" $F reask sid a2
refused "answer garbage ref" $F answer sid x1
reset
$F add num intent=x shape=scout status=needs-captain >/dev/null
$F ask num "P?" >/dev/null; $F ask num "Q?" >/dev/null
$F answer num 1 >/dev/null
eq "$($F get num | jq -c '[.asks[] | [.id,.text]]')" '[["a2","Q?"]]'; check "a plain 1-based number still resolves" $?
# asks written before ids existed get them lazily, from their index, on the first write
reset
cat >"$FLEET_FILE" <<'J'
{"tasks":[{"id":"old","intent":"x","shape":"scout","status":"needs-captain","asks":[{"text":"First?","since":"2026-01-01T00:00:00Z"},{"text":"Second?","since":"2026-01-01T00:00:00Z"},{"text":"Third?","since":"2026-01-01T00:00:00Z"}]}]}
J
$F asks | grep -q '^old \[a2\]: Second?'; check "asks lists an id-less ask under its index id" $?
$F answer old 1 >/dev/null
eq "$($F get old | jq -c '[.asks[] | [.id,.text]]')" '[["a2","Second?"],["a3","Third?"]]'; check "id-less asks get index ids at first touch, then answer removes by that" $?
$F ask old "Fourth?" >/dev/null
eq "$($F get old | jq -c '[.asks[].id]')" '["a2","a3","a4"]'; check "a new ask after lazy ids takes the next number" $?
reset
cat >"$FLEET_FILE" <<'J'
{"tasks":[{"id":"mix","intent":"x","shape":"scout","status":"needs-captain","asks":[{"text":"Plain?","since":"2026-01-01T00:00:00Z"},{"id":"a1","text":"Has id?","since":"2026-01-01T00:00:00Z"}]}]}
J
$F pending mix 1 >/dev/null
eq "$($F get mix | jq -c '[.asks[] | .id]')" '["a2","a1"]'; check "a lazy id never collides with an existing one" $?

# fallback lock without flock: parallel writers still do not lose updates
reset
mkdir -p "$T/noflock"
for b in bash jq date mktemp mv rm cat mkdir dirname sleep find rmdir sed head grep tail git env; do p="$(command -v $b)" && ln -sf "$p" "$T/noflock/$b"; done
for i in $(seq 1 16); do PATH="$T/noflock" "$T/noflock/bash" "$F" add "nf-$i" intent=x shape=scout status=queued >/dev/null 2>&1 & done
wait
eq "$(jq '.tasks | length' "$FLEET_FILE")" 16; check "16 parallel adds all land without flock (mkdir lock)" $?

# project inheritance through depends_on (proposal 3)
reset
$F add base intent=x shape=scout status=done project=deck >/dev/null
$F add child intent=x shape=ship status=queued depends_on=base >/dev/null 2>&1
eq "$($F get child | jq -r '.project')" deck; check "add depends_on=<dep> inherits the dep's project" $?
eq "$($F get child | jq -c '.depends_on')" '["base"]'; check "add stores depends_on as an array" $?
$F add child2 intent=x shape=ship status=queued project=other depends_on=base >/dev/null 2>&1
eq "$($F get child2 | jq -r '.project')" other; check "an explicit project= wins over inheritance" $?
$F add free intent=x shape=ship status=queued >/dev/null
$F add c3 intent=x shape=ship status=queued depends_on=free,base >/dev/null 2>&1
eq "$($F get c3 | jq -r '.project')" deck; check "inherits from the first dependency that has a project" $?
$F depend free base >/dev/null 2>&1
eq "$($F get free | jq -r '.project')" deck; check "depend gives a project-less task the dep's project" $?
$F add keep intent=x shape=ship status=queued project=mine >/dev/null; $F depend keep base >/dev/null 2>&1
eq "$($F get keep | jq -r '.project')" mine; check "depend leaves an existing project alone" $?
echo '{"id":"gone","intent":"x","shape":"scout","status":"done","project":"arch"}' >"$T/fleet-archive.jsonl"
$F add fromarch intent=x shape=ship status=queued depends_on=gone >/dev/null 2>&1
eq "$($F get fromarch | jq -r '.project')" arch; check "inherits from an archived dependency" $?
refused "add with a bad depends_on id" $F add bad2 intent=x shape=ship status=queued depends_on=Bad_Id
refused "add depending on itself" $F add selfdep intent=x shape=ship status=queued depends_on=selfdep

# finish (proposal 4)
reset
REPO="$T/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main && git -C "$REPO" config user.email t@t && git -C "$REPO" config user.name t
echo 1 >"$REPO/f"; git -C "$REPO" add f && git -C "$REPO" commit -qm "base commit"
git -C "$REPO" checkout -qb feat/x
echo 2 >>"$REPO/f"; git -C "$REPO" commit -qam "first change"
echo 3 >>"$REPO/f"; git -C "$REPO" commit -qam "second change"
mkdir -p "$T/projects/demo"; echo "{\"title\":\"Demo\",\"repo\":\"$REPO\"}" >"$T/projects/demo/project.json"
$F add fin intent="Build the thing" shape=ship status=running project=demo notes="Added the thing; tests green" pr=https://example.test/pr/1 >/dev/null
$F finish fin --branch feat/x >/dev/null 2>"$T/fin.err"
eq "$($F get fin | jq -r '[.status,.branch]|join(" ")')" "done feat/x"; check "finish sets status=done and the branch" $?
grep -q "Added the thing; tests green" "$T/tasks/fin/card.md" && grep -q 'Branch: `feat/x` · PR: https://example.test/pr/1' "$T/tasks/fin/card.md"; check "finish writes a default card from notes + branch/PR" $?
code="$T/projects/demo/sections/code.md"
[[ "$(grep -c -E '^- [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} [0-9a-f]{7,} (first|second) change$' "$code")" == 2 ]]; check "finish appends dated commit lines to sections/code.md" $?
grep -n "first change" "$code" | cut -d: -f1 | { read a; grep -n "second change" "$code" | cut -d: -f1 | { read b; [[ $a -lt $b ]]; }; }; check "...oldest commit first" $?
$F finish fin --branch feat/x >/dev/null 2>&1
eq "$(wc -l <"$code" | tr -d ' ')" 2; check "finish twice does not duplicate commit lines" $?
echo 4 >>"$REPO/f"; git -C "$REPO" commit -qam "third change"
$F finish fin >/dev/null 2>&1
eq "$(wc -l <"$code" | tr -d ' ')" 3; check "...a later commit is appended, earlier ones are not repeated" $?
printf 'No local code changes recorded yet.\n' >"$code"
$F finish fin >/dev/null 2>&1
grep -q "No local code changes" "$code" && bad "placeholder removed" || ok "finish replaces the section's placeholder line"
$F add fin2 intent=y shape=ship status=running project=demo >/dev/null
printf 'Hand-written card.\nSecond line.\n' | $F finish fin2 --card - --failed >/dev/null 2>&1
eq "$($F get fin2 | jq -r .status)" failed; check "finish --failed sets status=failed" $?
eq "$(cat "$T/tasks/fin2/card.md")" "$(printf 'Hand-written card.\nSecond line.')"; check "finish --card - writes the given card" $?
printf 'File card\n' >"$T/c.md"; $F finish fin2 --card-file "$T/c.md" >/dev/null 2>&1
eq "$(cat "$T/tasks/fin2/card.md")" "File card"; check "finish --card-file writes the file as the card" $?
$F finish fin2 >/dev/null 2>&1
eq "$(cat "$T/tasks/fin2/card.md")" "File card"; check "a default finish never overwrites an existing card" $?
$F add fin3 intent=z shape=scout status=running >/dev/null
$F finish fin3 --branch nope >/dev/null 2>&1; check "finish on a task with no project works" $?
$F add fin4 intent=z shape=ship status=running project=demo >/dev/null
$F finish fin4 --branch no-such-branch >/dev/null 2>"$T/fin4.err"; rc=$?
eq "$rc" 0; check "finish with an unknown branch still finishes" $?
grep -q "skipped the code section" "$T/fin4.err"; check "...and says it skipped the code section" $?
eq "$($F get fin4 | jq -r .status)" done; check "...with status done" $?
refused "finish an unknown task" $F finish nope
refused "finish with a bad option" $F finish fin --bogus

# lock: parallel writers must not lose updates (read-modify-write under flock)
if command -v flock >/dev/null; then
  reset
  for i in $(seq 1 24); do $F add "par-$i" intent=x shape=scout status=queued >/dev/null 2>&1 & done
  wait
  eq "$(jq '.tasks | length' "$FLEET_FILE")" 24; check "24 parallel adds all land (no lost update)" $?
  for i in $(seq 1 24); do $F set "par-$i" notes="n$i" >/dev/null 2>&1 & done
  wait
  eq "$(jq '[.tasks[] | select(.notes != null)] | length' "$FLEET_FILE")" 24; check "24 parallel sets all land" $?
  jq -e . "$FLEET_FILE" >/dev/null; check "fleet.json is still valid JSON" $?
  [[ -f "$FLEET_FILE.lock" ]]; check "lock file is separate from fleet.json" $?
else
  ok "flock not installed: lock tests skipped"
fi

# ---- order, legacyId, card, archive-update ----
reset
$F add o1 intent=x shape=ship status=queued order=3 legacyId=old-one >/dev/null
eq "$($F get o1 | jq -c '[.order,.legacyId]')" '[3,"old-one"]'; check "order is stored as a number, legacyId as given" $?
refused "order that is not a whole number" $F set o1 order=1.5
refused "negative order" $F set o1 order=-1
refused "legacyId that is not a slug" $F set o1 legacyId=Bad_Id
printf 'card one\n' >"$T/c1"
$F card o1 --file "$T/c1" >/dev/null; check "card writes a live task's card" $?
eq "$(cat "$(dirname "$FLEET_FILE")/tasks/o1/card.md")" "card one"; check "...with the given content" $?
m1="$(stat -c %Y.%N "$(dirname "$FLEET_FILE")/tasks/o1/card.md" 2>/dev/null || stat -f %m "$(dirname "$FLEET_FILE")/tasks/o1/card.md")"
sleep 1; $F card o1 --file "$T/c1" >/dev/null
m2="$(stat -c %Y.%N "$(dirname "$FLEET_FILE")/tasks/o1/card.md" 2>/dev/null || stat -f %m "$(dirname "$FLEET_FILE")/tasks/o1/card.md")"
eq "$m1" "$m2"; check "the same card again is not rewritten" $?
echo 'card two' | $F card o1 - >/dev/null
eq "$(cat "$(dirname "$FLEET_FILE")/tasks/o1/card.md")" "card two"; check "card from stdin" $?
$F card nope --file "$T/c1" >/dev/null 2>&1; [[ $? -ne 0 ]]; check "card refuses an unknown task" $?
$F set o1 status=done >/dev/null; $F archive o1 >/dev/null 2>&1
ARCH="$(dirname "$FLEET_FILE")/fleet-archive.jsonl"
if [[ -f "$ARCH" ]] && grep -q '"o1"' "$ARCH"; then
  $F card o1 --file "$T/c1" >/dev/null; check "card works for an archived task" $?
  $F archive-update o1 project=deck title="Later title" depends_on=a,b >/dev/null; check "archive-update appends" $?
  eq "$(grep -c '"id":"o1"' "$ARCH")" 2; check "...a second line (append-only)" $?
  eq "$(tail -n1 "$ARCH" | jq -c '[.project,.title,.depends_on,.order]')" '["deck","Later title",["a","b"],3]'; check "...that keeps the old fields and applies the new" $?
  refused "archive-update of a task that is not archived" $F archive-update zz title=x
else
  bad "archive o1 for the card/archive-update tests" "$(ls "$(dirname "$FLEET_FILE")")"
fi

echo "---- $pass passed, $fail failed"
[[ $fail -eq 0 ]]
