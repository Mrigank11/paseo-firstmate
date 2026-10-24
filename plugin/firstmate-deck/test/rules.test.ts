import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, parseRules, RulesFile, summarize, type Rules } from "../server/rules.ts";

const BLOCK = (o: object) => "# decisions\n\n```json fm-permission-rules\n" + JSON.stringify(o, null, 2) + "\n```\n";
const STARTER = {
  mode: "shadow", allowKinds: ["tool"], read: true, writeWithin: ["$WORKTREE", "$ROOT/state/tasks/$TASK"],
  shell: { allow: ["^git (status|log|diff|show)( |$)", "^(ls|cat|head|tail|wc|rg|grep)( |$)", "^(npm|pnpm) (test|run [\\w:-]+|ci|install)$", "^node --test ", "^npx tsc --noEmit$"] },
  fetchHosts: [],
};
const rules = (over: object = {}): Rules => { const s = parseRules(BLOCK({ ...STARTER, ...over })); assert.equal(s.error, null); return s.rules!; };

function env() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "perm-")));
  const home = join(base, "home");
  const wt = join(home, "worktrees", "abc", "crew");
  const root = join(base, "fm");
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(root, "state", "tasks", "t1"), { recursive: true });
  return { base, home, wt, root, ctx: { cwd: wt, root, task: "t1", paseoHome: home } };
}
const tool = (detail: object, kind = "tool") => ({ id: "r1", kind, name: "x", detail: detail as never });

test("parse: the starter block, and every way it can be unusable", () => {
  const ok = parseRules(BLOCK(STARTER));
  assert.equal(ok.error, null);
  assert.equal(ok.rules!.mode, "shadow");
  for (const text of ["no block", "```json fm-permission-rules\n{not json\n```", BLOCK({ ...STARTER, mode: "yolo" }), BLOCK({ ...STARTER, allowKinds: "tool" }), BLOCK({ ...STARTER, shell: { allow: ["("] } }), "```json fm-permission-rules\n[]\n```"]) {
    const s = parseRules(text);
    assert.equal(s.rules, null, text);
    assert.ok(s.error);
  }
});

test("reads and searches are allowed anywhere; other kinds and detail-less requests escalate", () => {
  const e = env();
  assert.equal(classify(rules(), tool({ type: "read", filePath: "/etc/hosts" }), e.ctx).decision, "allow");
  assert.equal(classify(rules(), tool({ type: "search", query: "x" }), e.ctx).decision, "allow");
  assert.equal(classify(rules({ read: false }), tool({ type: "read", filePath: "/etc/hosts" }), e.ctx).decision, "escalate");
  assert.equal(classify(rules(), tool({ type: "read", filePath: "/x" }, "question"), e.ctx).decision, "escalate");
  assert.equal(classify(rules(), { id: "r", kind: "tool", name: "x" }, e.ctx).decision, "escalate");
  assert.equal(classify(rules(), tool({ type: "unknown", input: {}, output: null }), e.ctx).decision, "escalate");
});

test("writes: inside the worktree or the task dir only; symlinks and .. do not escape", () => {
  const e = env();
  const r = rules();
  const w = (filePath: string, type = "write") => classify(r, tool({ type, filePath }), e.ctx).decision;
  assert.equal(w(join(e.wt, "a.txt")), "allow");
  assert.equal(w(join(e.wt, "new", "dir", "a.txt")), "allow"); // does not exist yet
  assert.equal(w("rel.txt", "edit"), "allow"); // relative to cwd
  assert.equal(w(join(e.root, "state", "tasks", "t1", "report.md")), "allow");
  assert.equal(w(join(e.root, "state", "tasks", "t2", "report.md")), "escalate"); // another task
  assert.equal(w(join(e.root, "state", "fleet.json")), "escalate");
  assert.equal(w(join(e.base, "outside.txt")), "escalate");
  assert.equal(w(join(e.wt, "..", "outside.txt")), "escalate");
  assert.equal(w(join(e.wt, "..", "crew-evil", "a")), "escalate"); // prefix lookalike
  symlinkSync(e.base, join(e.wt, "link"));
  assert.equal(w(join(e.wt, "link", "outside.txt")), "escalate");
  assert.equal(w(""), "escalate");
});

test("$WORKTREE is the cwd only under the Paseo worktrees root; a main checkout cwd gets no write access", () => {
  const e = env();
  const main = join(e.base, "checkout");
  mkdirSync(main);
  const r = rules();
  assert.equal(classify(r, tool({ type: "write", filePath: join(main, "a") }), { ...e.ctx, cwd: main }).decision, "escalate");
  assert.equal(classify(r, tool({ type: "write", filePath: join(e.home, "worktrees", "a") }), { ...e.ctx, cwd: join(e.home, "worktrees") }).decision, "escalate"); // the root itself
  assert.equal(classify(r, tool({ type: "write", filePath: join(main, "a") }), { ...e.ctx, cwd: null }).decision, "escalate");
  const custom = rules({ worktreeRoots: [join(e.base, "checkout")] });
  assert.equal(classify(custom, tool({ type: "write", filePath: join(main, "sub", "a") }), { ...e.ctx, cwd: join(main, "sub") }).decision, "allow");
});

