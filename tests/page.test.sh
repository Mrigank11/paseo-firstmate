#!/usr/bin/env bash
# Tests for bin/page. Needs bash, jq, node. Uses a temp FIRSTMATE_ROOT and fake lavish-axi / paseo on PATH.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
P="$HERE/bin/page"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/fakebin" "$T/root/state"
export FIRSTMATE_ROOT="$T/root"
export FAKE_LOG="$T/fake.log"
export FAKE_PLUGIN_STATUS=running
export PASEO_AGENT_ID=agent-fm-1
export PAGE_VERIFY_SECS=3 PAGE_INSTALL_WAIT=6
unset PASEO_HOME LAVISH_AXI_PORT LAVISH_AXI_STATE_DIR FIRSTMATE_LABEL
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1 ${2:-}"; fail=$((fail+1)); }
eq()  { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3" "(got '$1', want '$2')"; fi; }

cat >"$T/fakebin/lavish-axi" <<'F'
#!/usr/bin/env bash
echo "lavish-axi $* port=${LAVISH_AXI_PORT:-} sdir=${LAVISH_AXI_STATE_DIR:-}" >>"$FAKE_LOG"
case "$1" in
  reply) cat >>"$FAKE_LOG"; echo >>"$FAKE_LOG"; echo "status: sent" ;;
  *) printf 'session:\n  file: %s\n  url: "http://fake.test:4390/session/abc123"\n  status: opened\nnext_step: "run poll"\n' "$1" ;;
esac
F
cat >"$T/fakebin/paseo" <<'F'
#!/usr/bin/env bash
echo "paseo $*" >>"$FAKE_LOG"
case "$1 $2" in
  "plugin ls")
    if [[ -n "${FAKE_PLUGINS_DISABLED:-}" ]]; then echo "error: plugins are disabled" >&2; exit 1; fi
    case "${FAKE_PLUGIN_STATUS:-running}" in
      missing) echo '[{"id":"other","status":"running"}]' ;;
      installable) if [[ -f "$FAKE_INSTALLED" ]]; then echo '[{"id":"firstmate-deck","status":"running"}]'; else echo '[]'; fi ;;
      *) printf '[{"id":"other","status":"running"},{"id":"firstmate-deck","status":"%s"}]\n' "$FAKE_PLUGIN_STATUS" ;;
    esac ;;
  "plugin install") if [[ -n "${FAKE_PLUGINS_DISABLED:-}" ]]; then echo "error: plugins are disabled" >&2; exit 1; fi; : >"$FAKE_INSTALLED" ;;
  "plugin reload") : ;;
  "agent update") : ;;
esac
if [[ "$1" == inspect ]]; then
  case " ${FAKE_UNKNOWN_AGENTS:-} " in *" $2 "*) echo "agent not found: $2" >&2; exit 1 ;; esac
  case " ${FAKE_ARCHIVED_AGENTS:-} " in *" $2 "*) echo '{"Archived":true,"ArchivedAt":"2026-10-21T00:00:00Z"}'; exit 0 ;; esac
  echo '{"Archived":false,"ArchivedAt":null}'; exit 0
fi
if [[ "$1" == ls ]]; then cat "$FAKE_LS" 2>/dev/null || echo '[]'; fi
F
cat >"$T/fakebin/npm" <<'F'
#!/usr/bin/env bash
echo "npm $* (cwd $PWD)" >>"$FAKE_LOG"
F
chmod +x "$T/fakebin/"*
export FAKE_INSTALLED="$T/installed" FAKE_LS="$T/ls.json"
export PATH="$T/fakebin:$PATH"

# A stand-in for the plugin: once bin/page has reset a page to listener=pending, answer like the real plugin would.
sim_plugin() { # project listener pluginRoot lavishPort(json: "4387" | null)
  local f="$T/root/state/projects/$1/page.json"
  (
    for _ in $(seq 1 60); do
      if [[ -f "$f" && "$(jq -r .listener "$f" 2>/dev/null)" == pending ]]; then
        jq --arg l "$2" --arg r "$3" --argjson p "$4" '.listener=$l | .pluginRoot=$r | .lavishPort=$p | .lavishStateDir=null | .listenerDetail=(if $l=="ok" then null else "sim detail" end)' "$f" >"$f.sim" && mv "$f.sim" "$f"
        break
      fi
      sleep 0.1
    done
  ) >/dev/null 2>&1 &
  SIM=$!
}
go() { # start a page with a plugin stand-in that answers ok
  local p="$1"; shift
  sim_plugin "$p" ok "$T/root" null
  "$P" start "$p" "$@" 2>>"$T/go.err"; local rc=$?
  end_sim; return $rc
}
end_sim() { kill "$SIM" 2>/dev/null; wait "$SIM" 2>/dev/null; true; }

# ---- start: scaffold + render + open + page.json ----
out="$(go demo --repo /tmp/some-repo --title "Demo project")"
PROJ="$T/root/state/projects/demo"
eq "$(jq -r .project <<<"$out")" demo "start prints the project"
eq "$(jq -r .url <<<"$out")" "http://fake.test:4390/session/abc123" "start prints the lavish url"
eq "$(jq -r .page <<<"$out")" "$PROJ/page.html" "default page path"
[[ -f "$PROJ/page.html" && -f "$PROJ/page.live.js" ]] && ok "start renders the page and live.js" || bad "start renders the page"
eq "$(jq -c '[.title,.repo,(.sections|length)]' "$PROJ/project.json")" '["Demo project","/tmp/some-repo",5]' "project.json scaffolded"
for s in endpoints flags code decisions how; do [[ -s "$PROJ/sections/$s.md" ]] || bad "stub $s"; done; ok "five section stubs"
eq "$(jq -r '[.session,.lavishUrl]|join(" ")' "$PROJ/page.json")" "open http://fake.test:4390/session/abc123" "page.json session open + url"
grep -q "Demo project" "$PROJ/page.html" && ok "page title rendered" || bad "page title rendered"

