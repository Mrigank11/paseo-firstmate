// A tiny DOM for tests that need element trees without a browser: parse an HTML fragment into nodes with the few
// properties the page script and Lavish's selector() read (nodeType, tagName, id, children, parentElement, setAttribute).
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "col", "area", "base", "source", "wbr"]);

export class El {
  nodeType = 1;
  children: El[] = [];
  parentElement: El | null = null;
  text = "";
  tagName: string;
  attrs: Record<string, string>;
  constructor(tagName: string, attrs: Record<string, string> = {}) { this.tagName = tagName; this.attrs = attrs; }
  get id(): string { return this.attrs.id ?? ""; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
  get innerText(): string { return (this.text + this.children.map((c) => c.innerText).join(" ")).replace(/\s+/g, " ").trim(); }
  get textContent(): string { return this.innerText; }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

export function parse(html: string): El {
  const root = new El("DIV", { id: "live" });
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) { stack[stack.length - 1].text += m[5]; continue; }
    if (!m[2]) continue;
    const name = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName.toLowerCase() === name) { stack.length = i; break; }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? "";
    const el = new El(name.toUpperCase(), attrs);
    const parent = stack[stack.length - 1];
    el.parentElement = parent;
    parent.children.push(el);
    if (!VOID.has(name) && !m[4]) stack.push(el);
  }
  return root;
}

/** Lavish 0.1.95's in-page selector(), verbatim (dist/cli.mjs:5709); CSS.escape is the platform's, approximated for ids. */
export const cssEscape = (s: string) => s.replace(/[^\w-]/g, (c) => "\\" + c);
export function lavishSelector(el: El, esc = cssEscape): string {
  if (!el || !el.tagName) return "";
  const parts: string[] = [];
  let node: El | null = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part += "#" + esc(node.id);
      parts.unshift(part);
      break;
    }
    const parent2: El | null = node.parentElement;
    if (parent2) {
      const same = [...parent2.children].filter((x) => x.tagName === node!.tagName);
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    parts.unshift(part);
    node = parent2;
  }
  return parts.join(" > ");
}