test("a task id that is not a plain slug never expands $TASK", () => {
  const e = env();
  const r = rules();
  assert.equal(classify(r, tool({ type: "write", filePath: join(e.root, "state", "tasks", "..", "fleet.json") }), { ...e.ctx, cwd: null, task: ".." }).decision, "escalate");
});

test("shell: the allowlist; unlisted commands, write flags and newlines escalate", () => {
  const e = env();
  const r = rules();
  const sh = (command: string) => classify(r, tool({ type: "shell", command }), e.ctx).decision;
  for (const c of ["git status", "git diff --stat", "ls -la src", "cat package.json", "npm test", "npm run build:all", "node --test test/a.test.ts", "npx tsc --noEmit", "rg -n foo src", "rg 'a b' src"]) assert.equal(sh(c), "allow", c);
  for (const c of ["git push", "rm -rf x", "curl http://x", "npm publish", "npm run build -- --x", "git diff --output=/tmp/x", "rg --pre ./evil x", "ls\nrm x", "", "   ", "git statusx", "sh -c 'ls'", "bash script.sh"]) assert.equal(sh(c), "escalate", JSON.stringify(c));
});

test("shell: transparent wrappers and env assignments are stripped before matching", () => {
  const e = env();
  const r = rules();
  const sh = (command: string) => classify(r, tool({ type: "shell", command }), e.ctx);
  for (const c of ["rtk ls -la .", "rtk git status", "time npm test", "command ls src", "nice -n 5 git log", "timeout 30 npm test", "timeout -k5 10s git diff", "env ls", "env -i ls", "FOO=bar ls src", "CI=1 FOO=bar rtk git status", "rtk time timeout 5 ls", "nohup ls"]) assert.equal(sh(c).decision, "allow", c);
  // a wrapper never makes a command safe: what is left must itself be allowed
  for (const c of ["rtk sh -c 'ls'", "rtk bash -c ls", "timeout 5 curl http://x", "time rm -rf x", "nice -n 5 npm publish", "env sh", "rtk", "timeout 5", "env", "FOO=bar", "rtk rtk", "xargs ls", "env -S 'ls'"]) assert.equal(sh(c).decision, "escalate", c);
  // env assignments that change what runs
  for (const c of ["PATH=/tmp/x ls", "LD_PRELOAD=/tmp/x.so ls", "GIT_EXTERNAL_DIFF=/tmp/x git diff", "NODE_OPTIONS=--require=/tmp/x npm test", "FOO=bar PATH=/x ls", "HOME=/tmp ls"]) assert.equal(sh(c).decision, "escalate", c);
  assert.match(sh("rtk ls .").rule, /^shell:/);
});

test("shell: wrappers are config, not code", () => {
  const e = env();
  const sh = (r: Rules, command: string) => classify(r, tool({ type: "shell", command }), e.ctx).decision;
  assert.equal(sh(rules(), "mywrap ls"), "escalate");
  assert.equal(sh(rules({ shell: { ...STARTER.shell, wrappers: ["^mywrap "] } }), "mywrap ls"), "allow");
  assert.equal(sh(rules({ shell: { ...STARTER.shell, wrappers: ["^mywrap "] } }), "rtk ls"), "escalate"); // a configured list replaces the defaults
  assert.equal(sh(rules({ shell: { ...STARTER.shell, envDeny: "^FOO$" } }), "PATH=/x ls"), "allow");
  assert.equal(sh(rules({ shell: { ...STARTER.shell, envDeny: "^FOO$" } }), "FOO=1 ls"), "escalate");
  // a regex that cuts a word in half does not strip half a word
  assert.equal(sh(rules({ shell: { ...STARTER.shell, wrappers: ["^rt"] } }), "rtk ls"), "escalate");
});

test("shell: compound commands need every part allowed", () => {
  const e = env();
  const r = rules();
  const sh = (command: string) => classify(r, tool({ type: "shell", command }), e.ctx).decision;
  for (const c of ["git status && git diff", "ls; ls src", "cat a | rg x", "rtk git log || rtk git status", "ls src | head -5 | wc -l", "cd_not_a_thing_but_ls; ls".replace("cd_not_a_thing_but_ls; ", "")]) assert.equal(sh(c), "allow", c);
  for (const c of ["ls; rm -rf /", "git status && git push", "ls | sh", "cat a | tee b", "ls && curl http://x", "ls || rm x", "rtk ls; rtk rm x", "ls;", "; ls", "ls &&", "ls | ", "ls & rm x", "ls |& cat", "cat a | xargs rm"]) assert.equal(sh(c), "escalate", JSON.stringify(c));
});