# ---- idempotent: sections and edits survive, no reopen flag ----
echo "- my note" >>"$PROJ/sections/flags.md"
: >"$FAKE_LOG"
go demo >/dev/null
grep -q "my note" "$PROJ/sections/flags.md" && ok "second start keeps section edits" || bad "second start keeps section edits"
eq "$(jq -r .title "$PROJ/project.json")" "Demo project" "second start keeps the title"
grep -q -- "--reopen" "$FAKE_LOG" && bad "no --reopen unless asked" || ok "no --reopen unless asked"
go demo --reopen >/dev/null
grep -q -- "--reopen" "$FAKE_LOG" && ok "--reopen is passed through" || bad "--reopen is passed through"

# ---- custom page path ----
go other --page "$T/elsewhere/other.html" >/dev/null
[[ -f "$T/elsewhere/other.html" ]] && ok "--page renders to the given path" || bad "--page renders to the given path"
eq "$(jq -r .page "$T/root/state/projects/other/project.json")" "$T/elsewhere/other.html" "--page recorded in project.json"
go Bad_Name >/dev/null 2>&1 && bad "bad slug refused" || ok "bad slug refused"
go rel --page relative.html >/dev/null 2>&1 && bad "relative --page refused" || ok "relative --page refused"

# ---- note ----
"$P" note demo decisions "Use Lavish polling" >/dev/null
grep -qE -- '^- [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} Use Lavish polling$' "$PROJ/sections/decisions.md" && ok "note appends a dated line" || bad "note appends a dated line"
"$P" note demo newsec "fresh" >/dev/null
grep -q "fresh" "$PROJ/sections/newsec.md" && ok "note creates the section file" || bad "note creates the section file"
"$P" note nope how "x" >/dev/null 2>&1 && bad "note on unknown project fails" || ok "note on unknown project fails"

# ---- reply marks delivered, unanswered comments answered ----
now=2026-10-21T10:00:00Z
{
  echo '{"id":"c1","at":"'$now'","project":"demo","target":"page","text":"one","prompt":{},"delivered":true,"answered":false}'
  echo '{"id":"c2","at":"'$now'","project":"demo","target":"endpoints","text":"two","prompt":{},"delivered":false,"answered":false}'
  echo '{"id":"c3","at":"'$now'","project":"demo","target":"t-x","text":"three","prompt":{},"delivered":true,"answered":true}'
} >"$PROJ/inbox.jsonl"
: >"$FAKE_LOG"
msg="$("$P" reply demo "Done, see the new row")"
grep -q "lavish-axi reply $PROJ/page.html --agent-reply-file -" "$FAKE_LOG" && ok "reply calls lavish-axi reply with the file on stdin" || bad "reply calls lavish-axi reply"
grep -q "Done, see the new row" "$FAKE_LOG" && ok "reply text reaches lavish" || bad "reply text reaches lavish"
eq "$(jq -r '[.id,.delivered,.answered]|join(":")' "$PROJ/inbox.jsonl" | paste -sd' ')" "c1:true:true c2:false:false c3:true:true" "only delivered comments are marked answered"
eq "$(wc -l <"$PROJ/inbox.jsonl")" 3 "inbox keeps every line"
grep -q "1 comment" <<<"$msg" && ok "reply reports the count" || bad "reply reports the count" "$msg"
printf 'from stdin\nsecond line' | "$P" reply demo - >/dev/null
grep -q "second line" "$FAKE_LOG" && ok "reply - reads stdin" || bad "reply - reads stdin"
"$P" reply nope "x" >/dev/null 2>&1 && bad "reply to unknown project fails" || ok "reply to unknown project fails"

# ---- status: listener, banner, last render, the plugin's root, undelivered ----
jq '.lastRender=(now-45|todate) | .banner="First mate unreachable, 1 comment queued" | .listener="ok" | .pluginRoot=$r' --arg r "$T/root" "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
st="$("$P" status)"
grep -q "^PROJECT" <<<"$st" && ok "status has a header" || bad "status has a header"
for col in LISTENER BANNER RENDERED "PLUGIN ROOT" UNDELIVERED; do grep -q "$col" <<<"$st" && ok "status column $col" || bad "status column $col" "$st"; done
grep -E "^demo +open +ok +First mate unreachable, 1 comment queued +[0-9]+s ago +$T/root +1 +- +running +http://fake.test:4390/session/abc123" <<<"$st" >/dev/null && ok "status row: session, listener, banner, age, root, undelivered, plugin, url" || bad "status row" "$st"
grep -q "^other" <<<"$st" && ok "status lists every project" || bad "status lists every project"
eq "$("$P" status demo | wc -l)" 2 "status <project> shows one row"
jq '.pluginRoot="/somewhere/else"' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
"$P" status demo | grep -q "/somewhere/else (NOT this checkout)" && ok "status flags a plugin root that is not this checkout" || bad "status flags a foreign plugin root"

