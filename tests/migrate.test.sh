#!/usr/bin/env bash
# Tests for bin/migrate-fleet-v2. Bash + jq + python3. `paseo` is a stub on PATH (PASEO_BIN); nothing real is touched.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
M="$HERE/bin/migrate-fleet-v2"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1 ${2:-}"; fail=$((fail+1)); }
eq()  { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3" "(got '$1', want '$2')"; fi; }

cat >"$T/paseo" <<'S'
#!/usr/bin/env bash
# stub: agents A1..A5 exist; `agent update` records labels; ls --label reads them back (CANARY_FAIL=1: never)
echo "$*" >>"$STUB_LOG"
case "$1 $2" in
  "agent update") id="$3"; shift 3; while [[ $# -gt 0 ]]; do [[ "$1" == --label ]] && echo "$id $2" >>"$STUB_LABELS"; shift; done;;
  "ls -a")
    if [[ "$*" == *"--label"* ]]; then
      all="$*"; want="${all#*--label }"; want="${want%% *}"
      [[ -n "${CANARY_FAIL:-}" ]] && { echo '[]'; exit 0; }
      ids="$(grep -F " $want" "$STUB_LABELS" 2>/dev/null | cut -d' ' -f1 | sort -u)"
      printf '['; f=1; for i in $ids; do [[ $f -eq 1 ]] || printf ','; f=0; printf '{"id":"%s","status":"idle"}' "$i"; done; echo ']'
    else
      echo '[{"id":"A1","status":"running"},{"id":"A2","status":"idle"},{"id":"A3","status":"idle"},{"id":"A4","status":"idle"},{"id":"A5","status":"running"}]'
    fi;;
esac
exit 0
S
chmod +x "$T/paseo"
unset PASEO_HOME; export PASEO_BIN="$T/paseo" STUB_LOG="$T/calls.log" STUB_LABELS="$T/labels.txt"

mkstate() { # dir
  rm -rf "$1"; mkdir -p "$1/state"
  cat >"$1/state/fleet.json" <<'J'
{"tasks":[
 {"id":"run-a","intent":"Build A","shape":"ship","status":"running","agentId":"A5","project":"p1","notes":"going well","provider":"claude/sonnet","workspaceId":"/w/a","lastEvent":"2026-10-20T10:00:00Z","preview":{"port":4000,"pid":7},"asks":[]},
 {"id":"nc-draft","intent":"Pick","shape":"scout","status":"needs-captain","agentId":"A2","project":"p1","notes":"Which flavour do you want?","lastEvent":"2026-10-20T11:00:00Z","asks":[]},
 {"id":"nc-running","intent":"Stale","shape":"scout","status":"needs-captain","agentId":"A1","project":"p1","notes":"old","lastEvent":"2026-10-20T11:00:00Z","asks":[]},
 {"id":"nc-ask","intent":"Ask","shape":"scout","status":"needs-captain","project":"p2","lastEvent":"2026-10-20T12:00:00Z","asks":[{"text":"A or B?","since":"2026-10-20T12:00:00Z"}]},
 {"id":"q-b","intent":"Later","shape":"ship","status":"queued","depends_on":["run-a"],"lastEvent":"2026-10-20T09:00:00Z"},
 {"id":"blk","intent":"Wait","shape":"ship","status":"blocked","blocked_on":"legal","lastEvent":"2026-10-20T09:00:00Z"},
 {"id":"fin","intent":"Done","shape":"ship","status":"done","agentId":"A3","project":"p1","pr":"https://x/1","branch":"crew/fin","lastEvent":"2026-10-19T09:00:00Z"}
]}
J
  cat >"$1/state/fleet-archive.jsonl" <<'J'
{"id":"old-1","intent":"x","shape":"scout","status":"done","agentId":"A4","project":"p1","lastEvent":"2026-10-01T00:00:00Z"}
{"id":"old-2","intent":"x","shape":"ship","status":"done","agentId":"A3","lastEvent":"2026-10-02T00:00:00Z"}
garbage line
J
}

# ---- dry run changes nothing
mkstate "$T/d"; before="$(cat "$T/d/state/fleet.json")"; : >"$STUB_LABELS"; : >"$STUB_LOG"
out="$("$M" --state "$T/d/state" 2>&1)"; rc=$?
eq "$rc" 0 "dry run succeeds"
eq "$(cat "$T/d/state/fleet.json")" "$before" "dry run leaves fleet.json byte-identical"
[[ ! -d "$T/d/state/backup" && ! -d "$T/d/state/tasks" ]] && ok "dry run writes no backup and no task folder" || bad "dry run wrote files"
grep -q "agent update" "$T/calls.log" && bad "dry run wrote a label" || ok "dry run writes no label"
grep -q "labels to write: 5 agents" <<<"$out" && ok "plan: 3 agents get labels (A1, A2, A3 live; A4 archived... A3 also reused)" || bad "plan agent count" "$out"
grep -q "reused A3: tasks old-2, fin -> labelled fin" <<<"$out" && ok "plan: a reused agent goes to its live task and lists the others" || bad "reused agent" "$out"
grep -q "draft asks (needs-captain with no open ask): 1" <<<"$out" && grep -q "nc-draft" <<<"$out" && ok "plan: a needs-captain task with no ask and no running agent gets a draft ask" || bad "draft asks" "$out"
grep -q "nc-running: needs-captain -> active   Needs you -> Running" <<<"$out" && ok "stage diff: needs-captain with a running agent -> Running (the old bug)" || bad "stage diff" "$out"
"$M" --state "$T/d/state" --no-daemon >/dev/null 2>&1; eq "$?" 0 "--no-daemon dry run works without the daemon"
"$M" --state "$T/d/state" --apply --no-daemon >/dev/null 2>&1; [[ $? -ne 0 ]] && ok "--apply refuses --no-daemon" || bad "apply with no-daemon"

# ---- canary failure leaves the registry alone
mkstate "$T/c"; before="$(cat "$T/c/state/fleet.json")"; : >"$STUB_LABELS"
CANARY_FAIL=1 "$M" --state "$T/c/state" --apply >"$T/c.out" 2>&1; rc=$?
[[ $rc -ne 0 ]] && grep -q "canary failed" "$T/c.out" && ok "a failed canary aborts" || bad "canary abort" "$(cat "$T/c.out")"
eq "$(cat "$T/c/state/fleet.json")" "$before" "...and fleet.json is untouched"

# ---- apply
mkstate "$T/a"; : >"$STUB_LABELS"; : >"$STUB_LOG"
"$M" --state "$T/a/state" --apply >"$T/a.out" 2>&1; rc=$?
[[ $rc -eq 0 ]] || tail -5 "$T/a.out" >&2; eq "$rc" 0 "apply succeeds"
F="$T/a/state/fleet.json"
eq "$(jq -r .version "$F")" 2 "fleet.json is version 2"
eq "$(jq -c '[.tasks[] | [.id, .state]]' "$F")" '[["run-a","active"],["nc-draft","active"],["nc-running","active"],["nc-ask","active"],["q-b","queued"],["blk","blocked"],["fin","done"]]' "status mapped to state"
eq "$(jq -r '[.tasks[] | keys[]] | unique | map(select(. == "status" or . == "agentId" or . == "workspaceId" or . == "lastEvent" or . == "notes" or . == "preview" or . == "provider")) | length' "$F")" 0 "no run-state key survives"
eq "$(jq -r '.tasks[0].since' "$F")" 2026-10-20T10:00:00Z "since = lastEvent"
eq "$(jq -c '.tasks[0].agents' "$F")" '["A5"]' "the old agentId is kept in agents[] (archive history)"
eq "$(jq -r '.tasks[5].blocked_on' "$F")" legal "blocked_on kept on a blocked task"
eq "$(jq -c '[.tasks[1].asks[0].id, (.tasks[1].asks[0].text | startswith("[draft"))]' "$F")" '["a1",true]' "the draft ask is a1 and marked as a draft"
eq "$(jq -c '.tasks[2].asks' "$F")" '[]' "a needs-captain task whose agent is running gets no draft ask"
eq "$(jq -c '.tasks[3].asks | length' "$F")" 1 "an existing ask is kept"
eq "$(jq -r '.tasks[3].asks[0].id' "$F")" a1 "...and gets its id"
grep -q "migrated notes: going well" "$T/a/state/tasks/run-a/log.md" && grep -q "migrated: provider=claude/sonnet agentId=A5 workspaceId=/w/a" "$T/a/state/tasks/run-a/log.md" && ok "notes and provider/agentId/workspaceId go to the task log" || bad "log lines" "$(cat "$T/a/state/tasks/run-a/log.md")"
eq "$(tail -n1 "$T/a/state/tasks/q-b/log.md" | cut -d' ' -f2-)" "migrated v2" "every task log ends with 'migrated v2'"
eq "$(jq -c . "$T/a/state/tasks/run-a/preview.json")" '{"port":4000,"pid":7}' "preview moves to tasks/<id>/preview.json"
ls "$T/a/state/backup"/fleet.v1.*.json >/dev/null 2>&1 && ls "$T/a/state/backup"/fleet-archive.*.jsonl >/dev/null 2>&1 && ok "backups of fleet.json and the archive" || bad "backups"
eq "$(jq -c '.tasks | length' "$T/a/state/backup"/fleet.v1.*.json)" "$(jq -c '.tasks | length' "$T/a/state/backup"/fleet.v1.*.json | head -1)" "backup is readable JSON"
eq "$(jq 'has("version")' "$T/a/state/backup"/fleet.v1.*.json)" false "...and is the v1 file"
labels="$(sort -u "$T/labels.txt")"
grep -qx "A5 fm.task=run-a" <<<"$labels" && grep -qx "A5 fm.shape=ship" <<<"$labels" && ok "labels written for the running agent (A5 -> run-a)" || bad "A5 labels" "$labels"
grep -qx "A3 fm.task=fin" <<<"$labels" && grep -qx "A3 fm.project=p1" <<<"$labels" && grep -qx "A3 fm.shape=ship" <<<"$labels" && ok "A3 (reused) is labelled with its live task: task, project and shape" || bad "A3 labels" "$labels"
grep -qx "A4 fm.task=old-1" <<<"$labels" && ok "an archived task's agent is labelled too (A4 -> old-1)" || bad "A4 label" "$labels"
head -1 "$T/calls.log" | grep -q "^ls -a -g --json" && ok "the daemon is asked first" || bad "daemon first" "$(head -2 "$T/calls.log")"
export FLEET_FILE="$F"
"$HERE/bin/fleet" set q-b title="after" >/dev/null 2>&1; eq "$?" 0 "bin/fleet accepts writes on the migrated file"
"$HERE/bin/fleet" get run-a | jq -e '.state == "active"' >/dev/null; eq "$?" 0 "bin/fleet get reads it"
unset FLEET_FILE
"$M" --state "$T/a/state" >/dev/null 2>&1; [[ $? -ne 0 ]] && ok "a second run on a v2 file refuses" || bad "second run"

echo "---- $pass passed, $fail failed"
[[ $fail -eq 0 ]]
