import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, parseRules, RulesFile, summarize, type Rules } from "../server/rules.ts";

const BLOCK = (o: object) => "# decisions\n\n```json fm-permission-rules\n" + JSON.stringify(o, null, 2) + "\n```\n";
const STARTER = {
  mode: "shadow", allowKinds: ["tool"], read: true, writeWithin: ["$WORKTREE", "$ROOT/state/tasks/$TASK"],
  shell: { allow: ["^git (status|log|diff|show)( |$)", "^(ls|cat|head|tail|wc|rg|grep) ", "^(npm|pnpm) (test|run [\\w:-]+|ci|install)$", "^node --test ", "^npx tsc --noEmit$"], denyChars: ";&|><`$()" },
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

test("shell: the allowlist, with metacharacters, newlines and write flags refused", () => {
  const e = env();
  const r = rules();
  const sh = (command: string) => classify(r, tool({ type: "shell", command }), e.ctx).decision;
  for (const c of ["git status", "git diff --stat", "ls -la src", "cat package.json", "npm test", "npm run build:all", "node --test test/a.test.ts", "npx tsc --noEmit", "rg -n foo src"]) assert.equal(sh(c), "allow", c);
  for (const c of ["git status; rm -rf /", "ls | sh", "cat a > b", "cat $(whoami)", "ls `id`", "git status && x", "git push", "rm -rf x", "curl http://x", "npm publish", "npm run build -- --x", "git diff --output=/tmp/x", "ls\nrm x", "", "git statusx"]) assert.equal(sh(c), "escalate", JSON.stringify(c));
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