# ---- heal ----
: >"$FAKE_LOG"
"$P" heal | grep -q "nothing to do" && ok "heal leaves a running plugin alone" || bad "heal leaves a running plugin alone"
grep -q "plugin reload" "$FAKE_LOG" && bad "no reload when running" || ok "no reload when running"
FAKE_PLUGIN_STATUS=failed "$P" heal | grep -q "reloaded" && ok "heal reports the reload" || bad "heal reports the reload"
grep -q "paseo plugin reload firstmate-deck" "$FAKE_LOG" && ok "heal reloads a failed plugin" || bad "heal reloads a failed plugin"
PASEO_HOME=/x/home FAKE_PLUGIN_STATUS=failed "$P" heal >/dev/null
grep -q "plugin reload firstmate-deck --home /x/home" "$FAKE_LOG" && ok "heal pins --home to PASEO_HOME" || bad "heal pins --home"
jq '.session="open" | .lastRender=(now-600|todate)' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
: >"$FAKE_LOG"
"$P" heal | grep -q "had not rendered for over 120s (demo)" && ok "heal reloads a running plugin that stopped rendering an open page" || bad "heal stalled plugin"
grep -q "plugin reload firstmate-deck" "$FAKE_LOG" && ok "...with a real reload" || bad "stalled heal reloads"
jq '.lastRender=(now-5|todate)' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
"$P" heal | grep -q "nothing to do" && ok "a recently rendered page is not stalled" || bad "fresh render is not stalled"
FAKE_PLUGIN_STATUS=missing "$P" heal | grep -q "bin/page install" && ok "heal points a missing plugin at install" || bad "heal missing"

# ---- render ----
"$P" render demo --out "$T/out.html" >/dev/null
[[ -f "$T/out.html" ]] && ok "render --out" || bad "render --out"

# ---- claim ----
rm -f "$T/root/state/firstmate.json"
msg="$(PASEO_AGENT_ID= "$P" claim 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "PASEO_AGENT_ID is empty" <<<"$msg" && ok "claim refuses without PASEO_AGENT_ID, with a clear message" || bad "claim refuses without PASEO_AGENT_ID" "$msg"
[[ ! -e "$T/root/state/firstmate.json" ]] && ok "...and writes nothing" || bad "refused claim wrote a file"
: >"$FAKE_LOG"
msg="$(PASEO_AGENT_ID=agent-elsewhere FAKE_UNKNOWN_AGENTS=agent-elsewhere "$P" claim 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "is not on this Paseo daemon" <<<"$msg" && ok "claim refuses an agent that is not on this daemon" || bad "claim refuses a foreign agent" "$msg"
[[ ! -e "$T/root/state/firstmate.json" ]] && ! grep -q "agent update" "$FAKE_LOG" && ok "...and neither writes a claim nor touches any label" || bad "foreign claim had side effects"
msg="$(PASEO_AGENT_ID=agent-old FAKE_ARCHIVED_AGENTS=agent-old "$P" claim 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "is archived" <<<"$msg" && ok "claim refuses an archived agent" || bad "claim refuses an archived agent" "$msg"
echo '[{"id":"agent-fm-1","status":"idle"},{"id":"old-fm","status":"idle"},{"id":"older-fm","status":"closed"}]' >"$FAKE_LS"
: >"$FAKE_LOG"
"$P" claim >/dev/null
eq "$(jq -r .agentId "$T/root/state/firstmate.json")" agent-fm-1 "claim writes state/firstmate.json with the caller's agent id"
eq "$(jq -r '.claimedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")' "$T/root/state/firstmate.json")" true "claim records claimedAt"
ls "$T/root/state/" | grep -q 'firstmate.json.' && bad "no temp file left behind" || ok "no temp file left behind"
grep -q "paseo agent update agent-fm-1 --label firstmate=true" "$FAKE_LOG" && ok "claim labels the caller" || bad "claim labels the caller"
grep -q "paseo agent update old-fm --label firstmate=superseded" "$FAKE_LOG" && grep -q "paseo agent update older-fm --label firstmate=superseded" "$FAKE_LOG" && ok "claim demotes every other labelled agent" || bad "claim demotes the others"
grep -q "agent update agent-fm-1 --label firstmate=superseded" "$FAKE_LOG" && bad "claim never demotes itself" || ok "claim never demotes itself"
PASEO_AGENT_ID=agent-fm-2 "$P" claim >/dev/null
eq "$(jq -r .agentId "$T/root/state/firstmate.json")" agent-fm-2 "a later claim replaces the earlier one"
PASEO_AGENT_ID=agent-fm-1 "$P" claim >/dev/null
rm -f "$FAKE_LS"

# ---- start claims first ----
rm -f "$T/root/state/firstmate.json"
PASEO_AGENT_ID=agent-fm-9 go claimdemo >/dev/null
eq "$(jq -r .agentId "$T/root/state/firstmate.json")" agent-fm-9 "start claims first"
rm -f "$T/root/state/firstmate.json"
PASEO_AGENT_ID= go refused >/dev/null 2>&1 && bad "start without PASEO_AGENT_ID refused" || ok "start without PASEO_AGENT_ID refused"
[[ ! -d "$T/root/state/projects/refused" ]] && ok "...before scaffolding anything" || bad "refused start scaffolded"

