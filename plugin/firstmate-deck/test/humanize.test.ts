import { test } from "node:test";
import assert from "node:assert/strict";
import { human, parseStep, shellPhrase } from "../server/humanize.ts";

const cases: [string, string][] = [
  ["cd x && rtk npm run check >/dev/null 2>&1; echo done", "Ran npm run check"],
  ["cd /tmp && echo hi", "Ran a shell command"],
  ["sed -n 1,20p src/foo/bar.ts", "Read bar.ts"],
  ["cat README.md | head -5", "Read README.md"],
  ["grep -rn foo src/", "Searched foo src/"],
  ["rtk git -C /repo status", "Ran git status"],
  ["curl -s 'https://example.com/api/x?y=1'", "Called example.com/api/x"],
  ["curl -s localhost", "Called an HTTP endpoint"],
  ["python3 - <<EOF", "Ran a python snippet"],
  ["node -e 'x'", "Ran a node snippet"],
  ["npx -y vitest run --reporter=dot", "Ran vitest run"],
  ["FOO=1 timeout 30 rtk pnpm test 2>&1", "Ran pnpm test"],
  ["sleep 3", "Ran a shell command"],
  ["echo $(date) && make build -j4 extra words here", "Ran make build -j4 extra"],
  ["", "Ran a shell command"],
  ["(cd a && ls -la b/c) | wc -l", "Searched b/c"],
  ["tail -n 20 log.txt", "Read log.txt"],
  ["npx", "Ran "],
  ["cat -n", "Ran cat -n"],
  ["git status 2>/dev/null || true", "Ran git status"],
];
for (const [cmd, want] of cases) test(`shellPhrase: ${JSON.stringify(cmd)}`, () => assert.equal(shellPhrase(cmd), want));

test("human by tag", () => {
  assert.equal(human("Shell", "rtk npm run check"), "Ran npm run check");
  assert.equal(human("Task notification", "npm run build"), "Finished: ran npm run build");
  assert.equal(human("Thought", "First sentence. Second sentence."), "Thinking: First sentence.");
  assert.equal(human("Read", "/a/b/c.ts 1-20"), "Reading c.ts");
  assert.equal(human("Edit", "/a/b/c.ts"), "Editing c.ts");
  assert.equal(human("Write", ""), "Write");
  assert.equal(human("Skill", "superpowers:brainstorming"), "Loading skill superpowers:brainstorming");
  assert.equal(human("Todo", "x".repeat(150)), "Todo: " + "x".repeat(99) + "…");
});

test("empty step text is still readable", () => {
  assert.equal(human("Bash", ""), "Running a shell command");
  assert.equal(human("Bash", "   "), "Running a shell command");
  assert.equal(human("Shell", ""), "Running a shell command");
  assert.equal(human("Grep", ""), "Grep");
});

test("parseStep", () => {
  assert.deepEqual(parseStep("[Shell] npm test"), ["Shell", "npm test"]);
  assert.equal(parseStep("[User] hello"), null);
  assert.equal(parseStep("[Message received] hi"), null);
  assert.equal(parseStep("plain"), null);
});
