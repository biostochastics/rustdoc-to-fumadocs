/**
 * Markdown transforms applied to rustdoc docstrings before they are written
 * into MDX pages.
 *
 * @module docs
 * @description Intra-doc link resolution, heading demotion and section
 * extraction. Every transform is code-fence aware: fenced code blocks pass
 * through untouched.
 */

/**
 * Result of resolving one link destination or label:
 * - a string: the URL to link to;
 * - `null`: an intra-doc link with no public target (render the text only);
 * - `undefined`: not an intra-doc link (leave the Markdown as written).
 */
export type LinkResolution = string | null | undefined;

import { allowedUrl, htmlText, singleHtmlTag, renderHtmlFragment } from "./doc-html.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown, type Options } from "mdast-util-to-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Parents, PhrasingContent, Root } from "mdast";

const parseOptions = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };
export type MarkdownParser = (source: string, mutable?: boolean) => Root;
const parseMarkdown: MarkdownParser = (source) => fromMarkdown(source, parseOptions);

/** Cache syntax only. Each render owns its cache and mutating transforms get a private tree. */
export function createMarkdownParser(): MarkdownParser {
  const trees = new Map<string, { root: Root; bytes: number }>();
  let sourceBytes = 0;
  return (source, mutable = false) => {
    let entry = trees.get(source);
    if (entry) {
      trees.delete(source);
    } else {
      const root = parseMarkdown(source);
      const bytes = Buffer.byteLength(source);
      if (bytes > 64 * 1024) return root;
      while (trees.size >= 64 || sourceBytes + bytes > 256 * 1024) {
        const oldest = trees.entries().next();
        if (oldest.done) break;
        sourceBytes -= oldest.value[1].bytes;
        trees.delete(oldest.value[0]);
      }
      entry = { root, bytes };
      sourceBytes += bytes;
    }
    trees.set(source, entry);
    return mutable ? structuredClone(entry.root) : entry.root;
  };
}

/** A function that resolves a link destination (or shortcut label). */
export type LinkResolver = (key: string) => LinkResolution;

/** Split Markdown at code blocks identified by CommonMark, including blocks in lists or quotes. */
export function splitFences(md: string, parse = parseMarkdown): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  function walk(node: Nodes): void {
    if (node.type === "code" && node.position) {
      const start = node.position.start.offset!;
      const end = node.position.end.offset!;
      chunks.push(md.slice(cursor, start), md.slice(start, end));
      cursor = end;
    } else if ("children" in node) {
      node.children.forEach(walk);
    }
  }
  walk(parse(md));
  chunks.push(md.slice(cursor));
  return chunks;
}

/** Apply `fn` to the prose chunks of `md` only. */
export function mapProse(md: string, fn: (prose: string) => string, parse = parseMarkdown): string {
  return splitFences(md, parse)
    .map((chunk, i) => (i % 2 === 0 ? fn(chunk) : chunk))
    .join("");
}

/** If a code span starts at `i`, the index just after it; else `i`. */
function skipCodeSpan(text: string, i: number): number {
  let run = 0;
  while (text[i + run] === "`") run++;
  let j = i + run;
  while (j < text.length) {
    const k = text.indexOf("`", j);
    if (k === -1) return i;
    let closeRun = 0;
    while (text[k + closeRun] === "`") closeRun++;
    if (closeRun === run) return k + run;
    j = k + closeRun;
  }
  return i;
}

/** Pair brackets once per prose chunk so unmatched markup does not repeatedly
 * scan the entire remaining paragraph. Literal code spans and escapes are skipped. */
function matchingBrackets(text: string): Map<number, number> {
  const open: number[] = [];
  const closed = new Map<number, number>();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "`") {
      const end = skipCodeSpan(text, i);
      if (end > i) i = end - 1;
      else while (text[i + 1] === "`") i++;
    } else if (ch === "[") open.push(i);
    else if (ch === "]" && open.length) closed.set(open.pop()!, i);
    else if (ch === "\n" && text[i + 1] === "\n") open.length = 0;
  }
  return closed;
}

function labelOf(raw: string): string {
  return raw.slice(1, matchingBrackets(raw).get(0) ?? raw.length);
}

const DISAMBIGUATOR =
  "(?:struct|enum|trait|union|fn|mod|module|type|const|constant|static|macro|method|field|variant|tymethod|derive|attr|prim|primitive|value|tyalias)@";
const RUST_PATH_RE = new RegExp(
  `^(?:${DISAMBIGUATOR})?[A-Za-z_]\\w*(?:<[^>]*>)?(?:::(?:<[^>]*>|[A-Za-z_]\\w*(?:<[^>]*>)?))*(?:\\(\\)|!)?$`
);