test("shell: expansion, subshells and unparseable syntax escalate", () => {
  const e = env();
  const r = rules();
  const sh = (command: string) => classify(r, tool({ type: "shell", command }), e.ctx);
  for (const c of ["cat $(whoami)", "ls `id`", "ls $HOME", "ls ${HOME}", "(ls)", "ls (x)", "cat <(ls)", "ls \"$(id)\"", "ls \"`id`\"", "echo 'unterminated", "ls \"unterminated", "ls #c", "cat <<EOF", "cat <<< x", "ls &> out", "ls >& out", "ls >(x)", "ls trailing\\", "rtk $(echo ls)", "FOO=$(id) ls", "FOO=`id` ls"]) {
    assert.equal(sh(c).decision, "escalate", c);
  }
  // quoted metacharacters are plain text, not syntax
  for (const c of ["rg 'a;b' src", "rg \"a|b\" src", "rg 'a && b' .", "rg '$x' .", "rg \"a\\\"b\" .", "ls a\\;b"]) assert.equal(sh(c).decision, "allow", c);
  assert.match(sh("cat $(whoami)").rule, /unparseable/);
});

test("shell: redirections are writes and obey writeWithin; reads and fd duplicates are free", () => {
  const e = env();
  const r = rules();
  const sh = (command: string) => classify(r, tool({ type: "shell", command }), e.ctx).decision;
  for (const c of ["ls > out.txt", "ls >> out.txt", "ls > /dev/null", "ls 2>/dev/null", "ls 2>&1", "rtk npm test 2>&1 | head", "npm test > " + join(e.wt, "log.txt"), "cat < in.txt", "ls >&2", "ls > " + join(e.root, "state", "tasks", "t1", "out.txt")]) assert.equal(sh(c), "allow", c);
  for (const c of ["ls > /tmp/x", "ls > " + join(e.base, "x"), "ls >> ../x", "ls > " + join(e.root, "state", "fleet.json"), "ls > ~/.bashrc", "ls > *.txt", "ls >", "ls > out.txt > /etc/x", "echo hi > /etc/passwd", "ls 2> /tmp/err", "> /tmp/x"]) assert.equal(sh(c), "escalate", c);
  symlinkSync(e.base, join(e.wt, "lnk"));
  assert.equal(sh("ls > lnk/x"), "escalate"); // a symlink out of the worktree
});

test("shell: a legacy denyChars still refuses those characters anywhere", () => {
  const e = env();
  const r = rules({ shell: { ...STARTER.shell, denyChars: "*" } });
  assert.equal(classify(r, tool({ type: "shell", command: "ls *.ts" }), e.ctx).decision, "escalate");
  assert.equal(classify(r, tool({ type: "shell", command: "ls src" }), e.ctx).decision, "allow");
});

test("fetch: only listed hosts", () => {
  const e = env();
  const f = (r: Rules, url: string) => classify(r, tool({ type: "fetch", url }), e.ctx).decision;
  assert.equal(f(rules(), "https://example.com/x"), "escalate");
  assert.equal(f(rules({ fetchHosts: ["example.com"] }), "https://example.com/x"), "allow");
  assert.equal(f(rules({ fetchHosts: ["example.com"] }), "https://example.com.evil.io/x"), "escalate");
  assert.equal(f(rules({ fetchHosts: ["example.com"] }), "not a url"), "escalate");
});

test("RulesFile re-reads on mtime change and fails closed when the file goes away", () => {
  const e = env();
  const file = join(e.base, "decisions.md");
  writeFileSync(file, BLOCK(STARTER));
  const rf = new RulesFile(() => file);
  assert.equal(rf.get().rules?.mode, "shadow");
  writeFileSync(file, BLOCK({ ...STARTER, mode: "enforce" }));
  utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(rf.get().rules?.mode, "enforce");
  writeFileSync(file, "# no block now");
  utimesSync(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
  assert.match(rf.get().error ?? "", /no .*block/);
  assert.match(new RulesFile(() => join(e.base, "missing.md")).get().error ?? "", /unreadable/);
});

test("summarize", () => {
  assert.equal(summarize({ id: "r", kind: "tool", name: "Bash", detail: { type: "shell", command: "ls  -la" } }), "shell: ls -la");
  assert.equal(summarize({ id: "r", kind: "question", name: "AskUser", title: "Which one?" }), "question: Which one?");
});
