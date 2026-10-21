import { test } from "node:test";
import assert from "node:assert/strict";
import { markdown } from "../server/markdown.ts";

test("blocks", () => {
  assert.equal(markdown("# T\n\nHello **b** and *i* and `a<b`.\nNext [l](http://x)."),
    '<h3>T</h3>\n<p>Hello <b>b</b> and <i>i</i> and <code>a&lt;b</code>. Next <a href="http://x">l</a>.</p>');
});
test("lists with one nesting level", () => {
  assert.equal(markdown("- a\n  - a1\n- b\n\n1. x\n2. y"),
    "<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>\n<ol><li>x</li><li>y</li></ol>");
});
test("fenced code is escaped, raw html passes", () => {
  assert.equal(markdown("```js\n<a> & *b*\n```"), "<pre><code>&lt;a&gt; &amp; *b*</code></pre>");
  assert.equal(markdown('<div class="x">hi **no**</div>'), '<div class="x">hi **no**</div>');
});
test("tables", () => {
  assert.equal(markdown("| A | B |\n|---|---|\n| 1 | `2` |"),
    '<div class="tw"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><code>2</code></td></tr></tbody></table></div>');
});