/** True when `label` looks like a Rust intra-doc path (`` `Foo` ``, `a::B`). */
export function looksLikeRustPath(label: string): boolean {
  const backticked = /^`[^`]+`$/.test(label);
  const inner = backticked ? label.slice(1, -1) : label;
  return RUST_PATH_RE.test(inner) && (backticked || inner.includes("::"));
}

/**
 * Rewrite intra-doc links in rustdoc Markdown.
 *
 * Handles inline links (`[text](crate::Foo)`), reference links
 * (`[text][`Foo`]`, `[`Foo`][]`), shortcut links (`` [`Foo`] ``) and
 * reference definitions (`[a]: crate::Foo`). `resolve` maps a destination or
 * label to a URL (string), to "no public target" (`null`: the link text is
 * kept, without brackets) or to "not an intra-doc link" (`undefined`).
 *
 * Shortcut and reference links that `resolve` does not know but that look
 * like Rust paths (`` [`Foo`] ``, `[a::B]`) are unresolved intra-doc links;
 * their brackets are dropped so readers do not see literal `[...]`.
 */
export function rewriteDocLinks(
  md: string,
  resolve: LinkResolver,
  preserveFragments = true,
  parse = parseMarkdown
): string {
  if (!md?.includes("[")) return md;
  const tree = parse(md);
  const protectedNodes: Nodes[] = [];
  const unavailable = new Set<string>();
  const resolutions = new Map<Nodes, LinkResolution>();
  const resolveKey = (key: string): LinkResolution => {
    const url = resolve(key);
    if (typeof url !== "string") return url;
    const fragment = /#([^\s`]+)`?$/.exec(key)?.[1];
    return preserveFragments && fragment && !url.includes("#") ? `${url}#${fragment}` : url;
  };
  function collect(n: Nodes): void {
    if (n.type === "definition" || n.type === "link") {
      let url = resolveKey(n.url);
      // A reference to a gated Rust item may have no row in rustdoc's link
      // table. A code label and a single identifier make its intent clear.
      if (
        url === undefined &&
        (looksLikeRustPath(n.url) ||
          (n.type === "definition" && n.label?.startsWith("`") && RUST_PATH_RE.test(n.url)))
      )
        url = null;
      resolutions.set(n, url);
      if (n.type === "definition" && url === null) unavailable.add(n.identifier);
      protectedNodes.push(n);
    } else if (["code", "html", "image", "imageReference", "linkReference"].includes(n.type)) {
      protectedNodes.push(n);
    } else if ("children" in n) n.children.forEach(collect);
  }
  collect(tree);
  let output = "",
    cursor = 0;
  for (const n of protectedNodes) {
    const start = n.position!.start.offset!,
      end = n.position!.end.offset!;
    output += rewriteProse(md.slice(cursor, start), resolveKey);
    const raw = md.slice(start, end);
    let value = raw;
    const r = resolutions.get(n);
    if (n.type === "definition") {
      if (r === null) value = "";
      else if (typeof r === "string")
        value = `[${n.label ?? n.identifier}]: ${r}${n.title ? " " + JSON.stringify(n.title) : ""}`;
    } else if (n.type === "link" && r !== undefined) {
      const label = raw.startsWith("[") ? labelOf(raw) : textOf(n);
      value =
        r === null ? label : `[${label}](${r}${n.title ? " " + JSON.stringify(n.title) : ""})`;
    } else if (n.type === "linkReference" && unavailable.has(n.identifier)) {
      value = labelOf(raw);
    }
    output += value;
    cursor = end;
  }
  return output + rewriteProse(md.slice(cursor), resolveKey);
}

