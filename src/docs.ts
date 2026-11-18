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

/** A function that resolves a link destination (or shortcut label). */
export type LinkResolver = (key: string) => LinkResolution;

/** Matches the opening line of a fenced code block, capturing the marker. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split Markdown into alternating prose / fenced-code chunks such that
 * `chunks.join("") === md`. Chunks at even indices are prose, odd indices
 * are fenced blocks (including both fence lines).
 */
export function splitFences(md: string): string[] {
  const chunks: string[] = [];
  const lines = md.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let prose = "";
  let code = "";
  let fence: string | null = null;
  for (const line of lines) {
    if (fence === null) {
      const m = FENCE_OPEN_RE.exec(line);
      if (m) {
        fence = m[1];
        code = line;
      } else {
        prose += line;
      }
      continue;
    }
    code += line;
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\n?$/.exec(line);
    if (close?.[1].startsWith(fence[0]) && close[1].length >= fence.length) {
      chunks.push(prose, code);
      prose = "";
      code = "";
      fence = null;
    }
  }
  if (fence !== null) {
    // Unterminated fence: the rest is code, as in CommonMark.
    chunks.push(prose, code);
    prose = "";
  }
  chunks.push(prose);
  return chunks;
}

/** Apply `fn` to the prose chunks of `md` only. */
export function mapProse(md: string, fn: (prose: string) => string): string {
  return splitFences(md)
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

/** Index of the `]` matching the `[` at `open`, skipping code spans. */
function findClosingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      const end = skipCodeSpan(text, i);
      if (end > i) {
        i = end - 1;
        continue;
      }
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    } else if (ch === "\n" && text[i + 1] === "\n") {
      return -1; // links never span paragraphs
    }
  }
  return -1;
}

/** Index of the `)` closing the `(` at `open` (balanced), or -1. */
function findClosingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    } else if (ch === "\n") {
      return -1;
    }
  }
  return -1;
}

/** Split `dest "title"` into its destination and the raw title suffix. */
function splitDestination(inner: string): { dest: string; title: string } {
  const trimmed = inner.trim();
  const m = /^(<[^>]*>|\S+)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/.exec(trimmed);
  if (!m) return { dest: trimmed, title: "" };
  let dest = m[1];
  if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1);
  return { dest, title: m[2] ?? "" };
}

/**
 * A CommonMark link reference definition: `[label]: dest` with an optional
 * quoted title and nothing else on the line. `[x]: some prose` is a
 * paragraph that starts with a shortcut link, not a definition.
 */
const DEFINITION_RE =
  /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<[^>\n]*>|[^\s<]\S*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/gm;

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
export function rewriteDocLinks(md: string, resolve: LinkResolver): string {
  if (!md) return md;
  // Labels with a reference definition elsewhere in the docstring are real
  // Markdown references; their shortcut uses stay as written.
  const defined = new Set<string>();
  for (const m of md.matchAll(DEFINITION_RE)) defined.add(m[1].toLowerCase());
  return mapProse(md, (prose) => rewriteProse(prose, resolve, defined));
}

