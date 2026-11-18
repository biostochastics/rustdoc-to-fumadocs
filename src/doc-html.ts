/** Keep semantic rustdoc HTML while emitting only static, allowlisted MDX tags
 * and attributes. Embedded HTML uses the HTML parser's decoding and nesting
 * rules, including void elements and omitted table containers. */
import type { LinkResolver } from "./docs.js";
import { parseFragment, html, type DefaultTreeAdapterTypes } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type HtmlNode = DefaultTreeAdapterTypes.ChildNode;

const tags = new Set(
  "a abbr b blockquote br caption cite code dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img kbd li mark ol p pre q s small span strong sub summary sup table tbody td th thead tr u ul".split(
    " "
  )
);
const voids = new Set(["br", "hr", "img"]);

export function allowedUrl(value: string, image = false): boolean {
  try {
    const { protocol } = new URL(value, "https://docs.invalid");
    return (image ? ["http:", "https:"] : ["http:", "https:", "ftp:", "mailto:", "tel:"]).includes(
      protocol
    );
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/{/g, "&#123;")
    .replace(/}/g, "&#125;")
    .replace(/\r\n?|\n/g, "&#10;");
}

function opening(el: Element, resolve?: LinkResolver): string {
  const attrs: string[] = [];
  for (const { name, value: original } of el.attrs) {
    let value = original;
    const link = name === "href" && el.tagName === "a";
    const image = name === "src" && el.tagName === "img";
    if (link || image) {
      const destination = resolve?.(value);
      if (destination === null) continue;
      value = destination ?? value;
      if (!allowedUrl(value, image)) continue;
    } else if (
      !["title", "alt", "width", "height", "rowspan", "colspan", "scope", "id", "align"].includes(
        name
      )
    )
      continue;
    const key = name === "colspan" ? "colSpan" : name === "rowspan" ? "rowSpan" : name;
    attrs.push(` ${key}="${escapeHtml(value)}"`);
  }
  return `<${el.tagName}${attrs.join("")}${voids.has(el.tagName) ? " /" : ""}>`;
}

function render(el: HtmlNode, source: string, resolve?: LinkResolver): string {
  if (el.nodeName === "#text" && "value" in el)
    return escapeHtml(el.value).replace(/[[\](`*_~|\\]/g, (c) => `&#${c.charCodeAt(0)};`);
  if (!("tagName" in el)) return "";
  if (!tags.has(el.tagName) || el.namespaceURI !== html.NS.HTML) {
    const p = el.sourceCodeLocation;
    return p ? escapeHtml(source.slice(p.startOffset, p.endOffset)) : "";
  }
  const tag = opening(el, resolve);
  return voids.has(el.tagName)
    ? tag
    : tag + el.childNodes.map((c) => render(c, source, resolve)).join("") + `</${el.tagName}>`;
}

/** Separate tags can surround Markdown in the same paragraph or document. */
export function singleHtmlTag(
  raw: string,
  resolve?: LinkResolver
): { tag: string; close: boolean; markup: string } | undefined {
  const name = /^<(\/?)([a-z][a-z\d]*)\b/i.exec(raw);
  if (!name || !tags.has(name[2])) return;
  const tag = name[2];
  if (name[1])
    return new RegExp(`^</${tag}\\s*>$`, "i").test(raw)
      ? { tag, close: true, markup: `</${tag}>` }
      : undefined;
  if (voids.has(tag)) return;
  const fragment = parseFragment(raw, { sourceCodeLocationInfo: true });
  const el = fragment.childNodes[0];
  if (
    el &&
    "tagName" in el &&
    el.tagName === tag &&
    el.sourceCodeLocation?.startTag?.endOffset === raw.length
  ) {
    return { tag, close: false, markup: opening(el, resolve) };
  }
}

/** Return a complete, static fragment, or undefined for literal metasyntax such as <T>. */
export function renderHtmlFragment(raw: string, resolve?: LinkResolver): string | undefined {
  if (raw.startsWith("<!--") || /^<!(?:DOCTYPE|\[CDATA\[)/i.test(raw)) return "";
  const name = /^<([a-z][a-z\d]*)\b/i.exec(raw)?.[1];
  if (!name || !tags.has(name)) return;
  const tree = parseFragment(raw, { sourceCodeLocationInfo: true });
  return tree.childNodes.map((n) => render(n, raw, resolve)).join("");
}

/** Visible text for descriptions. Preserve Rust type placeholders such as <T>. */
export function htmlText(raw: string): string {
  if (raw.startsWith("<!--")) return "";
  const tag = /^<(\/?)([a-z][a-z\d]*)\b/i.exec(raw);
  if (!tag || !tags.has(tag[2])) return raw;
  if (tag[1]) return "";
  const visit = (node: HtmlNode): string => {
    if ("value" in node) return node.value;
    if (!("tagName" in node)) return "";
    if (node.tagName === "img") return node.attrs.find((a) => a.name === "alt")?.value ?? "";
    return node.childNodes.map(visit).join("");
  };
  return parseFragment(raw).childNodes.map(visit).join("");
}
