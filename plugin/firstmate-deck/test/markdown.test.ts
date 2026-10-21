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
test("fenced code is escaped; raw html is shown as text, never passed through", () => {
  assert.equal(markdown("```js\n<a> & *b*\n```"), "<pre><code>&lt;a&gt; &amp; *b*</code></pre>");
  assert.equal(markdown('<div class="x">hi **yes**</div>'), "<p>&lt;div class=&quot;x&quot;&gt;hi <b>yes</b>&lt;/div&gt;</p>");
  assert.equal(markdown("a <script>alert(1)</script> & b"), "<p>a &lt;script&gt;alert(1)&lt;/script&gt; &amp; b</p>");
});
test("links: http(s), mailto, #fragment and relative stay links; other schemes become plain text", () => {
  assert.equal(markdown("[a](https://x.test/p?q=1&r=2)"), '<p><a href="https://x.test/p?q=1&amp;r=2">a</a></p>');
  assert.equal(markdown("[m](mailto:a@b.c) [h](#top) [r](docs/x.md) [r2](../y)"), '<p><a href="mailto:a@b.c">m</a> <a href="#top">h</a> <a href="docs/x.md">r</a> <a href="../y">r2</a></p>');
  for (const bad of ["javascript:alert(1)", "JaVaScript:alert(1)", "data:text/html,x", "vbscript:x", "java\tscript:alert(1)", "&#106;avascript:alert(1)"]) {
    const out = markdown(`[click](${bad})`);
    assert.ok(!out.includes("<a "), bad + " -> " + out);
  }
  assert.equal(markdown("[click](javascript:x)"), "<p>click</p>");
  assert.equal(markdown('[x](http://a/"onmouseover="x)'), '<p><a href="http://a/&quot;onmouseover=&quot;x">x</a></p>');
});
test("tables", () => {
  assert.equal(markdown("| A | B |\n|---|---|\n| 1 | `2` |"),
    '<div class="tw"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><code>2</code></td></tr></tbody></table></div>');
});