# ---- crew can never become the first mate (C2) ----
cp "$T/root/state/fleet.json" "$T/fleet.keep" 2>/dev/null || true
cat >"$T/root/state/fleet.json" <<'J'
{"tasks":[{"id":"scout-1","intent":"x","shape":"scout","status":"running","agentId":"crew-9"}]}
J
echo '{"id":"old-crew","intent":"x","shape":"ship","status":"done","agentId":"crew-archived"}' >"$T/root/state/fleet-archive.jsonl"
echo '{"agentId":"agent-fm-1","claimedAt":"2026-10-21T00:00:00Z"}' >"$T/root/state/firstmate.json"
: >"$FAKE_LOG"
msg="$(PASEO_AGENT_ID=crew-9 "$P" claim 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "agent crew-9 is crew on task scout-1; only the first mate may claim" <<<"$msg" && ok "claim refuses an agent that is crew on a live task" || bad "claim refuses live crew" "$msg"
eq "$(jq -r .agentId "$T/root/state/firstmate.json")" agent-fm-1 "...the real claim is untouched"
grep -q "agent update" "$FAKE_LOG" && bad "...and no label is touched" || ok "...and no label is touched"
msg="$(PASEO_AGENT_ID=crew-archived "$P" claim 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "is crew on task old-crew" <<<"$msg" && ok "claim refuses an agent that is crew in the archive" || bad "claim refuses archived crew" "$msg"
printf '{garbage\n{"id":"old-crew2","agentId":"crew-after-garbage"}\n' >"$T/root/state/fleet-archive.jsonl"
msg="$(PASEO_AGENT_ID=crew-after-garbage "$P" claim 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "is crew on task old-crew2" <<<"$msg" && ok "...a malformed archive line does not hide later crew" || bad "archive with a bad line" "$msg"
rm -f "$T/root/state/firstmate.json"
PASEO_AGENT_ID=crew-9 go claimcrew >/dev/null 2>&1 && bad "start by a crew agent with no live claim is refused" || ok "start by a crew agent with no live claim is refused"
rm -f "$T/root/state/fleet-archive.jsonl"

# ---- start does not steal a live claim ----
echo '{"agentId":"agent-fm-1","claimedAt":"2026-10-21T00:00:00Z"}' >"$T/root/state/firstmate.json"
sim_plugin stealdemo ok "$T/root" null
msg="$(PASEO_AGENT_ID=agent-fm-2 "$P" start stealdemo 2>&1 >"$T/vout")"; rc=$?; end_sim
eq "$rc" 0 "start by a second session still opens the page"
eq "$(jq -r .agentId "$T/root/state/firstmate.json")" agent-fm-1 "...but does NOT steal the claim from a live first mate"
grep -q "warning: agent agent-fm-1 is the live first mate of this checkout; start did NOT take over the claim" <<<"$msg" && ok "...and warns, naming the holder" || bad "start warns about the holder" "$msg"
PASEO_AGENT_ID=agent-fm-2 "$P" claim >/dev/null 2>&1
eq "$(jq -r .agentId "$T/root/state/firstmate.json")" agent-fm-2 "an explicit bin/page claim does take over"
FAKE_UNKNOWN_AGENTS=agent-fm-2 sim_plugin stealdemo ok "$T/root" null
FAKE_UNKNOWN_AGENTS=agent-fm-2 PASEO_AGENT_ID=agent-fm-3 "$P" start stealdemo >/dev/null 2>&1; end_sim
eq "$(jq -r .agentId "$T/root/state/firstmate.json")" agent-fm-3 "start claims when the held claim is not a live agent any more"
sim_plugin stealdemo ok "$T/root" null
PASEO_AGENT_ID=agent-fm-3 "$P" start stealdemo >/dev/null 2>&1; end_sim
eq "$(jq -r .agentId "$T/root/state/firstmate.json")" agent-fm-3 "start by the claim holder keeps the claim"
cp "$T/fleet.keep" "$T/root/state/fleet.json" 2>/dev/null || rm -f "$T/root/state/fleet.json"
PASEO_AGENT_ID=agent-fm-1 "$P" claim >/dev/null 2>&1

# ---- start verifies the plugin is polling this page ----
vstart() { # label rc-want message-grep  (plugin stand-in args follow)
  local label="$1" want="$2" pat="$3"; shift 3
  sim_plugin "$@"
  local err; err="$("$P" start "$1" 2>&1 >"$T/vout")"; local rc=$?
  end_sim
  if [[ $rc -eq $want ]] && { [[ $want -eq 0 ]] || grep -qE "$pat" <<<"$err"; } && { [[ $want -eq 0 ]] || [[ ! -s "$T/vout" ]]; }; then ok "$label"; else bad "$label" "(rc=$rc, stdout='$(cat "$T/vout")', stderr='$err')"; fi
}
export FAKE_PLUGIN_STATUS=running
vstart "start: plugin polling this root -> success" 0 "" vdemo ok "$T/root" null
eq "$(jq -r .url "$T/vout")" "http://fake.test:4390/session/abc123" "start prints the url only on success"
FAKE_PLUGIN_STATUS=missing vstart "start: plugin missing" 3 "not installed on this Paseo daemon: run bin/page install" vmiss2 pending "" null
FAKE_PLUGIN_STATUS=failed vstart "start: plugin failed -> exit 3, points at heal" 3 "'failed', not running: run bin/page heal" vfail pending "" null
vstart "start: plugin root is another checkout -> root mismatch" 3 "root mismatch: the plugin is configured for /other/checkout but this checkout is" vroot ok /other/checkout null
vstart "start: listener error -> reported with the detail" 3 "Lavish listener is 'error' \(sim detail\)" verr error "$T/root" null
vstart "start: listener held elsewhere -> reported" 3 "'active-elsewhere'" vact active-elsewhere "$T/root" null
vstart "start: plugin running but never answers -> says so" 3 "running but has not picked this page up" vsilent pending "" null
vstart "start: plugin polls another Lavish port -> mismatch, rerun hint" 3 "Lavish config mismatch: the plugin polls port '4555'" vport ok "$T/root" '"4555"'
unset FAKE_PLUGIN_STATUS; export FAKE_PLUGIN_STATUS=running

