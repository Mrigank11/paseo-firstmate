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
unset PASEO_HOME LAVISH_AXI_PORT LAVISH_AXI_STATE_DIR
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1 ${2:-}"; fail=$((fail+1)); }
eq()  { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3" "(got '$1', want '$2')"; fi; }

cat >"$T/fakebin/lavish-axi" <<'F'
#!/usr/bin/env bash
echo "lavish-axi $*" >>"$FAKE_LOG"
case "$1" in
  reply) cat >>"$FAKE_LOG"; echo >>"$FAKE_LOG"; echo "status: sent" ;;
  *) printf 'session:\n  file: %s\n  url: "http://fake.test:4390/session/abc123"\n  status: opened\nnext_step: "run poll"\n' "$1" ;;
esac
F
cat >"$T/fakebin/paseo" <<'F'
#!/usr/bin/env bash
echo "paseo $*" >>"$FAKE_LOG"
if [[ "$1 $2" == "plugin ls" ]]; then printf '[{"id":"other","status":"running"},{"id":"firstmate-deck","status":"%s"}]\n' "$FAKE_PLUGIN_STATUS"; fi
F
chmod +x "$T/fakebin/"*
export PATH="$T/fakebin:$PATH"

# ---- start: scaffold + render + open + page.json ----
out="$("$P" start demo --repo /tmp/some-repo --title "Demo project")"
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
"$P" start demo >/dev/null
grep -q "my note" "$PROJ/sections/flags.md" && ok "second start keeps section edits" || bad "second start keeps section edits"
eq "$(jq -r .title "$PROJ/project.json")" "Demo project" "second start keeps the title"
grep -q -- "--reopen" "$FAKE_LOG" && bad "no --reopen unless asked" || ok "no --reopen unless asked"
"$P" start demo --reopen >/dev/null
grep -q -- "--reopen" "$FAKE_LOG" && ok "--reopen is passed through" || bad "--reopen is passed through"

# ---- custom page path ----
"$P" start other --page "$T/elsewhere/other.html" >/dev/null
[[ -f "$T/elsewhere/other.html" ]] && ok "--page renders to the given path" || bad "--page renders to the given path"
eq "$(jq -r .page "$T/root/state/projects/other/project.json")" "$T/elsewhere/other.html" "--page recorded in project.json"
"$P" start Bad_Name >/dev/null 2>&1 && bad "bad slug refused" || ok "bad slug refused"
"$P" start rel --page relative.html >/dev/null 2>&1 && bad "relative --page refused" || ok "relative --page refused"

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

# ---- status ----
st="$("$P" status)"
grep -q "^PROJECT" <<<"$st" && ok "status has a header" || bad "status has a header"
grep -E "^demo +open +http://fake.test:4390/session/abc123 +1 +- +running" <<<"$st" >/dev/null && ok "status row: session, url, undelivered, plugin" || bad "status row" "$st"
grep -q "^other" <<<"$st" && ok "status lists every project" || bad "status lists every project"
eq "$("$P" status demo | wc -l)" 2 "status <project> shows one row"

# ---- heal ----
: >"$FAKE_LOG"
"$P" heal | grep -q "nothing to do" && ok "heal leaves a running plugin alone" || bad "heal leaves a running plugin alone"
grep -q "plugin reload" "$FAKE_LOG" && bad "no reload when running" || ok "no reload when running"
FAKE_PLUGIN_STATUS=failed "$P" heal | grep -q "reloaded" && ok "heal reports the reload" || bad "heal reports the reload"
grep -q "paseo plugin reload firstmate-deck" "$FAKE_LOG" && ok "heal reloads a failed plugin" || bad "heal reloads a failed plugin"
PASEO_HOME=/x/home FAKE_PLUGIN_STATUS=failed "$P" heal >/dev/null
grep -q "plugin reload firstmate-deck --home /x/home" "$FAKE_LOG" && ok "heal pins --home to PASEO_HOME" || bad "heal pins --home"

# ---- render ----
"$P" render demo --out "$T/out.html" >/dev/null
[[ -f "$T/out.html" ]] && ok "render --out" || bad "render --out"

# ---- state/page.env is sourced ----
echo 'export LAVISH_AXI_PORT=4999' >"$T/root/state/page.env"
cat >"$T/fakebin/lavish-axi" <<'F'
#!/usr/bin/env bash
if [[ "$1" == reply ]]; then cat >/dev/null; exit 0; fi
printf 'session:\n  file: %s\n  url: "http://fake.test:%s/session/x"\n  status: opened\n' "$1" "${LAVISH_AXI_PORT:-none}"
F
eq "$("$P" start envdemo | jq -r .url)" "http://fake.test:4999/session/x" "page.env supplies LAVISH_AXI_PORT"

echo; echo "page.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