function rewriteProse(text: string, resolve: LinkResolver, defined: Set<string>): string {
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
    const close = findClosingBracket(text, i);
    if (close === -1) {
      out += ch;
      i++;
      continue;
    }
    const label = text.slice(i + 1, close);
    const next = text[close + 1];

    // Inline link: [label](dest "title")
    if (next === "(") {
      const end = findClosingParen(text, close + 1);
      if (end !== -1) {
        const raw = text.slice(close + 2, end);
        const { dest, title } = splitDestination(raw);
        const r = resolve(dest);
        const inner = rewriteProse(label, resolve, defined);
        if (typeof r === "string") out += `[${inner}](${r}${title})`;
        else if (r === null || (r === undefined && looksLikeRustPath(dest))) out += inner;
        else out += `[${inner}](${raw})`;
        i = end + 1;
        continue;
      }
    }

    // Reference link: [label][ref] or collapsed [label][]
    if (next === "[") {
      const end = text.indexOf("]", close + 2);
      if (end !== -1 && !text.slice(close + 2, end).includes("\n")) {
        const ref = text.slice(close + 2, end);
        const key = ref === "" ? label : ref;
        if (defined.has(key.toLowerCase())) {
          out += text.slice(i, end + 1);
        } else {
          const r = resolve(key);
          if (typeof r === "string") out += `[${label}](${r})`;
          else if (r === null || looksLikeRustPath(key)) out += label;
          else out += text.slice(i, end + 1);
        }
        i = end + 1;
        continue;
      }
    }

    // Reference definition: [label]: dest (alone on its line)
    const lineStart = i === 0 || text[i - 1] === "\n";
    const eol = text.indexOf("\n", close);
    const lineEnd = eol === -1 ? text.length : eol;
    DEFINITION_RE.lastIndex = 0;
    if (next === ":" && lineStart && DEFINITION_RE.test(text.slice(i, lineEnd))) {
      const { dest, title } = splitDestination(text.slice(close + 2, lineEnd));
      const r = resolve(dest);
      if (typeof r === "string") out += `[${label}]: ${r}${title}`;
      else if (r === null || (r === undefined && looksLikeRustPath(dest))) out += `[${label}]: #`;
      else out += text.slice(i, lineEnd);
      i = lineEnd;
      continue;
    }

    // Shortcut link: [label]
    if (defined.has(label.toLowerCase())) {
      out += `[${label}]`;
    } else {
      const r = resolve(label);
      if (typeof r === "string") out += `[${label}](${r})`;
      else if (r === null || looksLikeRustPath(label) || /^`[^`]+`$/.test(label)) out += label;
      else out += `[${rewriteProse(label, resolve, defined)}]`;
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
export function demoteHeadings(md: string, levels: number): string {
  if (!md || levels <= 0) return md;
  return mapProse(md, (prose) =>
    prose.replace(
      /^( {0,3})(#{1,6})([ \t]+)(.*)$/gm,
      (_m, indent: string, hashes: string, sp: string, text: string) => {
        const depth = hashes.length + levels;
        const body = text.replace(/[ \t]+#+[ \t]*$/, "");
        return depth <= 6 ? `${indent}${"#".repeat(depth)}${sp}${body}` : `${indent}**${body}**`;
      }
    )
  );
}

/**
 * Remove the `# <name>` section (heading and body, up to the next heading of
 * the same or a higher level) from `md`. Returns the section body and the
 * remaining Markdown. Used to move `# Panics` / `# Errors` / `# Safety`
 * into callouts without printing them twice.
 */
export function takeSection(
  md: string | null | undefined,
  name: string
): { section: string | undefined; rest: string } {
  if (!md) return { section: undefined, rest: md ?? "" };
  const chunks = splitFences(md);
  const heading = new RegExp(`^ {0,3}(#{1,6})[ \\t]+${name}[ \\t]*#*[ \\t]*$`, "im");
  // Find the section heading in a prose chunk.
  let offset = 0;
  let start = -1;
  let level = 0;
  for (let c = 0; c < chunks.length; c++) {
    if (c % 2 === 0) {
      const m = heading.exec(chunks[c]);
      if (m) {
        start = offset + m.index;
        level = m[1].length;
        break;
      }
    }
    offset += chunks[c].length;
  }
  if (start === -1) return { section: undefined, rest: md };
  // Find the next heading of the same or a higher level, outside fences.
  const newline = md.indexOf("\n", start);
  const bodyStart = newline < 0 ? md.length : newline + 1;
  let end = md.length;
  offset = 0;
  const next = new RegExp(`^ {0,3}#{1,${level}}[ \\t]+`, "gm");
  for (let c = 0; c < chunks.length; c++) {
    const chunkEnd = offset + chunks[c].length;
    if (c % 2 === 0 && chunkEnd > bodyStart) {
      next.lastIndex = Math.max(0, bodyStart - offset);
      const m = next.exec(chunks[c]);
      if (m) {
        end = offset + m.index;
        break;
      }
    }
    offset = chunkEnd;
  }
  const section = md.slice(bodyStart, end).trim();
  const rest = (md.slice(0, start) + md.slice(end)).replace(/\n{3,}/g, "\n\n").trim();
  return { section, rest };
}

/**
 * Plain-text first line of a docstring for frontmatter descriptions and
 * index summaries: link syntax is reduced to its text.
 */
export function summaryLine(md: string | null | undefined): string {
  const first = md?.split("\n")[0]?.trim() ?? "";
  return first
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\[(`[^`]+`)\]/g, "$1");
}