# ---- start on a session the captain ended ----
jq '.session="ended"' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
: >"$FAKE_LOG"
msg="$("$P" start demo 2>&1)"; rc=$?
eq "$rc" 2 "start on an ended session without --reopen exits 2"
grep -q "the captain ended this page's session; pass --reopen only if the captain asked" <<<"$msg" && ok "...with the explanation" || bad "ended-session message" "$msg"
grep -q "lavish-axi" "$FAKE_LOG" && bad "...and never touches Lavish" || ok "...and never touches Lavish"
go demo --reopen >/dev/null && ok "--reopen on an ended session proceeds" || bad "--reopen proceeds"
eq "$(jq -r .session "$PROJ/page.json")" open "...and reopens it"

# ---- reply --followup ----
mkdir -p "$T/root/state"
cat >"$T/root/state/fleet.json" <<'J'
{"tasks":[{"id":"pick-db","intent":"x","shape":"scout","status":"needs-captain","project":"demo","asks":[{"text":"A or B?","since":"2026-10-21T09:00:00Z"},{"text":"Flag?","since":"2026-10-21T09:00:00Z"}]},
{"id":"other-t","intent":"y","shape":"scout","status":"queued","project":"demo","asks":[{"text":"Q?","since":"2026-10-21T09:00:00Z"}]}]}
J
echo '{"id":"c9","at":"2026-10-21T10:00:00Z","project":"demo","target":"t-pick-db#a1","text":"more detail please","prompt":{},"delivered":true,"answered":false}' >"$PROJ/inbox.jsonl"
out="$("$P" reply demo "Looking into it" --followup pick-db:1 --followup other-t:1 2>&1)"
eq "$(jq -r '[.tasks[0].asks[0] | has("pendingSince")] | .[0]' "$T/root/state/fleet.json")" true "reply --followup marks the ask pending"
eq "$(jq -c '[.tasks[0].asks[1] | has("pendingSince")][0], [.tasks[1].asks[0] | has("pendingSince")][0]' "$T/root/state/fleet.json" | paste -sd' ')" "false true" "...only the named asks, and it is repeatable"
grep -q "pending: pick-db:1 other-t:1" <<<"$out" && ok "reply reports the pending asks" || bad "reply reports the pending asks" "$out"
eq "$(jq -r .answered "$PROJ/inbox.jsonl")" true "...and still marks the comment answered"
cp "$T/root/state/fleet.json" "$T/fleet.before"
"$P" reply demo "x" --followup pick-db:9 >/dev/null 2>&1 && bad "followup to a missing ask refused" || ok "followup to a missing ask refused"
"$P" reply demo "x" --followup nonsense >/dev/null 2>&1 && bad "malformed --followup refused" || ok "malformed --followup refused"
"$P" reply demo "x" --followup nope:1 >/dev/null 2>&1 && bad "followup to an unknown task refused" || ok "followup to an unknown task refused"
cmp -s "$T/root/state/fleet.json" "$T/fleet.before" && ok "refused follow-ups change nothing" || bad "refused follow-ups changed fleet.json"
: >"$FAKE_LOG"
"$P" reply demo "bad" --followup 'x y' >/dev/null 2>&1
grep -q "lavish-axi reply" "$FAKE_LOG" && bad "a bad --followup is refused before anything is sent" || ok "a bad --followup is refused before anything is sent"
printf 'md body\n' | "$P" reply demo - --followup pick-db:2 >/dev/null
eq "$(jq -r '.tasks[0].asks[1] | has("pendingSince")' "$T/root/state/fleet.json")" true "reply - (stdin) takes --followup too"

# ---- reply applies option picks (stable ask ids) ----
cat >"$T/root/state/fleet.json" <<'J'
{"tasks":[{"id":"pick","intent":"x","shape":"scout","status":"needs-captain","project":"demo","asks":[
 {"id":"a1","text":"DB?","since":"2026-10-21T09:00:00Z","options":["Postgres","SQLite"]},
 {"id":"a2","text":"CI?","since":"2026-10-21T09:00:00Z","options":["Buildkite","Actions"]},
 {"id":"a3","text":"Region?","since":"2026-10-21T09:00:00Z","options":["eu","us"]}]}]}
J
cat >"$PROJ/inbox.jsonl" <<'J'
{"id":"k1","at":"2026-10-21T10:00:00Z","project":"demo","target":"t-pick#a2","text":"Picked: Buildkite","prompt":{},"delivered":true,"answered":false,"choice":{"task":"pick","ask":"a2","option":"Buildkite"}}
{"id":"k2","at":"2026-10-21T10:00:01Z","project":"demo","target":"t-pick#a3","text":"Picked: eu","prompt":{},"delivered":true,"answered":false,"choice":{"task":"pick","ask":"a3","option":"eu"}}
{"id":"k3","at":"2026-10-21T10:00:02Z","project":"demo","target":"t-pick#a9","text":"Picked: x","prompt":{},"delivered":true,"answered":false,"stale":true,"choice":{"task":"pick","ask":"a9","option":"x"}}
{"id":"k4","at":"2026-10-21T10:00:03Z","project":"demo","target":"t-pick#a1","text":"Picked: SQLite","prompt":{},"delivered":false,"answered":false,"choice":{"task":"pick","ask":"a1","option":"SQLite"}}
J
out="$("$P" reply demo "Going with Buildkite and eu" --keep-open pick#a3 2>&1)"
eq "$(jq -c '[.tasks[0].asks[].id]' "$T/root/state/fleet.json")" '["a1","a3"]' "reply applies the delivered pick on a2 by its stable id (a1, a3 stay)"
grep -q "applied option picks: pick#a2" <<<"$out" && ok "...and reports what it applied" || bad "reply reports applied picks" "$out"
eq "$(jq -r 'select(.id=="k2") | .answered' "$PROJ/inbox.jsonl")" true "--keep-open keeps the ask a3 open but still answers its comment"
eq "$(jq -r 'select(.id=="k4") | .answered' "$PROJ/inbox.jsonl")" false "an undelivered pick is neither applied nor answered"
cat >"$T/root/state/fleet.json" <<'J'
{"tasks":[{"id":"pick","intent":"x","shape":"scout","status":"needs-captain","project":"demo","asks":[
 {"id":"a1","text":"DB?","since":"2026-10-21T09:00:00Z","options":["Postgres","SQLite"]}]}]}