function rewriteProse(text: string, resolve: LinkResolver): string {
  if (!text.includes("[")) return text;
  const brackets = matchingBrackets(text);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = skipCodeSpan(text, i);
      let run = 0;
      while (text[i + run] === "`") run++;
      const stop = end > i ? end : i + run;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch !== "[" || text[i - 1] === "!") {
      out += ch;
      i++;
      continue;
    }
    const close = brackets.get(i);
    if (close === undefined) {
      out += ch;
      i++;
      continue;
    }
    const label = text.slice(i + 1, close);
    const next = text[close + 1];

    // Reference link: [label][ref] or collapsed [label][]
    if (next === "[") {
      const end = text.indexOf("]", close + 2);
      if (end !== -1 && !text.slice(close + 2, end).includes("\n")) {
        const ref = text.slice(close + 2, end);
        const key = ref === "" ? label : ref;
        const r = resolve(key);
        if (typeof r === "string") out += `[${label}](${r})`;
        else if (r === null || looksLikeRustPath(key)) out += label;
        else out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    const r = resolve(label);
    if (typeof r === "string") out += `[${label}](${r})`;
    else if (r === null || looksLikeRustPath(label) || /^`[^`]+`$/.test(label)) out += label;
    else {
      out += "[";
      i++;
      continue;
    }
    i = close + 1;
  }
  return out;
}

/**
 * Push every ATX heading in `md` down by `levels` (`# Examples` becomes
 * `### Examples` for `levels = 2`), so docstring sections nest under the
 * page's own headings. Headings that would exceed level 6 become bold text.
 */
export function demoteHeadings(md: string, levels: number, parse = parseMarkdown): string {
  // ATX headings need whitespace or EOL after the marker. A setext
  // underline ends its line. Both conditions also hold inside containers.
  if (!md || levels <= 0 || !/#(?=[ \t\r\n]|$)|[=-][ \t]*(?:[\r\n]|$)/.test(md)) return md;
  const tree = parse(md, true);
  let changed = false;
  function demote(parent: Parents): void {
    for (const [i, n] of parent.children.entries()) {
      if (n.type === "heading") {
        changed = true;
        const depth = n.depth + levels;
        if (depth <= 6) n.depth = depth as typeof n.depth;
        else
          parent.children[i] = {
            type: "paragraph",
            children: [{ type: "strong", children: n.children }],
          };
      } else if ("children" in n) demote(n);
    }
  }
  demote(tree);
  return changed ? serialize(tree, false) : md;
}

/**
 * Remove the `# <name>` section (heading and body, up to the next heading of
 * the same or a higher level) from `md`. Returns the section body and the
 * remaining Markdown. Used to move `# Panics` / `# Errors` / `# Safety`
 * into callouts without printing them twice.
 */
export function takeSection(
  md: string | null | undefined,
  name: string,
  parse = parseMarkdown
): { section: string | undefined; rest: string } {
  if (!md?.toLowerCase().includes(name.toLowerCase()))
    return { section: undefined, rest: md ?? "" };
  const children = parse(md).children;
  const index = children.findIndex(
    (n) => n.type === "heading" && textOf(n).toLowerCase() === name.toLowerCase()
  );
  const h = children[index];
  if (h?.type !== "heading") return { section: undefined, rest: md };
  const next = children.slice(index + 1).find((n) => n.type === "heading" && n.depth <= h.depth);
  const end = next?.position?.start.offset ?? md.length;
  const section = md.slice(h.position!.end.offset, end).trim();
  const before = md.slice(0, h.position!.start.offset).trimEnd();
  const after = md.slice(end).trimStart();
  return { section, rest: [before, after].filter(Boolean).join("\n\n") };
}

function textOf(node: Nodes): string {
  if ("children" in node) return node.children.map(textOf).join("");
  if (node.type === "html") return htmlText(node.value);
  if (node.type === "break") return " ";
  if ("alt" in node) return node.alt ?? "";
  return "value" in node ? node.value : "";
}

const serializeOptions: Options = {
  extensions: [gfmToMarkdown()],
  bullet: "-",
  emphasis: "*",
  fences: true,
  resourceLink: true,
  unsafe: [
    { character: "{", inConstruct: ["phrasing"] },
    { character: "{", atBreak: true },
    { character: "<", inConstruct: ["phrasing"] },
    { character: "<", atBreak: true },
    { character: "i", after: "mport(?=[ \\t]|$)", atBreak: true },
    { character: "e", after: "xport(?=[ \\t]|$)", atBreak: true },
  ],
};

const rustToken =
  /^(?:rust|compile_fail|ignore|no_run|should_panic|test_harness|standalone_crate|allow_fail|edition20\d\d|ignore-[\w-]+|E\d{4}|\{[^}]*\})$/;
/** Normalize doctests and sanitize links and HTML before serializing Markdown. */
function prepare(node: Parents, normalizeDoctests: boolean, resolve?: LinkResolver): void {
  const pairs = new Map<Nodes, string>();
  const opens: { tag: string; node: Nodes; markup: string }[] = [];
  for (const child of node.children) {
    if (child.type !== "html") continue;
    const tag = singleHtmlTag(child.value, resolve);
    if (!tag) continue;
    if (!tag.close) opens.push({ ...tag, node: child });
    else if (opens.at(-1)?.tag === tag.tag) {
      const start = opens.pop()!;
      pairs.set(start.node, start.markup);
      pairs.set(child, tag.markup);
    } else opens.length = 0;
  }
  for (const [i, child] of node.children.entries()) {
    if (child.type === "link" || child.type === "definition" || child.type === "image") {
      const target = child.type === "image" ? resolve?.(child.url) : undefined;
      if (typeof target === "string") child.url = target;
      if (target === null || !allowedUrl(child.url, child.type === "image")) {
        if (child.type === "definition") child.url = "#";
        else node.children[i] = { type: "text", value: textOf(child) };
        continue;
      }
    }
    if (child.type === "html") {
      const safeHtml = pairs.get(child) ?? renderHtmlFragment(child.value, resolve);
      if (safeHtml !== undefined) child.value = safeHtml;
      else {
        const literal = { type: "text" as const, value: child.value };
        const block =
          node.type === "root" || node.type === "blockquote" || node.type === "listItem";
        node.children[i] = block ? { type: "paragraph", children: [literal] } : literal;
      }
    } else if (child.type === "code" && normalizeDoctests) {
      const tokens = [child.lang, child.meta]
        .filter(Boolean)
        .join(" ")
        .split(/[\s,]+/)
        .filter(Boolean);
      if (tokens.every((token) => rustToken.test(token))) {
        child.lang = "rust";
        const directive = tokens.find((t) => t !== "rust" && !t.startsWith("{"));
        child.meta = directive ? `title="${directive}"` : null;
        child.value = child.value
          .split("\n")
          .filter((line) => !/^\s*#(?:\s|$)/.test(line))
          .map((line) => line.replace(/^(\s*)##/, "$1#"))
          .join("\n");
      }
    } else if ("children" in child) prepare(child, normalizeDoctests, resolve);
  }
}

function serialize(root: Root, normalizeDoctests: boolean, resolve?: LinkResolver): string {
  prepare(root, normalizeDoctests, resolve);
  return toMarkdown(root, serializeOptions).trimEnd();
}

// A single ordinary sentence has identical source and serialized Markdown.
// Restrict punctuation to keep GFM autolinks, MDX escapes and block syntax
// on the full parser path. Leading/trailing and repeated spaces matter, too.
function isPlainSentence(md: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9 ,'-]*[.!?]?$/.test(md) && !/ {2}| $|^(?:import|export)(?: |$)/.test(md)
  );
}

/** Only parse the opening paragraph when later definitions cannot affect it. */
function summarySource(md: string): string {
  if (!/^[A-Za-z]/.test(md)) return md;
  const end = md.search(/\r?\n[ \t]*\r?\n/);
  if (end < 0) return md;
  const first = md.slice(0, end);
  // Each line starts with prose, ruling out setext headings, table
  // delimiters and other blocks. Brackets can refer to later definitions.
  return first.includes("[") || /[\r\n](?!\n|[A-Za-z])/.test(first) ? md : first;
}

/** Render CommonMark/GFM as passive MDX without interpreting Rust documentation as JSX or JS. */
export function sanitizeDocstring(
  raw: string,
  resolve?: LinkResolver,
  parse = parseMarkdown
): string {
  return raw && !isPlainSentence(raw) ? serialize(parse(raw, true), true, resolve) : raw;
}

/** Render a single complete prose paragraph, keeping links and inline formatting intact. */
export function summaryMarkdown(md: string | null | undefined, parse = parseMarkdown): string {
  if (!md) return "";
  const source = summarySource(md);
  if (isPlainSentence(source)) return source;
  const root = parse(source);
  const paragraph = root.children.find((n) => n.type === "paragraph");
  if (paragraph?.type !== "paragraph") return "";
  const definitions = new Map(
    root.children.filter((n) => n.type === "definition").map((n) => [n.identifier, n])
  );
  function inline(nodes: PhrasingContent[]): PhrasingContent[] {
    return nodes.map((n) => {
      if (n.type === "linkReference") {
        const def = definitions.get(n.identifier);
        if (def)
          return { type: "link", url: def.url, title: def.title, children: inline(n.children) };
      }
      if (n.type === "imageReference") {
        const def = definitions.get(n.identifier);
        if (def) return { type: "image", url: def.url, title: def.title, alt: n.alt };
      }
      if (n.type === "break") return { type: "text", value: " " };
      if (n.type === "text" && n.value.includes("\n")) {
        const value = n.value.replace(/\s+/g, (space) => (space.includes("\n") ? " " : space));
        return { ...n, value };
      }
      if ("children" in n) return { ...n, children: inline(n.children) };
      return { ...n };
    });
  }
  return serialize(
    { type: "root", children: [{ ...paragraph, children: inline(paragraph.children) }] },
    false
  );
}

/** Plain text for frontmatter and string props. */
export function summaryLine(md: string | null | undefined, parse = parseMarkdown): string {
  if (!md) return "";
  const source = summarySource(md);
  if (isPlainSentence(source)) return source;
  const node = parse(source).children.find((n) => n.type === "paragraph");
  if (!node) return "";
  function plain(node: Nodes): string {
    if (!("children" in node)) return textOf(node);
    const parts = node.children.map(plain);
    for (const [i, child] of node.children.entries()) {
      if (
        child.type === "inlineCode" &&
        parts[i - 1]?.endsWith("[") &&
        parts[i + 1]?.startsWith("]")
      ) {
        parts[i - 1] = parts[i - 1].slice(0, -1);
        parts[i + 1] = parts[i + 1].slice(1);
      }
    }
    return parts.join("");
  }
  return plain(node).replace(/\s+/g, " ").trim();
}
