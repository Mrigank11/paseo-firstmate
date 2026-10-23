// Small dependency-free Markdown -> HTML for the subset the first mate writes. Everything is escaped first:
// raw HTML in the source is shown as text, never passed through (the input can be crew output). Only links to
// http:, https:, mailto:, #fragments and relative paths become anchors.

const escCode = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escText = (s: string) => escCode(s).replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** href is already HTML-escaped. Allowed: http(s):, mailto:, #fragment, and relative paths (no scheme at all). */
export function safeHref(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(href)) return false; // browsers strip these inside a scheme ("java\tscript:")
  if (/^(https?:|mailto:|#)/i.test(href)) return true;
  return !/^[^/?]*:/.test(href); // a colon before any / or ? means some other scheme
}

/** href and text are already HTML-escaped. External links open in a new tab; mailto:, #fragments and relative paths stay put. */
function anchor(href: string, text: string): string {
  return /^https?:/i.test(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : `<a href="${href}">${text}</a>`;
}

export function inline(src: string): string {
  const codes: string[] = [];
  let s = src.replace(/\u0000/g, "").replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${escCode(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escText(s);
  // anchors are parked in `codes` too, so bold/italic and the bare-URL pass never touch an href
  const park = (html: string) => { codes.push(html); return `\u0000${codes.length - 1}\u0000`; };
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => (safeHref(href) ? park(anchor(href, text)) : text));
  // bare http(s) URLs; the text is already escaped, so stop at an escaped delimiter and drop trailing punctuation
  s = s.replace(/https?:\/\/(?:(?!&lt;|&gt;|&quot;|&#x27;)[^\s\u0000])+/gi, (url) => {
    const tail = /(?:[.,;:!?)\]}*_]|&#x27;)+$/.exec(url)?.[0] ?? "";
    const href = url.slice(0, url.length - tail.length);
    return href.length > 8 ? park(anchor(href, href)) + tail : url;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

const LIST = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const isRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes("-");
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function renderList(items: { ordered: boolean; text: string; kids: { ordered: boolean; text: string }[] }[]): string {
  const tag = items[0].ordered ? "ol" : "ul";
  const body = items
    .map((it) => {
      let kids = "";
      if (it.kids.length) {
        const kt = it.kids[0].ordered ? "ol" : "ul";
        kids = `<${kt}>${it.kids.map((k) => `<li>${inline(k.text)}</li>`).join("")}</${kt}>`;
      }
      return `<li>${inline(it.text)}${kids}</li>`;
    })
    .join("");
  return `<${tag}>${body}</${tag}>`;
}

export function markdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escCode(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { const n = Math.min(6, h[1].length + 2); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && isRule(lines[i + 1]) && lines[i + 1].includes("|")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      out.push(
        `<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`,
      );
      continue;
    }
    if (LIST.test(line)) {
      const items: { ordered: boolean; text: string; kids: { ordered: boolean; text: string }[] }[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m) {
          const ordered = /\d/.test(m[2]);
          if (m[1].length >= 2 && items.length) items[items.length - 1].kids.push({ ordered, text: m[3] });
          else items.push({ ordered, text: m[3], kids: [] });
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          const it = items[items.length - 1];
          if (it.kids.length) it.kids[it.kids.length - 1].text += " " + lines[i].trim();
          else it.text += " " + lines[i].trim();
        } else break;
        i++;
      }
      out.push(renderList(items));
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !LIST.test(lines[i])
    ) buf.push(lines[i++]);
    // a line that ends in two or more spaces is a hard line break (CommonMark); other lines are joined with a space
    out.push(`<p>${buf.map((l, k) => inline(l.trim()) + (k < buf.length - 1 && / {2,}$/.test(l) ? "<br>" : "")).join(" ")}</p>`);
  }
  return out.join("\n");
}