J
cp "$T/root/state/fleet.json" "$T/fleet.before"
echo '{"id":"k5","at":"2026-10-21T10:00:03Z","project":"demo","target":"t-pick#a7","text":"Picked: x","prompt":{},"delivered":true,"answered":false,"stale":true,"choice":{"task":"pick","ask":"a7","option":"x"}}' >"$PROJ/inbox.jsonl"
"$P" reply demo "ack" >/dev/null 2>&1
cmp -s "$T/root/state/fleet.json" "$T/fleet.before" && ok "a stale pick is never applied" || bad "stale pick applied"
printf '%s\n' '{"id":"k6","at":"2026-10-21T10:00:00Z","project":"demo","target":"t-pick#a1","text":"Picked: Postgres","prompt":{},"delivered":true,"answered":false,"choice":{"task":"pick","ask":"a1","option":"Postgres"}}' '{"id":"k7","at":"2026-10-21T10:00:01Z","project":"demo","target":"t-pick#a1","text":"Picked: SQLite","prompt":{},"delivered":true,"answered":false,"choice":{"task":"pick","ask":"a1","option":"SQLite"}}' >"$PROJ/inbox.jsonl"
"$P" reply demo "double click" >/dev/null 2>&1; rc=$?
eq "$rc" 0 "two picks on one ask: the second does not fail the reply"
eq "$(jq -c '.tasks[0].asks' "$T/root/state/fleet.json")" '[]' "...and the ask is answered once"
cat >"$T/root/state/fleet.json" <<'J'
{"tasks":[{"id":"pick","intent":"x","shape":"scout","status":"needs-captain","project":"demo","asks":[{"id":"a1","text":"DB?","since":"2026-10-21T09:00:00Z"},{"id":"a2","text":"CI?","since":"2026-10-21T09:00:00Z"}]}]}
J
echo '{"id":"k8","at":"2026-10-21T10:00:00Z","project":"demo","target":"t-pick#a1","text":"Picked: A","prompt":{},"delivered":true,"answered":false,"choice":{"task":"pick","ask":"a1","option":"A"}}' >"$PROJ/inbox.jsonl"
"$P" reply demo "need detail" --followup pick:a1 >/dev/null 2>&1
eq "$(jq -c '[.tasks[0].asks[] | [.id, has("pendingSince")]]' "$T/root/state/fleet.json")" '[["a1",true],["a2",false]]' "--followup on a picked ask marks it pending instead of answering it"
"$P" reply demo "x" --keep-open nonsense >/dev/null 2>&1 && bad "malformed --keep-open refused" || ok "malformed --keep-open refused"
# a comment that arrives after the reply started stays unanswered
printf '%s\n' '{"id":"m1","at":"2026-10-21T10:00:00Z","project":"demo","target":"page","text":"early","prompt":{},"delivered":true,"answered":false}' >"$PROJ/inbox.jsonl"
cat >"$T/fakebin/lavish-axi" <<'F'
#!/usr/bin/env bash
echo "lavish-axi $* port=${LAVISH_AXI_PORT:-} sdir=${LAVISH_AXI_STATE_DIR:-}" >>"$FAKE_LOG"
case "$1" in
  reply) cat >>"$FAKE_LOG"; echo >>"$FAKE_LOG"
    if [[ -n "${FAKE_LATE_COMMENT:-}" ]]; then echo '{"id":"m2","at":"2026-10-21T10:00:05Z","project":"demo","target":"page","text":"late","prompt":{},"delivered":true,"answered":false}' >>"$FAKE_LATE_COMMENT"; fi
    echo "status: sent" ;;
  *) printf 'session:\n  file: %s\n  url: "http://fake.test:4390/session/abc123"\n  status: opened\nnext_step: "run poll"\n' "$1" ;;
esac
F
FAKE_LATE_COMMENT="$PROJ/inbox.jsonl" "$P" reply demo "ok" >/dev/null 2>&1
eq "$(jq -r '[.id,.answered]|join(":")' "$PROJ/inbox.jsonl" | paste -sd' ')" "m1:true m2:false" "a comment delivered while the reply goes out is not marked answered"

# ---- status shows a state-file problem; heal does not reload for it (C3) ----
jq '.loadError="fleet.json: file is empty"' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
"$P" status demo | grep -q "state file problem: fleet.json: file is empty" && ok "status shows the loadError" || bad "status shows loadError" "$("$P" status demo)"
jq '.session="open" | .lastRender=(now-600|todate)' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
: >"$FAKE_LOG"
out="$("$P" heal)"
grep -q "state file problem: demo: fleet.json: file is empty" <<<"$out" && ok "heal names the state file problem" || bad "heal names the problem" "$out"
grep -q "plugin reload" "$FAKE_LOG" && bad "heal must NOT reload for a load error" || ok "heal does not reload for a load error, even when the render looks old"
: >"$FAKE_LOG"
FAKE_PLUGIN_STATUS=failed "$P" heal >/dev/null
grep -q "plugin reload" "$FAKE_LOG" && ok "heal still reloads a failed plugin" || bad "heal reloads failed"
jq 'del(.loadError)' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
: >"$FAKE_LOG"; "$P" heal >/dev/null
grep -q "plugin reload" "$FAKE_LOG" && ok "heal reloads a genuinely stalled plugin (no load error)" || bad "heal stalled without loadError"
jq '.lastRender=(now-5|todate)' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"

# ---- status warns about live tasks with no project ----
cat >"$T/root/state/fleet.json" <<J
{"tasks":[{"id":"loose-in-repo","intent":"x","shape":"ship","status":"running","workspaceId":"/tmp/some-repo-wt/feat"},
{"id":"loose-in-repo2","intent":"x","shape":"ship","status":"running","workspaceId":"/tmp/some-repo/sub"},
{"id":"loose-other","intent":"x","shape":"scout","status":"queued"},
{"id":"done-loose","intent":"x","shape":"scout","status":"done"},
{"id":"tagged","intent":"x","shape":"scout","status":"running","project":"demo"}]}
J
w="$("$P" status 2>&1 >/dev/null)"
grep -q "live task loose-in-repo2 has no project, but its workspace is in project demo's repo (/tmp/some-repo): bin/fleet set loose-in-repo2 project=demo" <<<"$w" && ok "status warns about a project-less task whose workspace is in a project's repo" || bad "status repo warning" "$w"
grep -q "1 live task has no project while project pages exist (loose-other)\|2 live tasks have no project while project pages exist (loose-in-repo, loose-other)" <<<"$w" && ok "...and counts the other project-less live tasks" || bad "status generic warning" "$w"
grep -q "done-loose\|tagged" <<<"$w" && bad "done and tagged tasks are not warned about" || ok "done and tagged tasks are not warned about"
rm -f "$T/root/state/fleet.json"

# ---- the plugin's Lavish config wins over env and state/page.env ----
echo 'export LAVISH_AXI_PORT=4999' >"$T/root/state/page.env"
jq 'del(.lavishPort) | del(.lavishStateDir)' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
for f in "$T"/root/state/projects/*/page.json; do jq 'del(.lavishPort) | del(.lavishStateDir)' "$f" >"$f.t" && mv "$f.t" "$f"; done
: >"$FAKE_LOG"; echo '{"id":"c10","at":"2026-10-21T10:00:00Z","project":"demo","target":"page","text":"z","prompt":{},"delivered":true,"answered":false}' >"$PROJ/inbox.jsonl"
"$P" reply demo "env only" >/dev/null
grep -q "lavish-axi reply .* port=4999 " "$FAKE_LOG" && ok "page.env supplies LAVISH_AXI_PORT while the plugin has not said anything" || bad "page.env port" "$(cat "$FAKE_LOG")"
jq '.lavishPort="4555" | .lavishStateDir="/plugin/lavish-state"' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
: >"$FAKE_LOG"; "$P" reply demo "plugin cfg" >/dev/null
grep -q "lavish-axi reply .* port=4555 sdir=/plugin/lavish-state" "$FAKE_LOG" && ok "reply uses the port and state dir the plugin wrote to page.json" || bad "reply uses plugin cfg" "$(cat "$FAKE_LOG")"
: >"$FAKE_LOG"; "$P" reply other "x" >/dev/null 2>&1; true
: >"$FAKE_LOG"; sim_plugin demo ok "$T/root" '"4555"'; jq '.session="open"' "$PROJ/page.json" >"$PROJ/p.tmp" && mv "$PROJ/p.tmp" "$PROJ/page.json"
PAGE_VERIFY_SECS=3 "$P" start demo --reopen >/dev/null 2>&1; end_sim
grep -q "lavish-axi $PROJ/page.html --reopen port=4555 sdir=/plugin/lavish-state" "$FAKE_LOG" && ok "start opens the page on the plugin's Lavish too" || bad "start uses plugin cfg" "$(cat "$FAKE_LOG")"
rm -f "$T/root/state/page.env"

# ---- install ----
export PASEO_HOME="$T/paseo-home"
SETTINGS="$PASEO_HOME/plugin-settings/firstmate-deck/deck.json"
mkdir -p "$(dirname "$SETTINGS")"
echo '{"version":1,"values":{"firstmateLabel":"fm=mine","lavishPort":4400}}' >"$SETTINGS"; chmod 644 "$SETTINGS"
rm -f "$FAKE_INSTALLED"; : >"$FAKE_LOG"
out="$(FAKE_PLUGIN_STATUS=installable "$P" install 2>&1)"; rc=$?
eq "$rc" 0 "install succeeds with fakes"
grep -q "npm ci --omit=dev --no-audit --no-fund (cwd .*plugin/firstmate-deck)" "$FAKE_LOG" && ok "install runs npm ci --omit=dev (runtime dependencies only) in the plugin dir" || bad "install runs npm ci --omit=dev" "$(cat "$FAKE_LOG")"
eq "$(jq -r '.values.firstmateRoot' "$SETTINGS")" "$(cd "$T/root" && pwd -P)" "install writes this checkout's realpath as firstmateRoot"
eq "$(jq -c '[.version, .values.firstmateLabel, .values.lavishPort]' "$SETTINGS")" '[1,"fm=mine",4400]' "...merging, not clobbering, other values"
eq "$(stat -c %a "$SETTINGS")" 600 "...and chmods the settings file 600"
grep -q "paseo plugin install .*plugin/firstmate-deck --home $PASEO_HOME" "$FAKE_LOG" && ok "install installs the plugin directory (pinned to PASEO_HOME)" || bad "install installs" "$(cat "$FAKE_LOG")"
grep -q "plugin reload" "$FAKE_LOG" && bad "no reload on a fresh install" || ok "no reload on a fresh install"
grep -q "firstmate-deck is running" <<<"$out" && grep -q "bin/page claim" <<<"$out" && grep -q "bin/page start" <<<"$out" && ok "install waits for running and prints the next steps" || bad "install next steps" "$out"
: >"$FAKE_LOG"
FAKE_PLUGIN_STATUS=running "$P" install >/dev/null 2>&1
grep -q "paseo plugin reload firstmate-deck --home $PASEO_HOME" "$FAKE_LOG" && ok "an installed plugin is reloaded, not reinstalled" || bad "install reloads" "$(cat "$FAKE_LOG")"
grep -q "plugin install" "$FAKE_LOG" && bad "...no second install" || ok "...no second install"
msg="$(FAKE_PLUGINS_DISABLED=1 "$P" install 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "enable plugins in Paseo Settings → Plugins" <<<"$msg" && ok "install refuses when plugins are disabled, saying how to enable them" || bad "install refuses when plugins are disabled" "$msg"
rm -f "$SETTINGS"
FAKE_PLUGIN_STATUS=running "$P" install >/dev/null 2>&1
eq "$(jq -c '[.version, (.values|keys)]' "$SETTINGS")" '[1,["firstmateRoot"]]' "install creates the settings file when there is none"
echo 'not json' >"$SETTINGS"
msg="$(FAKE_PLUGIN_STATUS=running "$P" install 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && grep -q "not a JSON object" <<<"$msg" && ok "install refuses to overwrite a corrupt settings file" || bad "corrupt settings" "$msg"
eq "$(cat "$SETTINGS")" "not json" "...and leaves it alone"

# install: no lockfile -> npm install --omit=dev; --dev -> the full npm install
mkdir -p "$T/plugin-nolock"; cp "$HERE/plugin/firstmate-deck/paseo-plugin.json" "$HERE/plugin/firstmate-deck/package.json" "$T/plugin-nolock/"
: >"$FAKE_LOG"; PAGE_PLUGIN_DIR="$T/plugin-nolock" FAKE_PLUGIN_STATUS=running "$P" install >/dev/null 2>&1
grep -q "npm install --omit=dev --no-audit --no-fund (cwd $T/plugin-nolock)" "$FAKE_LOG" && ok "install without a lockfile uses npm install --omit=dev" || bad "install without lockfile" "$(cat "$FAKE_LOG")"
: >"$FAKE_LOG"; FAKE_PLUGIN_STATUS=running "$P" install --dev >/dev/null 2>&1
grep -q "npm install --no-audit --no-fund (cwd .*plugin/firstmate-deck)" "$FAKE_LOG" && ! grep -q -- "--omit=dev" "$FAKE_LOG" && ok "install --dev installs the dev dependencies too" || bad "install --dev" "$(cat "$FAKE_LOG")"
"$P" install --bogus >/dev/null 2>&1 && bad "install refuses unknown options" || ok "install refuses unknown options"
unset PASEO_HOME

# ---- section, configure, marks, stop ----
PJD="$T/root/state/projects/demo"
printf '<p>hand <b>written</b></p>\n' >"$T/sec.html"
out="$("$P" section demo notes --html-file "$T/sec.html" 2>&1)"; rc=$?
eq "$rc:$(cat "$PJD/sections/notes.html")" "0:<p>hand <b>written</b></p>" "section writes sections/<name>.html byte for byte"
grep -q unchanged <<<"$("$P" section demo notes --html-file "$T/sec.html" 2>&1)" && ok "...and says unchanged the second time" || bad "section unchanged"
"$P" section demo '../x' --html-file "$T/sec.html" >/dev/null 2>&1 && bad "section refuses a bad name" || ok "section refuses a bad name"
"$P" section nosuch notes --html-file "$T/sec.html" >/dev/null 2>&1 && bad "section refuses an unknown project" || ok "section refuses an unknown project"
"$P" configure demo --json '{"archiveLimit":5,"collapsedSections":["notes"]}' >/dev/null
eq "$(jq -c '[.archiveLimit,.collapsedSections,.title]' "$PJD/project.json")" '[5,["notes"],"Demo project"]' "configure merges keys and keeps the rest"
eq "$("$P" configure demo --json '{"archiveLimit":5}')" unchanged "configure with the same value says unchanged"
"$P" configure demo --json '[1]' >/dev/null 2>&1 && bad "configure refuses a non-object" || ok "configure refuses a non-object"
"$P" marks demo --json '{"r":{"t-a":"0123abcd"}}' >/dev/null
"$P" marks demo --json '{"r":{"t-b":"89abcdef"}}' >/dev/null
eq "$(jq -c '.r' "$PJD/ui-state.json")" '{"t-a":"0123abcd","t-b":"89abcdef"}' "marks merges read marks into ui-state.json"
"$P" marks demo --json 'nope' >/dev/null 2>&1 && bad "marks refuses bad JSON" || ok "marks refuses bad JSON"
"$P" stop demo >/dev/null
eq "$(jq -r '[.session,.listener]|join(" ")' "$PJD/page.json")" "stopped stopped" "stop marks the page stopped"
grep -q "already stopped" <<<"$("$P" stop demo 2>&1)" && ok "...and a second stop says so" || bad "second stop"
"$P" stop nosuch >/dev/null 2>&1 && bad "stop refuses an unknown project" || ok "stop refuses an unknown project"
go demo >/dev/null; grep -q "was stopped" "$T/go.err" && ok "start resumes a stopped page, saying so" || bad "start after stop" "$(tail -3 "$T/go.err")"
eq "$(jq -r .session "$PJD/page.json")" open "...and the page is open again"

echo; echo "page.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
