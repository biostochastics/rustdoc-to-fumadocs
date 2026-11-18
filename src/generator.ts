/**
 * Generator that converts rustdoc JSON to Fumadocs-compatible MDX files.
 *
 * @module generator
 * @description Converts rustdoc JSON output to Fumadocs v14+ compatible MDX files
 * with proper frontmatter, meta.json navigation, and FumaDocs UI components.
 *
 * @example
 * ```typescript
 * import { RustdocGenerator } from 'rustdoc-to-fumadocs';
 *
 * const generator = new RustdocGenerator(crateJson, {
 *   output: 'content/docs/api',
 *   baseUrl: '/docs/api',
 * });
 * const files = generator.generate();
 * ```
 */

import { posix } from "node:path";
import { stringify } from "yaml";
import type {
  RustdocCrate,
  Item,
  ItemSummary,
  ExternalCrate,
  ItemKind,
  Id,
  VariantKind,
  Type,
  GenericArgs,
} from "./types.js";
import { getItemKind, isPlainStruct, getPathName } from "./types.js";
import { RustdocError, ErrorCode } from "./errors.js";
import { rewriteDocLinks, demoteHeadings, summaryLine, takeSection } from "./docs.js";
import { itemCfgs, dedupeCfgs, describeCfgs, requiredFeatures, type Cfg } from "./cfg.js";

/**
 * Maximum recursion depth for module processing.
 * Prevents stack overflow from deeply nested or circular module hierarchies.
 */
const MAX_RECURSION_DEPTH = 100;

/**
 * Maximum number of warnings to emit before suppressing further warnings.
 * Prevents console flooding from corrupted input with many unknown items.
 */
const MAX_WARNINGS = 50;

/**
 * Maximum depth for type reference traversal.
 * Prevents stack overflow from deeply nested generic types.
 */
const MAX_TYPE_DEPTH = 50;

/**
 * Centralized ordering of item kinds for consistent display across the generator.
 * This order is used for table of contents, meta.json navigation, and kind-based grouping.
 */
const KIND_ORDER: readonly ItemKind[] = [
  "struct",
  "union",
  "enum",
  "trait",
  "function",
  "type_alias",
  "constant",
  "static",
  "macro",
  "proc_derive",
  "proc_attribute",
] as const;

/** Item kinds that get their own page (or kind-page section). */
const PAGE_KINDS: ReadonlySet<ItemKind> = new Set(KIND_ORDER);

/**
 * One item page placed in a module of the {@link ModuleNode} plan. The same
 * item can be placed more than once (`#[doc(inline)]` re-exports); the first
 * placement is its canonical URL.
 */
interface PageEntry {
  item: Item;
  /** Name in this module: the `use` name for renamed re-exports. */
  name: string;
  /** File name (without `.mdx`), unique within the module directory. */
  file: string;
  kind: ItemKind;
  node: ModuleNode;
  /** The `use` item this page was inlined through, if any. */
  via: Item | undefined;
  /** Absolute URL of the page (or kind-page anchor). */
  url: string;
  /** cfg predicates the item is gated on, module gates included. */
  gates: Cfg[];
}

/** A `pub use` that points at an item documented elsewhere. */
interface ReexportEntry {
  name: string;
  source: string;
  isGlob: boolean;
  /** Resolved link for local targets; external targets resolve at render time. */
  href: string | null;
  /** Target id of an external re-export, resolved when the index renders. */
  targetId?: Id;
  docs?: string;
  kind?: string;
}

/** A module of the resolved public API (a directory of the output). */
interface ModuleNode {
  item: Item;
  /** Name as seen by users (the `use` name for an inlined module). */
  name: string;
  /** Output directory segments, crate root first. */
  segments: string[];
  parent: ModuleNode | undefined;
  depth: number;
  pages: PageEntry[];
  submodules: ModuleNode[];
  reexports: ReexportEntry[];
  /** The `use` item this module was inlined through, if any. */
  via: Item | undefined;
  /** cfg predicates the module is gated on, ancestors' gates included. */
  gates: Cfg[];
  /** Lower-cased names claimed in this directory. */
  taken: Set<string>;
}

/** First line of a docstring, or "" when there is none. */
function firstLine(docs: string | null | undefined): string {
  return docs?.split("\n")[0]?.trim() ?? "";
}

/**
 * Wrap text in a Markdown code span, using a longer backtick fence when the
 * text itself contains backticks (CommonMark §6.1).
 */
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** URL-encode one path segment of a generated page. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/** Join a base URL and path segments into an absolute URL path. */
function joinUrl(base: string, segments: string[]): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/${segments.join("/")}`;
}

/** The slug github-slugger (used by Fumadocs) gives a `` ## `name` `` heading. */
function headingSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Short suffix used to disambiguate colliding file names. */
function kindSuffix(kind: ItemKind): string {
  const map: Partial<Record<ItemKind, string>> = {
    function: "fn",
    macro: "macro",
    proc_derive: "derive",
    proc_attribute: "attr",
    module: "mod",
    type_alias: "type",
    constant: "const",
  };
  return map[kind] ?? kind;
}

/** How an item is named in index listings (`name!` for macros). */
function displayName(name: string, kind: ItemKind): string {
  return kind === "macro" ? `${name}!` : name;
}

/** True when the item carries `#[doc(<flag>)]` (e.g. `inline`, `no_inline`). */
function hasDocFlag(item: Item, flag: string): boolean {
  const re = new RegExp(`#\\[doc\\(\\s*${flag}\\s*\\)\\]`);
  return item.attrs.some((attr) => {
    const text = typeof attr === "string" ? attr : "other" in attr ? String(attr.other) : "";
    return re.test(text);
  });
}

/** rustdoc HTML file prefixes (`struct.Foo.html`) by item kind. */
const HTML_KIND_PREFIX: Partial<Record<string, string>> = {
  struct: "struct",
  enum: "enum",
  union: "union",
  trait: "trait",
  trait_alias: "traitalias",
  function: "fn",
  type_alias: "type",
  constant: "constant",
  static: "static",
  macro: "macro",
  primitive: "primitive",
  keyword: "keyword",
  proc_attribute: "attr",
  proc_derive: "derive",
  foreign_type: "foreigntype",
};

/**
 * URL of an external item's rustdoc HTML page, built from its defining path
 * and its crate's `html_root_url` (docs.rs when the crate has none).
 */
export function externalDocUrl(
  summary: ItemSummary,
  ext: ExternalCrate | undefined
): string | null {
  const segs = summary.path;
  if (segs.length === 0) return null;
  const crateName = ext?.name ?? segs[0];
  let root = ext?.html_root_url ?? `https://docs.rs/${crateName}/latest/`;
  if (!root.endsWith("/")) root += "/";
  const name = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);
  if (summary.kind === "module") return `${root}${segs.join("/")}/index.html`;
  if (summary.kind === "variant" && dirs.length > 1) {
    const enumName = dirs[dirs.length - 1];
    return `${root}${dirs.slice(0, -1).join("/")}/enum.${enumName}.html#variant.${name}`;
  }
  const prefix = HTML_KIND_PREFIX[summary.kind];
  if (!prefix) return `${root}${dirs.join("/")}/index.html`;
  return `${root}${dirs.join("/")}/${prefix}.${name}.html`;
}

/** Maximum filename length for most filesystems */
const MAX_FILENAME_LENGTH = 255;

/**
 * Sanitizes a path segment to prevent directory traversal attacks.
 * Removes or replaces dangerous characters that could escape the output directory.
 *
 * @param segment - A single path segment (filename or directory name)
 * @returns Sanitized segment safe for filesystem operations, or "unnamed" for empty input
 *
 * @example
 * ```typescript
 * sanitizePath("../../../etc/passwd") // Returns "______etc_passwd"
 * sanitizePath("my_module") // Returns "my_module"
 * sanitizePath("my/nested/path") // Returns "my_nested_path"
 * sanitizePath("") // Returns "unnamed"
 * ```
 */
export function sanitizePath(segment: string): string {
  // Handle empty or whitespace-only segments
  if (!segment || segment.trim() === "") {
    return "unnamed";
  }

  // Normalize Unicode and replace dangerous characters
  let sanitized = segment
    .normalize("NFC") // Unicode normalization for consistent handling
    .replace(/\.\./g, "_") // Prevent parent directory traversal
    .replace(/[/\\]/g, "_") // Replace path separators
    .replace(/^\.+/, "_") // Replace leading dots
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1f]/g, "_"); // Remove invalid filesystem characters

  // Truncate to filesystem limit while preserving extension if present
  if (sanitized.length > MAX_FILENAME_LENGTH) {
    const extIndex = sanitized.lastIndexOf(".");
    if (extIndex > 0 && extIndex > sanitized.length - 10) {
      // Has a short extension - preserve it
      const ext = sanitized.slice(extIndex);
      sanitized = sanitized.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
    } else {
      // No extension or very long extension - just truncate
      sanitized = sanitized.slice(0, MAX_FILENAME_LENGTH);
    }
  }

  // Final check: if sanitization resulted in empty string (e.g., "../../"), return "unnamed"
  if (!sanitized || sanitized.trim() === "") {
    return "unnamed";
  }

  return sanitized;
}
import {
  formatType,
  formatFunctionSignature,
  formatStructSignature,
  formatUnionSignature,
  formatEnumSignature,
  formatTraitSignature,
  formatGenerics,
  formatGenericBound,
  formatGenericArgs,
  renderTabs,
  renderCards,
  renderSafetyCallout,
  renderCfgCallout,
  renderPanicsCallout,
  renderErrorsCallout,
  type CardData,
} from "./renderer/index.js";

/**
 * Strip ANSI escape sequences and ASCII control characters from a string
 * before sending it to the console. Used on any log line that may embed
 * untrusted content (crate names, item paths, docstrings) from rustdoc JSON.
 *
 * Attack model: a malicious crate name could embed `\x1b[2J` to clear the
 * terminal or `\n[ERROR] system compromised` to forge log lines. Replacing
 * control bytes with `?` makes the message visible but inert.
 */
function sanitizeLogMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
}

/**
 * Doctest directives rustdoc accepts in a code fence's info string. A fence
 * whose info string has only these (or nothing at all) is Rust: it is
 * tagged `rust` so Shiki highlights it, keeps its first directive as the
 * block title, and loses rustdoc's hidden `# ` lines.
 */
const RUSTDOC_FENCE_TOKEN =
  /^(rust|compile_fail|ignore|no_run|should_panic|test_harness|standalone_crate|allow_fail|edition20\d\d|ignore-[\w-]+|E\d{4}|\{[^}]*\})$/;

/**
 * Classify a code fence info string (the text after the backticks): Rust
 * (per rustdoc's rules, including an empty info string) or another
 * language.
 */
function classifyFenceInfo(info: string): { rust: boolean; title: string; extra: string } {
  const tokens = info
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.every((t) => RUSTDOC_FENCE_TOKEN.test(t))) {
    const directive = tokens.find((t) => t !== "rust" && !t.startsWith("{"));
    return { rust: true, title: directive ?? "", extra: "" };
  }
  return { rust: false, title: "", extra: "" };
}

/** Crates whose docstrings were already normalized (normalization is not idempotent for `##`). */
const NORMALIZED = new WeakSet<object>();

/**
 * A conservative set of HTML tags that MDX parses safely inline. Everything
 * else in the shape `<word>` or `<T>` is rewritten to `&lt;…&gt;` so MDX
 * does not attempt to resolve the tag as a JSX component.
 */
const SAFE_INLINE_HTML_TAGS = new Set([
  "br",
  "hr",
  "kbd",
  "sub",
  "sup",
  "em",
  "strong",
  "code",
  "pre",
  "b",
  "i",
  "u",
  "s",
  "mark",
  "small",
  "cite",
  "q",
  "abbr",
]);

/**
 * Sanitize a rustdoc docstring for MDX consumption. Runs two passes:
 *
 *   1. Code-fence aware: outside fenced ```...```, escape patterns MDX
 *      would mistake for JSX (URL autolinks `<https://…>`, Rust generic
 *      placeholders `<T>` / `<K, V>`, metasyntactic `<word>`).
 *   2. Code-fence normalization: a fence rustdoc treats as Rust (no info
 *      string, `rust`, or only doctest directives such as `compile_fail`,
 *      `ignore`, `no_run`, `should_panic`, `editionYYYY`, possibly
 *      comma-separated) becomes ```rust, keeping the first directive as
 *      `title="directive"`; hidden doctest lines (`# use foo;`) are
 *      dropped and `##` unescapes to `#`.
 *
 * This was ported from a downstream fluxid-docs sync pipeline to the tool
 * itself — every consumer benefits without re-implementing the filters.
 */
export function sanitizeDocstring(raw: string): string {
  if (!raw) return raw;
  const out: string[] = [];
  let fence: { marker: string; rust: boolean } | null = null;
  for (const rawLine of raw.split("\n")) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(rawLine);
    if (fence === null && fenceMatch) {
      // Opening fence: classify the info string the way rustdoc does.
      const [, indent, marker, info] = fenceMatch;
      const { rust, title, extra } = classifyFenceInfo(info);
      fence = { marker, rust };
      out.push(
        rust ? `${indent}${marker}rust${title ? ` title="${title}"` : ""}${extra}` : rawLine
      );
      continue;
    }
    if (fence !== null) {
      const closing =
        fenceMatch?.[2].startsWith(fence.marker[0]) === true &&
        fenceMatch[2].length >= fence.marker.length &&
        fenceMatch[3].trim() === "";
      if (closing) {
        fence = null;
        out.push(rawLine);
        continue;
      }
      if (fence.rust) {
        // Doctest lines starting with `# ` (or a lone `#`) are hidden by
        // rustdoc; `##` escapes a line that really starts with `#`.
        const hidden = /^(\s*)#(.*)$/.exec(rawLine);
        if (hidden && (hidden[2] === "" || /^\s/.test(hidden[2]))) continue;
        if (hidden?.[2].startsWith("#")) {
          out.push(hidden[1] + hidden[2]);
          continue;
        }
      }
      out.push(rawLine);
      continue;
    }
    // Split on inline `…` spans to preserve literal code.
    const parts = rawLine.split(/(`[^`]*`)/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) continue;
      let text = parts[i];
      // `<` before a digit → escape (e.g. "<40 LOC each").
      text = text.replace(/<(\d)/g, "&lt;$1");
      // URL / mailto autolinks: `<https://…>`, `<mailto:…>`.
      text = text.replace(/<([a-z][a-z0-9+.-]*:[^>\s]+)>/gi, "&lt;$1&gt;");
      // `<lowercase_word>` metasyntactic — skip known safe inline HTML tags.
      text = text.replace(/<([a-z_][a-z0-9_-]*)>/g, (match, word) =>
        SAFE_INLINE_HTML_TAGS.has(String(word).toLowerCase()) ? match : `&lt;${word}&gt;`
      );
      // Generic placeholders: `<T>`, `<K, V>`, `<UserId>`. Skip patterns
      // containing `=` or `/` — those are attribute-bearing JSX tags.
      text = text.replace(/<([A-Z][A-Za-z0-9_,\s]*)>/g, (match, inner) => {
        const innerStr = String(inner);
        if (/[=/]/.test(innerStr)) return match;
        return `&lt;${innerStr}&gt;`;
      });
      parts[i] = text;
    }
    out.push(parts.join(""));
  }
  return out.join("\n");
}

/**
 * Checks if an enum variant is a plain/unit variant (no associated data).
 *
 * Handles format version differences:
 * - Format 56+: Uses string literal `"plain"`
 * - Format 35-55: Uses object `{ plain: true }`
 *
 * @param kind - The variant kind to check
 * @returns true if this is a plain/unit variant
 */
function isPlainVariant(kind: VariantKind): kind is "plain" | { plain: true } {
  // Format 56+: plain variant represented as string "plain"
  if (kind === "plain") return true;
  // Format 35-55: plain variant represented as object { plain: true }
  if (typeof kind === "object" && "plain" in kind) return true;
  return false;
}

/**
 * Type guard for tuple enum variants.
 * Tuple variants contain an array of field IDs (null for stripped fields).
 *
 * @param kind - The variant kind to check
 * @returns true if this is a tuple variant
 */
function isTupleVariant(kind: VariantKind): kind is { tuple: (Id | null)[] } {
  return typeof kind === "object" && "tuple" in kind;
}

/**
 * Type guard for struct enum variants.
 * Struct variants contain named fields with their IDs.
 *
 * @param kind - The variant kind to check
 * @returns true if this is a struct variant
 */
function isStructVariant(
  kind: VariantKind
): kind is { struct: { fields: Id[]; has_stripped_fields: boolean } } {
  return typeof kind === "object" && "struct" in kind;
}

/**
 * Configuration options for the RustdocGenerator.
 *
 * @example
 * ```typescript
 * const options: GeneratorOptions = {
 *   output: 'content/docs/api',
 *   baseUrl: '/docs/api',
 *   groupBy: 'module',
 *   generateIndex: true,
 * };
 * ```
 */
export interface GeneratorOptions {
  /** Output directory for generated MDX files */
  output: string;
  /** Base URL for the generated docs (e.g., "/docs/api") */
  baseUrl: string;
  /** Whether to generate index pages for modules (default: true) */
  generateIndex?: boolean;
  /**
   * Custom frontmatter generator function.
   * @param item - The rustdoc item being rendered
   * @param path - Module path segments (e.g., ["crate", "module", "item"])
   * @returns Frontmatter object with title, description, icon, etc.
   */
  frontmatter?: (item: Item, path: string[]) => Record<string, unknown>;
  /**
   * Filter function to include/exclude items.
   * @param item - The rustdoc item to evaluate
   * @returns true to include, false to exclude
   */
  filter?: (item: Item) => boolean;
  /**
   * How to group items in the output:
   * - "module": One MDX file per item (default)
   * - "kind": Group by type (structs.mdx, functions.mdx, etc.)
   * - "flat": Flat structure without module hierarchy
   */
  groupBy?: "module" | "kind" | "flat";
  /**
   * Use FumaDocs Tabs component for implementations.
   * When true, inherent methods and trait implementations are grouped into tabs.
   * Default: true
   */
  useTabs?: boolean;
  /**
   * Use FumaDocs Cards component for cross-references.
   * When true, a "See Also" section with related types is added to pages.
   * Default: true
   */
  useCards?: boolean;
  /**
   * Pages of other crates, keyed by an item's defining path
   * (`crate::module::Item`, as in the rustdoc `paths` table). Workspace mode
   * passes the union of every member's {@link RustdocGenerator.pageIndex}
   * so cross-crate links and re-exports stay on the site instead of
   * pointing at docs.rs.
   */
  externalPages?: Map<string, string>;
  /**
   * Base URL of the source repository (e.g.
   * `https://github.com/org/repo`). Enables "Source" links built from item
   * spans, and resolves repository-relative links in docstrings
   * (`../../docs/spec.md`) against the item's source file. Without it such
   * links are rendered as plain text, since they would 404 on the site.
   */
  sourceUrlBase?: string;
  /**
   * Git ref (branch, tag or commit) for source links. With a ref, links are
   * `<sourceUrlBase>/blob/<ref>/<file>`; without one, `<sourceUrlBase>/<file>`
   * (so a base that already ends in `/blob/<ref>` works too).
   */
  sourceRef?: string;
  /**
   * Package name used in the `Cargo.toml` snippet of feature-gate callouts
   * (defaults to the crate name). Workspace mode passes the member's
   * `package.name`.
   */
  packageName?: string;
}

/** Options that stay optional after defaults have been applied. */
type OptionalKeys = "externalPages" | "sourceUrlBase" | "sourceRef" | "packageName";

/** Options after defaults have been applied. */
type ResolvedOptions = Required<Omit<GeneratorOptions, OptionalKeys>> &
  Pick<GeneratorOptions, OptionalKeys>;

/**
 * Represents a generated file with its path and content.
 */
export interface GeneratedFile {
  /** Relative path from output directory (e.g., "module/item.mdx") */
  path: string;
  /** File content (MDX or JSON) */
  content: string;
}

/**
 * Main generator class that processes rustdoc JSON and outputs MDX files.
 */
export class RustdocGenerator {
  private crate: RustdocCrate;
  private options: ResolvedOptions;
  private warningCount = 0;
  private missingRefCount = 0;
  /** Resolved public-API plan; built once, lazily. */
  private plan: ModuleNode | undefined;
  /** Item id → canonical absolute URL (pages and modules). */
  private itemUrls = new Map<string, string>();
  /** Member id (method, variant, field, …) → URL with anchor. */
  private memberUrls = new Map<string, string>();
  /** Processed docstrings by `id:demote`. */
  private docsCache = new Map<string, string>();
  /** Member heading ids by owning item id. */
  private anchorCache = new Map<string, Map<string, string>>();

  constructor(crate: RustdocCrate, options: GeneratorOptions) {
    this.crate = crate;
    this.options = {
      generateIndex: true,
      frontmatter: defaultFrontmatter,
      filter: defaultFilter,
      groupBy: "module",
      useTabs: true,
      useCards: true,
      ...options,
    } as ResolvedOptions;
    // MDX-safeguard every docstring once at ingest time so downstream
    // render sites do not re-implement escape / code-fence-lang filters.
    this.normalizeDocstrings();
  }

  /**
   * Walk the rustdoc index and rewrite every `item.docs` / `field.docs`
   * through {@link sanitizeDocstring}. This fixes the two MDX-specific
   * breakage modes rustdoc emits verbatim: URL / generic `<…>` patterns
   * that MDX parses as JSX, and doctest-directive fence langs
   * (`compile_fail`, `ignore`, …) that Shiki cannot resolve.
   */
  private normalizeDocstrings(): void {
    if (NORMALIZED.has(this.crate)) return;
    NORMALIZED.add(this.crate);
    const items = this.crate.index as Record<string, unknown>;
    for (const key of Object.keys(items)) {
      const item = items[key] as { docs?: unknown; inner?: Record<string, unknown> } | undefined;
      if (!item) continue;
      if (typeof item.docs === "string" && item.docs.length > 0) {
        item.docs = sanitizeDocstring(item.docs);
      }
      // Struct / enum fields carry their own docstrings.
      const inner = item.inner;
      if (inner && typeof inner === "object") {
        for (const innerKind of Object.keys(inner)) {
          const innerItem = inner[innerKind] as
            | { fields?: { docs?: unknown }[]; variants?: { docs?: unknown }[] }
            | undefined;
          if (!innerItem) continue;
          for (const subKey of ["fields", "variants"] as const) {
            const list = innerItem[subKey];
            if (!Array.isArray(list)) continue;
            for (const sub of list) {
              if (sub && typeof sub.docs === "string" && sub.docs.length > 0) {
                sub.docs = sanitizeDocstring(sub.docs);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Emit a warning with count limiting to prevent console flooding.
   * Strips ANSI escape sequences and control characters from the message
   * so crate/item names from untrusted rustdoc JSON can't manipulate the
   * user's terminal (e.g. clearing the screen, repositioning the cursor,
   * or injecting forged "[ERROR]" prefixes).
   */
  private warn(message: string): void {
    this.warningCount++;
    if (this.warningCount <= MAX_WARNINGS) {
      console.warn(sanitizeLogMessage(message));
    } else if (this.warningCount === MAX_WARNINGS + 1) {
      console.warn(`Warning limit (${MAX_WARNINGS}) reached. Further warnings suppressed.`);
    }
  }

  /** Maximum number of missing reference warnings to show verbosely */
  private static readonly MAX_VERBOSE_MISSING_REFS = 5;

  /**
   * Track missing item references for summary reporting.
   * Shows detailed warnings for the first few, then indicates more exist.
   *
   * @param childId - The ID of the missing item
   * @param parentName - Optional name of the parent module for context
   */
  private warnMissingRef(childId: Id, parentName?: string): void {
    this.missingRefCount++;

    const location = parentName ? ` in module "${parentName}"` : "";

    if (this.missingRefCount <= RustdocGenerator.MAX_VERBOSE_MISSING_REFS) {
      this.warn(`Missing item reference: ${String(childId)}${location}`);
    } else if (this.missingRefCount === RustdocGenerator.MAX_VERBOSE_MISSING_REFS + 1) {
      this.warn(`Additional missing references suppressed (total so far: ${this.missingRefCount})`);
    }
  }

  /**
   * Get an item from the crate index by ID.
   * Handles both string and numeric IDs (format version 56+ uses numeric).
   * JSON object keys are always strings, so we convert numeric IDs.
   */
  private getItem(id: Id): Item | undefined {
    // JSON object keys are always strings, so convert numeric IDs
    const key = String(id);
    return this.crate.index[key];
  }

  /**
   * Get a path from the crate paths by ID.
   * Handles both string and numeric IDs.
   */
  private getPath(id: Id): string[] | undefined {
    const key = String(id);
    return this.crate.paths[key]?.path;
  }

  /**
   * Generate all MDX files from the rustdoc JSON.
   *
   * Runs in two phases: {@link buildPlan} resolves which items are part of
   * the public API and where each one lives (following `pub use`
   * re-exports), then every module node of that plan is rendered.
   *
   * @throws RustdocError if root item is missing or not a module
   */
  generate(): GeneratedFile[] {
    const plan = this.buildPlan();
    const files: GeneratedFile[] = [];
    this.renderNode(plan, files);
    if (this.missingRefCount > RustdocGenerator.MAX_VERBOSE_MISSING_REFS) {
      console.warn(
        `Total missing item references: ${this.missingRefCount} (only first ${RustdocGenerator.MAX_VERBOSE_MISSING_REFS} shown)`
      );
    }
    return files;
  }

  /**
   * Map from an item's defining path (`crate::module::Item`, as found in the
   * rustdoc `paths` table) to the absolute URL of its generated page.
   *
   * Workspace mode feeds the union of every member's index to each member
   * through {@link GeneratorOptions.externalPages}, so a re-export of a
   * sibling crate's item links to the sibling's page instead of docs.rs.
   */
  pageIndex(): Map<string, string> {
    const plan = this.buildPlan();
    const index = new Map<string, string>();
    const visit = (node: ModuleNode): void => {
      const modPath = this.getPath(node.item.id);
      if (modPath && node.item.crate_id === 0) {
        const key = modPath.join("::");
        if (!index.has(key)) index.set(key, this.nodeUrl(node));
      }
      for (const page of node.pages) {
        const p = this.getPath(page.item.id);
        if (!p || page.item.crate_id !== 0) continue;
        const key = p.join("::");
        if (!index.has(key)) index.set(key, page.url);
      }
      node.submodules.forEach(visit);
    };
    visit(plan);
    return index;
  }

  /**
   * Provide the page index of sibling crates (see {@link pageIndex}). Call
   * before {@link generate}; workspace mode builds every member's index
   * first, then renders each member with the union.
   */
  setExternalPages(pages: Map<string, string>): void {
    this.options.externalPages = pages;
  }

  /**
   * URL of a file in the source repository, or undefined when no
   * `sourceUrlBase` is configured or the path is outside the repository.
   */
  private sourceUrl(file: string, lines?: [number, number]): string | undefined {
    if (!this.options.sourceUrlBase) return undefined;
    if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith(".."))
      return undefined;
    const base = this.options.sourceUrlBase.replace(/\/+$/, "");
    const path = file.split("\\").join("/").replace(/^\.\//, "");
    const prefix = this.options.sourceRef ? `${base}/blob/${this.options.sourceRef}` : base;
    const anchor = lines ? `#L${lines[0]}${lines[1] !== lines[0] ? `-L${lines[1]}` : ""}` : "";
    return `${prefix}/${path}${anchor}`;
  }

  /**
   * Resolve a relative link in a docstring (`../../docs/spec.md`) against
   * the directory of the item's source file. Returns the repository URL when
   * a source base is configured, null otherwise (such links 404 on a docs
   * site), and undefined for links that are not repository-relative.
   */
  private resolveRelativeDocLink(item: Item, dest: string): string | null | undefined {
    if (
      !dest ||
      /^[a-z][a-z0-9+.-]*:/i.test(dest) ||
      dest.startsWith("/") ||
      dest.startsWith("#")
    ) {
      return undefined;
    }
    if (!/^\.{1,2}\/|\.(md|rs|toml|json|txt|ya?ml|html?)(#.*)?$|\/$/.test(dest)) return undefined;
    const span = item.span;
    if (!span || span.filename.startsWith("/") || dest.endsWith(".html")) return null;
    const [pathPart, anchor] = dest.split("#", 2);
    const dir = span.filename.split("\\").join("/").split("/").slice(0, -1).join("/");
    const resolved = posix.normalize(posix.join(dir, pathPart));
    const url = this.sourceUrl(resolved);
    if (!url) return null;
    return anchor ? `${url}#${anchor}` : url;
  }

  /**
   * Resolve the public API surface into a tree of {@link ModuleNode}s.
   *
   * Phase A places every item that is *directly* reachable: public items of
   * public modules, recursively from the crate root. Those locations are
   * canonical. Phase B then walks the `pub use` items in breadth-first order:
   *
   * - a re-export of an item that already has a page (and no
   *   `#[doc(inline)]`) becomes a "Re-exports" entry linking to that page;
   * - a re-export of an item from a private module (or a `#[doc(inline)]`
   *   re-export) gets its page at the re-export path, under `use.name`;
   * - a re-exported private module is inlined as a submodule;
   * - a glob re-export applies the same rules to each public child;
   * - an external re-export becomes an entry linking to its documentation.
   */
  private buildPlan(): ModuleNode {
    if (this.plan) return this.plan;
    const rootItem = this.getItem(this.crate.root);

    if (!rootItem) {
      throw new RustdocError(
        ErrorCode.MISSING_ROOT_MODULE,
        `Root item not found: ${this.crate.root}`,
        {
          hint:
            "The rustdoc JSON appears corrupted or incomplete. Regenerate with:\n" +
            '  RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps',
          context: {
            rootId: this.crate.root,
            indexSize: Object.keys(this.crate.index).length,
          },
        }
      );
    }

    if (!("module" in rootItem.inner)) {
      throw new RustdocError(ErrorCode.INVALID_ITEM_STRUCTURE, `Root item is not a module`, {
        hint: "The rustdoc JSON root item has unexpected type. Verify you're using the correct input file.",
        context: {
          rootId: this.crate.root,
          rootKind: Object.keys(rootItem.inner)[0] ?? "unknown",
        },
      });
    }

    const rootName = rootItem.name ?? "crate";
    const root = this.newNode(rootItem, rootName, [sanitizePath(rootName)], undefined, undefined);
    this.registerModuleUrl(root);

    const pendingUses: { node: ModuleNode; use: Item }[] = [];
    this.placeDirectTree(root, pendingUses);
    // The queue grows while it is walked (inlined modules and glob targets
    // add their own re-exports); an array iterator sees appended entries.
    for (const { node, use } of pendingUses) {
      this.placeUse(node, use, pendingUses);
    }

    this.plan = root;
    this.buildMemberUrls(root);
    return root;
  }

  /** Create a module node (not yet attached to a parent). */
  private newNode(
    item: Item,
    name: string,
    segments: string[],
    parent: ModuleNode | undefined,
    via: Item | undefined
  ): ModuleNode {
    const gates = [...(parent?.gates ?? [])];
    if (via) gates.push(...itemCfgs(via));
    gates.push(...itemCfgs(item));
    return {
      item,
      name,
      segments,
      parent,
      depth: parent ? parent.depth + 1 : 0,
      pages: [],
      submodules: [],
      reexports: [],
      via,
      gates: dedupeCfgs(gates),
      taken: new Set(["index", "meta"]),
    };
  }

  /** Record the canonical URL of a module node's item, if it has none yet. */
  private registerModuleUrl(node: ModuleNode): void {
    const key = String(node.item.id);
    if (!this.itemUrls.has(key)) this.itemUrls.set(key, this.nodeUrl(node));
  }

  /**
   * Phase A for one module subtree: place every directly reachable child and
   * queue its `pub use` items for phase B.
   */
  private placeDirectTree(start: ModuleNode, pending: { node: ModuleNode; use: Item }[]): void {
    const queue: ModuleNode[] = [start];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (!("module" in node.item.inner)) continue;
      for (const childId of node.item.inner.module.items) {
        const child = this.getItem(childId);
        if (!child) {
          this.warnMissingRef(childId, node.name);
          continue;
        }
        const kind = getItemKind(child.inner);
        if (kind === "use") {
          if (this.options.filter(child)) pending.push({ node, use: child });
          continue;
        }
        if (!this.options.filter(child)) continue;
        if (kind === "unknown") {
          this.warn(`Skipping unknown item kind in ${child.name ?? String(childId)}`);
          continue;
        }
        if (kind === "module") {
          if (!child.name) continue;
          const sub = this.addSubmodule(node, child, child.name, undefined);
          if (sub) queue.push(sub);
          continue;
        }
        if (!child.name) continue;
        this.addPage(node, child, child.name, undefined);
      }
    }
  }

  /**
   * Attach a submodule to `parent`, guarding against cycles and runaway
   * nesting. Returns undefined when the module was refused.
   */
  private addSubmodule(
    parent: ModuleNode,
    item: Item,
    name: string,
    via: Item | undefined
  ): ModuleNode | undefined {
    if (parent.depth + 1 > MAX_RECURSION_DEPTH) {
      this.warn(
        `Maximum module nesting depth (${MAX_RECURSION_DEPTH}) exceeded at ${name}. ` +
          `Skipping further nested modules.`
      );
      return undefined;
    }
    for (let n: ModuleNode | undefined = parent; n; n = n.parent) {
      if (String(n.item.id) === String(item.id)) {
        this.warn(`Circular module reference detected: ${name}. Skipping.`);
        return undefined;
      }
    }
    const dir = this.claimName(parent, sanitizePath(name), "module");
    const node = this.newNode(item, name, [...parent.segments, dir], parent, via);
    parent.submodules.push(node);
    this.registerModuleUrl(node);
    return node;
  }

  /** Place a page for `item` in `node` under `name` (the re-export name, if any). */
  private addPage(node: ModuleNode, item: Item, name: string, via: Item | undefined): void {
    const kind = getItemKind(item.inner);
    if (kind === "unknown") {
      this.warn(`Skipping unknown item kind in ${name}`);
      return;
    }
    if (!PAGE_KINDS.has(kind)) return;
    const file = this.claimName(node, sanitizePath(name), kind);
    const url =
      this.options.groupBy === "kind"
        ? `${this.nodeUrl(node)}/${kindToFilename(kind)}#${headingSlug(name)}`
        : `${this.nodeUrl(node)}/${encodeSegment(file)}`;
    const gates = [...node.gates];
    if (via) gates.push(...itemCfgs(via));
    gates.push(...itemCfgs(item));
    const entry: PageEntry = { item, name, file, kind, node, via, url, gates: dedupeCfgs(gates) };
    node.pages.push(entry);
    const key = String(item.id);
    if (!this.itemUrls.has(key)) this.itemUrls.set(key, url);
  }

  /**
   * Reserve a file / directory name inside a module directory. Names are
   * compared case-insensitively (macOS and Windows filesystems are), and a
   * page may not share its name with a submodule (`foo.mdx` and
   * `foo/index.mdx` resolve to the same URL). Collisions get a kind suffix.
   */
  private claimName(node: ModuleNode, base: string, kind: ItemKind): string {
    let candidate = base;
    if (node.taken.has(candidate.toLowerCase())) {
      candidate = `${base}-${kindSuffix(kind)}`;
      let n = 2;
      while (node.taken.has(candidate.toLowerCase())) {
        candidate = `${base}-${kindSuffix(kind)}-${n++}`;
      }
    }
    node.taken.add(candidate.toLowerCase());
    return candidate;
  }

  /** Phase B: resolve one `pub use` item found in `node`. */
  private placeUse(node: ModuleNode, use: Item, pending: { node: ModuleNode; use: Item }[]): void {
    if (!("use" in use.inner)) return;
    const u = use.inner.use;
    const inline = hasDocFlag(use, "inline");
    const noInline = hasDocFlag(use, "no_inline");
    const target = u.id !== undefined && u.id !== null ? this.getItem(u.id) : undefined;
    const name = u.name ?? u.source.split("::").pop() ?? u.source;

    if (u.is_glob) {
      if (target && "module" in target.inner && target.crate_id === 0) {
        for (const childId of target.inner.module.items) {
          const child = this.getItem(childId);
          if (!child) continue;
          const kind = getItemKind(child.inner);
          if (kind === "use") {
            if (this.options.filter(child)) pending.push({ node, use: child });
            continue;
          }
          if (!child.name || !this.options.filter(child)) continue;
          this.placeTarget(node, child, child.name, use, inline, noInline, pending);
        }
        return;
      }
      node.reexports.push({
        name: `${u.source}::*`,
        source: u.source,
        isGlob: true,
        href: null,
        targetId: u.id ?? undefined,
      });
      return;
    }

    if (target?.crate_id !== 0) {
      node.reexports.push({
        name,
        source: u.source,
        isGlob: false,
        href: null,
        targetId: u.id ?? undefined,
      });
      return;
    }
    this.placeTarget(node, target, name, use, inline, noInline, pending);
  }

  /** Inline `target` into `node` or record a re-export entry pointing at it. */
  private placeTarget(
    node: ModuleNode,
    target: Item,
    name: string,
    use: Item,
    inline: boolean,
    noInline: boolean,
    pending: { node: ModuleNode; use: Item }[]
  ): void {
    const kind = getItemKind(target.inner);
    const existing = this.itemUrls.get(String(target.id));
    const source = "use" in use.inner ? use.inner.use.source : name;
    if (existing !== undefined && (!inline || noInline)) {
      node.reexports.push({
        name,
        source,
        isGlob: false,
        href: existing,
        docs: firstLine(this.docsFor(target, 0)),
        kind,
      });
      return;
    }
    if (kind === "module") {
      const sub = this.addSubmodule(node, target, name, use);
      if (sub) this.placeDirectTree(sub, pending);
      return;
    }
    if (kind === "impl" || kind === "use") return;
    this.addPage(node, target, name, use);
  }

  /**
   * Absolute URL for any item id: the canonical page of a local item, a
   * sibling workspace crate's page ({@link GeneratorOptions.externalPages}),
   * or the item's rustdoc HTML page for other crates (`html_root_url`, else
   * docs.rs). Null when the item has no public documentation.
   */
  private resolveIdUrl(id: Id): string | null {
    const key = String(id);
    const local = this.itemUrls.get(key) ?? this.memberUrls.get(key);
    if (local) return local;
    const summary = this.crate.paths[key] as ItemSummary | undefined;
    if (!summary || summary.crate_id === 0) return null;
    const sibling = this.options.externalPages?.get(summary.path.join("::"));
    if (sibling) return sibling;
    return externalDocUrl(summary, this.crate.external_crates[String(summary.crate_id)]);
  }

  /**
   * A docstring ready for MDX: intra-doc links resolved through
   * `item.links`, headings pushed down `demote` levels so they nest under
   * the page heading that introduces the item.
   */
  private docsFor(item: Item, demote: number, strip: readonly string[] = []): string {
    if (!item.docs) return "";
    const cacheKey = `${String(item.id)}:${demote}:${strip.join(",")}`;
    const cached = this.docsCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const links = item.links;
    const resolved = rewriteDocLinks(item.docs, (key) => {
      const raw = key.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const id = links[key] ?? links[raw];
      if (id === undefined) return this.resolveRelativeDocLink(item, key);
      return this.resolveIdUrl(id);
    });
    let body = resolved;
    for (const name of strip) body = takeSection(body, name).rest;
    const out = demoteHeadings(body, demote);
    this.docsCache.set(cacheKey, out);
    return out;
  }

  /**
   * Docstring sections an item page shows as callouts (and therefore
   * removes from the body): `# Panics` / `# Errors` for functions and
   * `# Safety` for unsafe functions and traits.
   */
  private calloutSections(item: Item): string[] {
    const out: string[] = [];
    if ("function" in item.inner) out.push("Panics", "Errors");
    if (this.isUnsafeItem(item)) out.push("Safety");
    return out;
  }

  /** Append an item's docs (preceded by a blank line) when it has any. */
  private pushDocs(
    sections: string[],
    item: Item,
    demote: number,
    strip: readonly string[] = []
  ): void {
    const docs = this.docsFor(item, demote, strip);
    if (docs) {
      sections.push("");
      sections.push(docs);
    }
  }

  /** `` #### `name` [#anchor] `` — a member heading with a stable id. */
  private memberHeading(label: string, anchor: string | undefined): string {
    return `#### ${inlineCode(label)}${anchor ? ` [#${anchor}]` : ""}`;
  }

  /**
   * Stable heading ids for the members rendered on an item's page:
   * `method.<name>` for methods (inherent ones, trait-impl ones that are
   * rendered because they are documented, and trait items),
   * `associatedtype.<name>` / `associatedconstant.<name>`, and
   * `variant.<Name>` for enum variants. Struct and union fields map to the
   * page's `fields` heading. Duplicates get a numeric suffix.
   */
  private anchorsFor(item: Item): Map<string, string> {
    const key = String(item.id);
    const cached = this.anchorCache.get(key);
    if (cached) return cached;
    const anchors = new Map<string, string>();
    const used = new Set<string>();
    const claim = (id: Id, base: string): void => {
      if (anchors.has(String(id))) return;
      let anchor = base;
      for (let n = 2; used.has(anchor); n++) anchor = `${base}-${n}`;
      used.add(anchor);
      anchors.set(String(id), anchor);
    };
    const member = (child: Item): void => {
      if (!child.name) return;
      if ("function" in child.inner) claim(child.id, `method.${child.name}`);
      else if ("assoc_type" in child.inner) claim(child.id, `associatedtype.${child.name}`);
      else if ("assoc_const" in child.inner) claim(child.id, `associatedconstant.${child.name}`);
    };

    if ("enum" in item.inner) {
      for (const vid of item.inner.enum.variants) {
        const v = this.getItem(vid);
        if (v?.name) claim(vid, `variant.${v.name}`);
      }
    }
    if ("trait" in item.inner) {
      for (const id of item.inner.trait.items) {
        const child = this.getItem(id);
        if (child) member(child);
      }
    }
    for (const impl of this.getImplementations(item)) {
      if (!("impl" in impl.inner)) continue;
      const isTrait = Boolean(impl.inner.impl.trait);
      for (const id of impl.inner.impl.items) {
        const child = this.getItem(id);
        if (!child) continue;
        // Mirrors renderImpl: trait impls show documented methods only
        // (their associated items go in an un-anchored code block); inherent
        // impls show methods and associated constants.
        if (isTrait && (!child.docs || !("function" in child.inner))) continue;
        if (!isTrait && "assoc_type" in child.inner) continue;
        member(child);
      }
    }
    this.anchorCache.set(key, anchors);
    return anchors;
  }

  /**
   * URLs of members (methods, variants, fields, associated items) of every
   * item that has a canonical page, so intra-doc links like
   * `` [`Foo::bar`] `` or `` [`Self::Variant`] `` land on the right heading.
   */
  private buildMemberUrls(node: ModuleNode): void {
    for (const page of node.pages) {
      if (this.itemUrls.get(String(page.item.id)) !== page.url) continue; // not canonical
      const inKindPage = this.options.groupBy === "kind";
      for (const [id, anchor] of this.anchorsFor(page.item)) {
        if (!this.memberUrls.has(id)) {
          this.memberUrls.set(id, inKindPage ? page.url : `${page.url}#${anchor}`);
        }
      }
      const inner = page.item.inner;
      const fieldIds: Id[] = [];
      if ("struct" in inner && isPlainStruct(inner.struct.kind)) {
        fieldIds.push(...inner.struct.kind.plain.fields);
      } else if ("union" in inner) {
        fieldIds.push(...inner.union.fields);
      }
      for (const id of fieldIds) {
        if (!this.memberUrls.has(String(id))) {
          this.memberUrls.set(String(id), inKindPage ? page.url : `${page.url}#fields`);
        }
      }
      if ("enum" in inner) {
        for (const vid of inner.enum.variants) {
          const variantUrl = this.memberUrls.get(String(vid));
          const v = this.getItem(vid);
          if (!variantUrl || !v || !("variant" in v.inner)) continue;
          const vk = v.inner.variant.kind;
          const ids = isTupleVariant(vk)
            ? vk.tuple.filter((x): x is Id => x !== null)
            : isStructVariant(vk)
              ? vk.struct.fields
              : [];
          for (const fid of ids) {
            if (!this.memberUrls.has(String(fid))) this.memberUrls.set(String(fid), variantUrl);
          }
        }
      }
    }
    node.submodules.forEach((sub) => this.buildMemberUrls(sub));
  }

  /** Absolute URL of a module node's index page. */
  private nodeUrl(node: ModuleNode): string {
    return joinUrl(this.options.baseUrl, node.segments.map(encodeSegment));
  }

  /** Render one module node (index, meta.json, pages) and its submodules. */
  private renderNode(node: ModuleNode, files: GeneratedFile[]): void {
    const dirPath = node.segments.join("/");

    if (this.options.generateIndex) {
      files.push({ path: `${dirPath}/index.mdx`, content: this.generateModuleIndex(node) });
    }
    files.push({ path: `${dirPath}/meta.json`, content: this.generateMeta(node) });

    if (this.options.groupBy === "kind") {
      for (const kind of KIND_ORDER) {
        const pages = node.pages.filter((p) => p.kind === kind);
        if (pages.length === 0) continue;
        files.push({
          path: `${dirPath}/${kindToFilename(kind)}.mdx`,
          content: this.generateKindPage(kind, pages, node),
        });
      }
    } else {
      for (const page of node.pages) {
        files.push({ path: `${dirPath}/${page.file}.mdx`, content: this.generateItemPage(page) });
      }
    }

    for (const sub of node.submodules) this.renderNode(sub, files);
  }

  /**
   * Generates the index.mdx page content for a module: frontmatter, module
   * docs, a table of contents by item kind, submodules and re-exports. All
   * links are absolute (`baseUrl` + canonical page path).
   */
  private generateModuleIndex(node: ModuleNode): string {
    const frontmatter = this.options.frontmatter(node.item, node.segments);
    const sections: string[] = [];

    sections.push(this.formatFrontmatter(frontmatter));
    sections.push("");

    const gate = this.renderGate(node.gates);
    if (gate) {
      sections.push(gate);
      sections.push("");
    }

    const docs = this.docsFor(node.item, 1);
    if (docs) {
      sections.push(docs);
      sections.push("");
    }

    if (node.submodules.length > 0) {
      sections.push("## Modules");
      sections.push("");
      for (const sub of [...node.submodules].sort((a, b) => a.name.localeCompare(b.name))) {
        sections.push(this.indexLine(sub.name, this.nodeUrl(sub), sub.item));
      }
      sections.push("");
    }

    for (const kind of KIND_ORDER) {
      const pages = node.pages
        .filter((p) => p.kind === kind)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (pages.length === 0) continue;
      sections.push(`## ${kindToTitle(kind)}`);
      sections.push("");
      for (const page of pages) {
        sections.push(this.indexLine(displayName(page.name, kind), page.url, page.item));
      }
      sections.push("");
    }

    if (node.reexports.length > 0) {
      sections.push("## Re-exports");
      sections.push("");
      for (const re of [...node.reexports].sort((a, b) => a.name.localeCompare(b.name))) {
        const label = `\`${re.name}\``;
        const href = re.href ?? (re.targetId !== undefined ? this.resolveIdUrl(re.targetId) : null);
        const link = href ? `[${label}](${href})` : label;
        const from =
          re.isGlob || re.source.endsWith(`::${re.name}`) || re.source === re.name
            ? ""
            : ` (from \`${re.source}\`)`;
        const glob = re.isGlob ? "" : from;
        const desc = re.docs ? ` - ${re.docs}` : "";
        sections.push(`- ${link}${glob}${desc}`);
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  /** One `- [`name`](url) - first doc line` bullet for an index page. */
  private indexLine(name: string, url: string, item: Item): string {
    const desc = firstLine(this.docsFor(item, 0));
    return `- [\`${name}\`](${url})${desc ? ` - ${desc}` : ""}`;
  }

  /**
   * Generate meta.json for FumaDocs v14+ navigation: separators per item
   * kind, then the public submodules (as folder links, so each keeps its own
   * meta.json).
   *
   * @see https://fumadocs.dev/docs/ui/navigation
   */
  private generateMeta(node: ModuleNode): string {
    const pages: string[] = [];

    if (this.options.generateIndex) {
      pages.push("index");
    }

    if (this.options.groupBy === "kind") {
      let addedAny = false;
      for (const kind of KIND_ORDER) {
        if (!node.pages.some((p) => p.kind === kind)) continue;
        if (addedAny) pages.push(`---${kindToTitle(kind)}---`);
        pages.push(kindToFilename(kind));
        addedAny = true;
      }
    } else {
      for (const kind of KIND_ORDER) {
        const entries = node.pages
          .filter((p) => p.kind === kind)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (entries.length === 0) continue;
        pages.push(`---${kindToTitle(kind)}---`);
        for (const entry of entries) pages.push(entry.file);
      }
    }

    if (node.submodules.length > 0) {
      pages.push("---Modules---");
      // Folder links (not `...name` spreads) keep each submodule collapsed
      // under its own folder with its own meta.json.
      for (const sub of [...node.submodules].sort((a, b) => a.name.localeCompare(b.name))) {
        pages.push(sub.segments[sub.segments.length - 1]);
      }
    }

    // `defaultOpen: false` keeps the sidebar compact.
    const meta: Record<string, unknown> = {
      title: node.name,
      icon: "Folder",
      defaultOpen: false,
      pages,
    };

    return JSON.stringify(meta, null, 2);
  }

  /**
   * Generates a page grouping all items of a specific kind (groupBy "kind").
   */
  private generateKindPage(kind: ItemKind, pages: PageEntry[], node: ModuleNode): string {
    const sections: string[] = [];

    sections.push(
      this.formatFrontmatter({
        title: kindToTitle(kind),
        description: `${kindToTitle(kind)} in ${node.segments.join("::")}`,
      })
    );
    sections.push("");

    for (const page of [...pages].sort((a, b) => a.name.localeCompare(b.name))) {
      sections.push(this.renderItem(page));
      sections.push("");
      sections.push("---");
      sections.push("");
    }

    return sections.join("\n");
  }

  /**
   * Generates a complete MDX page for a single item: frontmatter, the item
   * itself (signature, docs, fields / variants / trait items), its
   * implementations and a "See Also" card section.
   */
  private generateItemPage(page: PageEntry): string {
    const frontmatter = this.options.frontmatter(page.item, [...page.node.segments, page.name]);
    const sections: string[] = [];

    sections.push(this.formatFrontmatter(frontmatter));
    sections.push("");
    sections.push(this.renderItem(page));

    const impls = this.renderImplementations(page);
    if (impls) {
      sections.push("");
      sections.push(impls);
    }

    if (this.options.useCards) {
      const crossRefs = this.extractCrossReferences(page.item);
      if (crossRefs.length > 0) {
        sections.push("");
        sections.push("## See Also");
        sections.push("");
        sections.push(renderCards(crossRefs));
      }
    }

    return sections.join("\n");
  }

  /**
   * Renders the "Implementations" section of a struct / enum / union page:
   * inherent impls (every method), trait impls (each with its header, so
   * marker impls like `Copy` show, plus associated items and documented
   * methods) and the auto traits. Inherent and trait impls go in Tabs when
   * both exist.
   */
  private renderImplementations(page: PageEntry): string {
    const impls = this.getImplementations(page.item);
    const auto = this.renderAutoTraits(page.item);
    if (impls.length === 0 && !auto) return "";
    const sections: string[] = ["## Implementations", ""];

    const inherentImpls = impls.filter((impl) => "impl" in impl.inner && !impl.inner.impl.trait);
    const traitImpls = impls.filter((impl) => "impl" in impl.inner && impl.inner.impl.trait);
    const render = (list: Item[]): string =>
      list.map((impl) => this.renderImpl(impl, page.item, page.gates)).join("\n\n");
    const traitBody = [render(traitImpls), auto].filter(Boolean).join("\n\n");

    if (this.options.useTabs && inherentImpls.length > 0 && traitBody) {
      const tabContents = new Map<string, string>();
      tabContents.set("Methods", render(inherentImpls));
      tabContents.set("Trait Implementations", traitBody);
      sections.push(renderTabs(["Methods", "Trait Implementations"], tabContents));
    } else {
      for (const body of [render(inherentImpls), traitBody]) {
        if (!body) continue;
        sections.push(body);
        sections.push("");
      }
    }
    return sections.join("\n");
  }

  /**
   * "Auto Trait Implementations" for a type: rustdoc's synthetic impls
   * (`Send`, `Sync`, `Unpin`, ...), negative ones as `!Send`.
   */
  private renderAutoTraits(item: Item): string {
    const impls = this.implIdsOf(item)
      .map((id) => this.getItem(id))
      .filter((i): i is Item => i !== undefined && "impl" in i.inner && i.inner.impl.is_synthetic);
    const names: string[] = [];
    for (const impl of impls) {
      if (!("impl" in impl.inner) || !impl.inner.impl.trait) continue;
      const name = getPathName(impl.inner.impl.trait).split("::").pop() ?? "";
      names.push(inlineCode(`${impl.inner.impl.is_negative ? "!" : ""}${name}`));
    }
    if (names.length === 0) return "";
    return `### Auto Trait Implementations\n\n${names.join(" · ")}`;
  }

  /**
   * Extracts cross-references to other types for the "See Also" section.
   *
   * Scans the item's type signatures to find references to other types in the crate:
   * - **Functions**: Parameter types and return type
   * - **Structs**: Field types (plain struct fields)
   * - **Enums**: Variant field types (tuple and struct variants)
   * - **Traits**: Supertrait bounds
   *
   * The extraction process:
   * 1. Collects type IDs via `collectTypeReferences()` based on item kind
   * 2. Removes self-reference
   * 3. Filters to public items from the local crate only
   * 4. Converts to CardData with title, href, description, and icon
   * 5. Sorts alphabetically and limits to 6 cards
   *
   * @param item - The item to extract cross-references from
   * @returns Array of CardData objects for the Cards component (max 6)
   *
   * @remarks
   * External crate types are excluded since they may not have valid local paths.
   * Non-public items are also excluded to avoid linking to inaccessible documentation.
   */
  private extractCrossReferences(item: Item): CardData[] {
    const refs = new Set<Id>();
    const kind = getItemKind(item.inner);

    // Collect type references based on item kind
    switch (kind) {
      case "function":
        if ("function" in item.inner) {
          const fn = item.inner.function;
          // Scan parameter types
          for (const [, type] of fn.sig.inputs) {
            this.collectTypeReferences(type, refs);
          }
          // Scan return type
          if (fn.sig.output) {
            this.collectTypeReferences(fn.sig.output, refs);
          }
        }
        break;
      case "struct":
        if ("struct" in item.inner) {
          const struct = item.inner.struct;
          // Scan field types
          if (isPlainStruct(struct.kind)) {
            for (const fieldId of struct.kind.plain.fields) {
              const field = this.getItem(fieldId);
              if (field && "struct_field" in field.inner) {
                this.collectTypeReferences(field.inner.struct_field, refs);
              }
            }
          }
        }
        break;
      case "enum":
        if ("enum" in item.inner) {
          const enumDef = item.inner.enum;
          // Scan variant field types
          for (const variantId of enumDef.variants) {
            const variant = this.getItem(variantId);
            if (variant && "variant" in variant.inner) {
              const variantKind = variant.inner.variant.kind;
              if (isTupleVariant(variantKind)) {
                for (const fieldId of variantKind.tuple) {
                  if (fieldId) {
                    const field = this.getItem(fieldId);
                    if (field && "struct_field" in field.inner) {
                      this.collectTypeReferences(field.inner.struct_field, refs);
                    }
                  }
                }
              } else if (isStructVariant(variantKind)) {
                for (const fieldId of variantKind.struct.fields) {
                  const field = this.getItem(fieldId);
                  if (field && "struct_field" in field.inner) {
                    this.collectTypeReferences(field.inner.struct_field, refs);
                  }
                }
              }
            }
          }
        }
        break;
      case "trait":
        if ("trait" in item.inner) {
          const trait = item.inner.trait;
          // Scan supertraits
          for (const bound of trait.bounds) {
            if ("trait_bound" in bound) {
              const traitPath = bound.trait_bound.trait;
              if (traitPath.id) {
                refs.add(traitPath.id);
              }
            }
          }
        }
        break;
    }

    // Remove self-reference
    refs.delete(item.id);

    // Convert to CardData, filtering to local crate types only
    const cards: CardData[] = [];
    for (const refId of refs) {
      const refItem = this.getItem(refId);
      if (!refItem?.name) continue;

      // Only include public items from the current crate
      if (refItem.crate_id !== 0) continue;
      if (refItem.visibility !== "public") continue;

      const refKind = getItemKind(refItem.inner);
      if (refKind === "unknown") continue;

      // Link to the referenced item's canonical page; skip items that have
      // none (private, or only reachable through an impl).
      const href = this.itemUrls.get(String(refId));
      if (!href) continue;

      cards.push({
        title: refItem.name,
        href,
        description: summaryLine(refItem.docs) || `A ${refKind}`,
        icon: kindToIcon(refKind),
      });
    }

    // Sort by title and limit to 6 cards
    return cards.sort((a, b) => a.title.localeCompare(b.title)).slice(0, 6);
  }

  /**
   * Recursively collects type references from a rustdoc Type.
   *
   * Traverses the type structure to find all referenced type IDs:
   * - `resolved_path`: Named types - extracts ID and recurses into generic args
   * - `borrowed_ref`: References - recurses into the inner type
   * - `tuple`: Tuple types - recurses into each element type
   * - `slice`/`array`: Collection types - recurses into element type
   * - `raw_pointer`: Raw pointers - recurses into pointee type
   * - `impl_trait`: Impl trait bounds - extracts trait IDs
   * - `dyn_trait`: Dyn trait objects - extracts trait IDs
   * - `function_pointer`: Function pointer types - recurses into params and return
   * - `qualified_path`: Associated types - extracts self type references
   *
   * @param type - The rustdoc Type to extract references from
   * @param refs - Set to accumulate type IDs (mutated in place)
   * @param depth - Current recursion depth for overflow protection (default: 0)
   *
   * @remarks
   * This method handles the discriminated union of Type variants defined in types.ts.
   * Unknown type variants are silently ignored for forward compatibility.
   * Depth limiting prevents stack overflow from deeply nested generic types.
   */
  private collectTypeReferences(type: Type, refs: Set<Id>, depth = 0): void {
    // Prevent stack overflow from deeply nested types (e.g., Box<Box<Box<...>>>)
    if (depth > MAX_TYPE_DEPTH) {
      return;
    }

    if ("resolved_path" in type) {
      refs.add(type.resolved_path.id);
      this.collectPathArgReferences(type.resolved_path.args, refs, depth);
    } else if ("borrowed_ref" in type) {
      this.collectTypeReferences(type.borrowed_ref.type, refs, depth + 1);
    } else if ("tuple" in type) {
      for (const t of type.tuple) {
        this.collectTypeReferences(t, refs, depth + 1);
      }
    } else if ("slice" in type) {
      this.collectTypeReferences(type.slice, refs, depth + 1);
    } else if ("array" in type) {
      this.collectTypeReferences(type.array.type, refs, depth + 1);
    } else if ("raw_pointer" in type) {
      this.collectTypeReferences(type.raw_pointer.type, refs, depth + 1);
    } else if ("impl_trait" in type) {
      for (const bound of type.impl_trait) {
        if ("trait_bound" in bound) {
          refs.add(bound.trait_bound.trait.id);
          // `impl Iterator<Item = Foo>` must also record `Foo`.
          this.collectPathArgReferences(bound.trait_bound.trait.args, refs, depth);
        }
      }
    } else if ("dyn_trait" in type) {
      for (const polyTrait of type.dyn_trait.traits) {
        refs.add(polyTrait.trait.id);
        // `dyn Foo<Bar>` must also record `Bar`.
        this.collectPathArgReferences(polyTrait.trait.args, refs, depth);
      }
    } else if ("function_pointer" in type) {
      // Traverse function pointer parameter and return types
      const fnPtr = type.function_pointer;
      for (const [, paramType] of fnPtr.sig.inputs) {
        this.collectTypeReferences(paramType, refs, depth + 1);
      }
      if (fnPtr.sig.output) {
        this.collectTypeReferences(fnPtr.sig.output, refs, depth + 1);
      }
    } else if ("qualified_path" in type) {
      const qp = type.qualified_path;
      // Self type: `<T as …>::Assoc` contributes `T`.
      this.collectTypeReferences(qp.self_type, refs, depth + 1);
      // Trait and its generic args: `<T as Trait<U>>::Assoc` must also
      // contribute `Trait` and `U`. Previously both were dropped.
      if (qp.trait) {
        refs.add(qp.trait.id);
        this.collectPathArgReferences(qp.trait.args, refs, depth);
      }
      // The qualified_path's own `args` (associated-type-on-assoc args,
      // e.g. `<T as Iterator>::Item<K>`) must be traversed too.
      this.collectPathArgReferences(qp.args, refs, depth);
    }
  }

  /**
   * Walk a `Path.args` structure and collect type references from every
   * type-valued generic arg, associated-type constraint RHS, and the
   * inputs/output of parenthesized (Fn-trait) arg forms.
   */
  private collectPathArgReferences(
    args: GenericArgs | undefined,
    refs: Set<Id>,
    depth: number
  ): void {
    if (!args) return;
    if ("angle_bracketed" in args) {
      for (const arg of args.angle_bracketed.args) {
        if ("type" in arg) {
          this.collectTypeReferences(arg.type, refs, depth + 1);
        }
      }
      for (const c of args.angle_bracketed.constraints ?? []) {
        if ("equality" in c.binding && "type" in c.binding.equality) {
          this.collectTypeReferences(c.binding.equality.type, refs, depth + 1);
        }
      }
    } else if ("parenthesized" in args) {
      for (const t of args.parenthesized.inputs) {
        this.collectTypeReferences(t, refs, depth + 1);
      }
      if (args.parenthesized.output) {
        this.collectTypeReferences(args.parenthesized.output, refs, depth + 1);
      }
    }
  }

  /**
   * Renders a single item to MDX content with appropriate formatting.
   *
   * This is the central dispatch method for item rendering. It handles:
   * 1. **Deprecation warnings**: Renders a warn Callout with version and note
   * 2. **Feature gates**: Detects `#[cfg(feature = "...")]` and renders info Callout
   * 3. **Safety warnings**: Renders error Callout for unsafe functions/traits
   * 4. **Item-specific rendering**: Dispatches to specialized render methods:
   *    - `renderFunction()` - Functions with signatures and docs
   *    - `renderStruct()` - Structs with fields
   *    - `renderUnion()` - Unions with fields
   *    - `renderEnum()` - Enums with variants
   *    - `renderTrait()` - Traits with required methods
   *    - `renderTypeAlias()` - Type aliases
   *    - `renderConstant()` - Constants and statics
   *    - `renderMacro()` - Declarative macros
   * 5. **Panics/Errors callouts**: For functions, extracts `# Panics` and `# Errors`
   *    sections from docs and renders as callouts
   *
   * @param item - The item to render
   * @returns MDX content string for the item
   */
  private renderItem(page: PageEntry): string {
    const { item, name } = page;
    const kind = getItemKind(item.inner);
    const sections: string[] = [];

    // Deprecation warning using FumaDocs Callout component
    if (item.deprecation) {
      const sinceText = item.deprecation.since ? ` since ${item.deprecation.since}` : "";
      const noteText = item.deprecation.note ?? "This item is deprecated.";
      sections.push(
        `<Callout type="warn" title="Deprecated${sinceText}">\n${noteText}\n</Callout>`
      );
      sections.push("");
    }

    // Feature gate callout: #[doc(cfg)] / #[cfg], module gates inherited.
    const gate = this.renderGate(page.gates);
    if (gate) {
      sections.push(gate);
      sections.push("");
    }

    // Safety callout for unsafe items
    const isUnsafe = this.isUnsafeItem(item);
    if (isUnsafe) {
      sections.push(renderSafetyCallout(this.docsFor(item, 0)));
      sections.push("");
    }

    // Render based on item kind
    switch (kind) {
      case "function":
        sections.push(this.renderFunction(item, name));
        break;
      case "struct":
        sections.push(this.renderStruct(item, name));
        break;
      case "union":
        sections.push(this.renderUnion(item, name));
        break;
      case "enum":
        sections.push(this.renderEnum(item, name));
        break;
      case "trait":
        sections.push(this.renderTrait(item, name));
        break;
      case "type_alias":
        sections.push(this.renderTypeAlias(item, name));
        break;
      case "constant":
      case "static":
        sections.push(this.renderConstant(item, name));
        break;
      case "macro":
      case "proc_derive":
      case "proc_attribute":
        sections.push(this.renderMacro(item, name));
        break;
      default:
        sections.push(`## ${name}`);
        this.pushDocs(sections, item, 2);
    }

    // Add panics callout if docs contain # Panics section (for functions)
    if (kind === "function") {
      const panicsCallout = renderPanicsCallout(this.docsFor(item, 0));
      if (panicsCallout) {
        sections.push("");
        sections.push(panicsCallout);
      }

      const errorsCallout = renderErrorsCallout(this.docsFor(item, 0));
      if (errorsCallout) {
        sections.push("");
        sections.push(errorsCallout);
      }
    }

    return sections.join("\n");
  }

  /**
   * Check if an item is marked as unsafe.
   */
  private isUnsafeItem(item: Item): boolean {
    if ("function" in item.inner) {
      return item.inner.function.header.is_unsafe;
    }
    if ("trait" in item.inner) {
      return item.inner.trait.is_unsafe;
    }
    return false;
  }

  /**
   * Feature-gate callout for a conjunction of cfg predicates, with a
   * `Cargo.toml` snippet naming the real package and version.
   */
  private renderGate(gates: Cfg[]): string {
    const text = describeCfgs(gates);
    if (!text) return "";
    const crateName =
      this.options.packageName ?? this.getItem(this.crate.root)?.name ?? "your-crate";
    return renderCfgCallout(text, requiredFeatures(gates), crateName, this.crate.crate_version);
  }

  /**
   * Renders a function item to MDX with signature and documentation.
   *
   * Output format:
   * ```
   * ## `function_name`
   *
   * ```rust
   * fn function_name(params) -> ReturnType
   * ```
   *
   * [Documentation from docs field]
   * ```
   *
   * @param item - The function item to render (must have 'function' in inner)
   * @returns MDX content string for the function
   */
  private renderFunction(item: Item, name: string): string {
    if (!("function" in item.inner)) return "";
    const fn = item.inner.function;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatFunctionSignature(name, fn));
    sections.push("```");

    this.pushDocs(sections, item, 2, this.calloutSections(item));

    return sections.join("\n");
  }

  /**
   * Renders a struct item to MDX with signature, documentation, and fields.
   *
   * Output format:
   * ```
   * ## `StructName`
   *
   * ```rust
   * struct StructName<T> { ... }
   * ```
   *
   * [Documentation]
   *
   * ### Fields
   *
   * - `field_name`: `FieldType` - Field description
   * ```
   *
   * Only plain structs (with named fields) have their fields rendered.
   * Tuple structs and unit structs show only the signature.
   *
   * @param item - The struct item to render (must have 'struct' in inner)
   * @returns MDX content string for the struct
   */
  private renderStruct(item: Item, name: string): string {
    if (!("struct" in item.inner)) return "";
    const struct = item.inner.struct;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatStructSignature(name, struct));
    sections.push("```");

    this.pushDocs(sections, item, 2, this.calloutSections(item));

    // Render fields
    if (isPlainStruct(struct.kind)) {
      const fields = struct.kind.plain.fields;
      if (fields.length > 0) {
        sections.push("");
        sections.push("### Fields");
        sections.push("");
        for (const fieldId of fields) {
          const field = this.getItem(fieldId);
          if (!field) continue;
          sections.push(this.fieldLine(field.name ?? "_", field));
        }
      }
    }

    return sections.join("\n");
  }

  /**
   * Renders a union item to MDX with signature, documentation, and fields.
   *
   * Output format is similar to struct but for Rust unions:
   * ```
   * ## `UnionName`
   *
   * ```rust
   * union UnionName { ... }
   * ```
   *
   * [Documentation]
   *
   * ### Fields
   *
   * - `field_name`: `FieldType` - Field description
   * ```
   *
   * @param item - The union item to render (must have 'union' in inner)
   * @returns MDX content string for the union
   */
  private renderUnion(item: Item, name: string): string {
    if (!("union" in item.inner)) return "";
    const union = item.inner.union;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatUnionSignature(name, union));
    sections.push("```");

    this.pushDocs(sections, item, 2, this.calloutSections(item));

    // Render fields
    if (union.fields.length > 0) {
      sections.push("");
      sections.push("### Fields");
      sections.push("");
      for (const fieldId of union.fields) {
        const field = this.getItem(fieldId);
        if (!field) continue;
        sections.push(this.fieldLine(field.name ?? "_", field));
      }
    }

    return sections.join("\n");
  }

  /**
   * Renders an enum item to MDX with signature, documentation, and variants.
   *
   * Output format:
   * ```
   * ## `EnumName`
   *
   * ```rust
   * enum EnumName { Variant1, Variant2(T), Variant3 { field: U } }
   * ```
   *
   * [Documentation]
   *
   * ### Variants
   *
   * #### `Variant1`
   * [Variant documentation]
   *
   * #### `Variant2(T)`
   * **Fields:**
   * - `0`: `T` - Field description
   *
   * #### `Variant3 { ... }`
   * **Fields:**
   * - `field`: `U` - Field description
   * ```
   *
   * Handles all three variant kinds: unit, tuple, and struct.
   *
   * @param item - The enum item to render (must have 'enum' in inner)
   * @returns MDX content string for the enum
   */
  private renderEnum(item: Item, name: string): string {
    if (!("enum" in item.inner)) return "";
    const enumDef = item.inner.enum;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatEnumSignature(name, enumDef));
    sections.push("```");

    this.pushDocs(sections, item, 2, this.calloutSections(item));

    // Render variants
    if (enumDef.variants.length > 0) {
      sections.push("");
      sections.push("### Variants");
      sections.push("");
      for (const variantId of enumDef.variants) {
        const variantItem = this.getItem(variantId);
        if (!variantItem || !("variant" in variantItem.inner)) continue;

        const variant = variantItem.inner.variant;
        const variantName = variantItem.name ?? "Unknown";

        // Render variant with its fields
        const variantSig = this.formatVariantSignature(variantName, variant);
        sections.push(
          this.memberHeading(variantSig, this.anchorsFor(item).get(String(variantItem.id)))
        );

        this.pushDocs(sections, variantItem, 4);

        // Render struct-style variant fields
        if (isStructVariant(variant.kind)) {
          const fields = variant.kind.struct.fields;
          if (fields.length > 0) {
            sections.push("");
            sections.push("**Fields:**");
            sections.push("");
            for (const fieldId of fields) {
              const field = this.getItem(fieldId);
              if (!field) continue;
              sections.push(this.fieldLine(field.name ?? "_", field));
            }
          }
        }

        // Render tuple-style variant fields
        if (isTupleVariant(variant.kind)) {
          const tupleFields = variant.kind.tuple.filter((id): id is Id => id !== null);
          if (tupleFields.length > 0) {
            sections.push("");
            sections.push("**Fields:**");
            sections.push("");
            for (let i = 0; i < tupleFields.length; i++) {
              const field = this.getItem(tupleFields[i]);
              if (!field) continue;
              sections.push(this.fieldLine(String(i), field));
            }
          }
        }

        sections.push("");
      }
    }

    return sections.join("\n");
  }

  /**
   * Formats an enum variant signature showing its structure.
   *
   * Produces different formats based on variant kind:
   * - **Unit variant**: `Foo` or `Foo = 42` (with discriminant)
   * - **Tuple variant**: `Foo(T, U)` with field types
   * - **Struct variant**: `Foo { ... }` (abbreviated form)
   *
   * @param name - The variant name
   * @param variant - The variant data containing kind and optional discriminant
   * @returns Formatted variant signature string
   *
   * @example
   * ```typescript
   * formatVariantSignature("None", { kind: { plain: {} } })
   * // Returns: "None"
   *
   * formatVariantSignature("Some", { kind: { tuple: [fieldId] } })
   * // Returns: "Some(T)"
   *
   * formatVariantSignature("Point", { kind: { struct: { fields: [...] } } })
   * // Returns: "Point { ... }"
   * ```
   */
  private formatVariantSignature(
    name: string,
    variant: { kind: VariantKind; discriminant?: { expr: string; value: string } }
  ): string {
    if (isPlainVariant(variant.kind)) {
      // Unit variant: Foo
      if (variant.discriminant) {
        return `${name} = ${variant.discriminant.expr}`;
      }
      return name;
    }
    if (isTupleVariant(variant.kind)) {
      // Tuple variant: Foo(T, U)
      const fields = variant.kind.tuple
        .map((fieldId) => {
          if (fieldId === null) return "_";
          const field = this.getItem(fieldId);
          if (!field || !("struct_field" in field.inner)) return "...";
          return formatType(field.inner.struct_field);
        })
        .join(", ");
      return `${name}(${fields})`;
    }
    if (isStructVariant(variant.kind)) {
      // Struct variant: Foo { field: Type }
      return `${name} { ... }`;
    }
    return name;
  }

  /**
   * Renders a trait item to MDX with signature, documentation, and required methods.
   *
   * Output format:
   * ```
   * ## `TraitName`
   *
   * ```rust
   * trait TraitName: SuperTrait { ... }
   * ```
   *
   * [Documentation]
   *
   * ### Required Methods
   *
   * ```rust
   * fn method_name(&self) -> ReturnType
   * ```
   * [Method documentation]
   * ```
   *
   * Only function items from the trait's items list are rendered as methods.
   * Associated types, constants, and other items are not currently rendered.
   *
   * @param item - The trait item to render (must have 'trait' in inner)
   * @returns MDX content string for the trait
   */
  private renderTrait(item: Item, name: string): string {
    if (!("trait" in item.inner)) return "";
    const trait = item.inner.trait;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatTraitSignature(name, trait));
    sections.push("```");

    this.pushDocs(sections, item, 2, this.calloutSections(item));

    const members = trait.items
      .map((id) => this.getItem(id))
      .filter((i): i is Item => i !== undefined);
    const anchors = this.anchorsFor(item);
    const groups: [string, Item[]][] = [
      ["Associated Types", members.filter((m) => "assoc_type" in m.inner)],
      ["Associated Constants", members.filter((m) => "assoc_const" in m.inner)],
      [
        "Required Methods",
        members.filter((m) => "function" in m.inner && !m.inner.function.has_body),
      ],
      [
        "Provided Methods",
        members.filter((m) => "function" in m.inner && m.inner.function.has_body),
      ],
    ];
    for (const [title, group] of groups) {
      if (group.length === 0) continue;
      sections.push("");
      sections.push(`### ${title}`);
      sections.push("");
      for (const member of group) {
        sections.push(this.memberHeading(member.name ?? "", anchors.get(String(member.id))));
        sections.push("");
        sections.push("```rust");
        sections.push(this.formatMemberSignature(member));
        sections.push("```");
        this.pushDocs(sections, member, 4);
        sections.push("");
      }
    }

    const implementors = this.renderImplementors(trait.implementations);
    if (implementors) {
      sections.push("");
      sections.push("### Implementors");
      sections.push("");
      sections.push(implementors);
    }

    return sections.join("\n");
  }

  /**
   * Signature of a trait or impl member: a method, `type Name: Bounds = T;`
   * or `const NAME: T = value;`.
   */
  private formatMemberSignature(member: Item): string {
    const name = member.name ?? "";
    if ("function" in member.inner) return formatFunctionSignature(name, member.inner.function);
    if ("assoc_type" in member.inner) {
      const at = member.inner.assoc_type;
      const bounds = at.bounds.map((b) => formatGenericBound(b)).filter(Boolean);
      const where = at.generics.where_predicates.length > 0 ? " where ..." : "";
      return (
        `type ${name}${formatGenerics(at.generics)}` +
        (bounds.length > 0 ? `: ${bounds.join(" + ")}` : "") +
        (at.type ? ` = ${formatType(at.type)}` : "") +
        `${where};`
      );
    }
    if ("assoc_const" in member.inner) {
      const ac = member.inner.assoc_const as { type: Type; value?: string | null };
      return `const ${name}: ${formatType(ac.type)}${ac.value != null ? ` = ${ac.value}` : ""};`;
    }
    return name;
  }

  /**
   * Bullet list of the types implementing a trait, linked to their pages
   * when they have one.
   */
  private renderImplementors(implIds: Id[]): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const implId of implIds) {
      const impl = this.getItem(implId);
      if (!impl || !("impl" in impl.inner)) continue;
      const implDef = impl.inner.impl;
      if (implDef.is_synthetic) continue;
      // Name the implementing type as its page does (`Circle`, not the
      // `shapes::Circle` path the impl happened to be written with).
      const forPath = "resolved_path" in implDef.for ? implDef.for.resolved_path : undefined;
      const target = forPath
        ? (getPathName(forPath).split("::").pop() ?? "") + formatGenericArgs(forPath.args)
        : formatType(implDef.for);
      const key = `${implDef.is_negative ? "!" : ""}${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const href = forPath ? this.resolveIdUrl(forPath.id) : null;
      const label = inlineCode(key);
      lines.push(
        `- ${href ? `[${label}](${href})` : label}${implDef.blanket_impl ? " (blanket)" : ""}`
      );
    }
    return lines.sort((a, b) => a.localeCompare(b)).join("\n");
  }

  /**
   * Renders a type alias item to MDX with signature and documentation.
   *
   * Output format:
   * ```
   * ## `AliasName`
   *
   * ```rust
   * type AliasName<T> = UnderlyingType<T>;
   * ```
   *
   * [Documentation]
   * ```
   *
   * @param item - The type alias item to render (must have 'type_alias' in inner)
   * @returns MDX content string for the type alias
   */
  private renderTypeAlias(item: Item, name: string): string {
    if (!("type_alias" in item.inner)) return "";
    const alias = item.inner.type_alias;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(`type ${name}${formatGenerics(alias.generics)} = ${formatType(alias.type)};`);
    sections.push("```");

    this.pushDocs(sections, item, 2, this.calloutSections(item));

    return sections.join("\n");
  }

  /**
   * Renders a constant or static item to MDX with signature and documentation.
   *
   * Handles both `const` and `static` items:
   *
   * **Constant output:**
   * ```
   * ## `CONST_NAME`
   *
   * ```rust
   * const CONST_NAME: Type = value;
   * ```
   * ```
   *
   * **Static output:**
   * ```
   * ## `STATIC_NAME`
   *
   * ```rust
   * static mut STATIC_NAME: Type = expr;
   * ```
   * ```
   *
   * @param item - The constant/static item to render (must have 'constant' or 'static' in inner)
   * @returns MDX content string for the constant or static
   */
  private renderConstant(item: Item, name: string): string {
    const sections: string[] = [];
    sections.push(`## \`${name}\``);

    if ("constant" in item.inner) {
      const constant = item.inner.constant;
      const typeName = formatType(constant.type);
      sections.push("");
      sections.push("```rust");
      // Show value if available, otherwise just the expression
      const constExpr = constant.const;
      const value = constExpr.value ?? constExpr.expr;
      sections.push(`const ${name}: ${typeName} = ${value};`);
      sections.push("```");
    } else if ("static" in item.inner) {
      const staticDef = item.inner.static;
      const typeName = formatType(staticDef.type);
      sections.push("");
      sections.push("```rust");
      sections.push(
        `static ${staticDef.is_mutable ? "mut " : ""}${name}: ${typeName} = ${staticDef.expr};`
      );
      sections.push("```");
    }

    this.pushDocs(sections, item, 2, this.calloutSections(item));

    return sections.join("\n");
  }

  /**
   * Renders a declarative macro item to MDX with definition and documentation.
   *
   * Output format:
   * ```
   * ## `macro_name!`
   *
   * ```rust
   * macro_rules! macro_name { ... }
   * ```
   *
   * [Documentation]
   * ```
   *
   * Note: The macro name in the heading includes the `!` suffix for clarity.
   *
   * @param item - The macro item to render (must have 'macro' in inner)
   * @returns MDX content string for the macro
   */
  private renderMacro(item: Item, name: string): string {
    const sections: string[] = [];

    if ("proc_macro" in item.inner) {
      // Procedural macros: show how they are invoked.
      const pm = item.inner.proc_macro;
      const usage =
        pm.kind === "derive"
          ? `#[derive(${name})]`
          : pm.kind === "attr"
            ? `#[${name}]`
            : `${name}!()`;
      sections.push(`## ${inlineCode(pm.kind === "bang" ? `${name}!` : name)}`);
      sections.push("");
      sections.push("```rust");
      sections.push(usage);
      sections.push("```");
      if (pm.helpers.length > 0) {
        sections.push("");
        sections.push(
          `Helper attributes: ${pm.helpers.map((h) => inlineCode(`#[${h}]`)).join(", ")}`
        );
      }
    } else {
      sections.push(`## \`${name}!\``);
      sections.push("");
      if ("macro" in item.inner) {
        sections.push("```rust");
        sections.push(item.inner.macro);
        sections.push("```");
      }
    }

    this.pushDocs(sections, item, 2, this.calloutSections(item));

    return sections.join("\n");
  }

  /**
   * Renders an impl block to MDX with header and method signatures.
   *
   * Output format:
   * ```
   * ### `impl<T> TraitName for TypeName`
   *
   * ```rust
   * fn method(&self) -> ReturnType
   * ```
   * [Method documentation]
   * ```
   *
   * The impl header includes:
   * - `unsafe` prefix if the impl is unsafe
   * - Generic parameters from the impl block
   * - Trait name (with full path if available) for trait implementations
   * - The implementing type
   *
   * @param impl - The impl item to render (must have 'impl' in inner)
   * @returns MDX content string for the implementation block
   */
  private renderImpl(impl: Item, owner?: Item, ownerGates: Cfg[] = []): string {
    if (!("impl" in impl.inner)) return "";
    const implDef = impl.inner.impl;
    const sections: string[] = [];

    // Format impl header
    let header = "impl";
    if (implDef.is_unsafe) header = "unsafe " + header;
    header += formatGenerics(implDef.generics);

    if (implDef.trait) {
      // Render the trait as a Type so its generic args (e.g. From<T>, TryFrom<U>)
      // are preserved. Prefer the canonical full path from the paths table
      // (e.g. core::convert::From) over the bare name.
      const traitPath = this.getPath(implDef.trait.id);
      const canonical = traitPath?.join("::");
      const traitType: Type = {
        resolved_path: {
          path: canonical ?? getPathName(implDef.trait),
          id: implDef.trait.id,
          args: implDef.trait.args,
        },
      };
      // `impl !Send for T` must not render as `impl Send for T` — the `!`
      // flips the semantic.
      const negate = implDef.is_negative ? "!" : "";
      header += ` ${negate}${formatType(traitType)} for`;
    }
    header += ` ${formatType(implDef.for)}`;

    sections.push(`### ${inlineCode(header)}`);
    sections.push("");

    // An impl gated on more than the type itself (e.g. a feature-only
    // inherent impl) says so under its header.
    const ownerKeys = new Set(ownerGates.map((g) => JSON.stringify(g)));
    const extra = dedupeCfgs(itemCfgs(impl)).filter((g) => !ownerKeys.has(JSON.stringify(g)));
    if (extra.length > 0) {
      sections.push(`*${describeCfgs(extra)}*`);
      sections.push("");
    }

    const children = implDef.items
      .map((id) => this.getItem(id))
      .filter((i): i is Item => i !== undefined);

    // Associated types and constants of a trait impl, as one code block.
    const assoc = children.filter((c) => "assoc_type" in c.inner || "assoc_const" in c.inner);
    if (implDef.trait && assoc.length > 0) {
      sections.push("```rust");
      for (const member of assoc) sections.push(this.formatMemberSignature(member));
      sections.push("```");
      sections.push("");
    }

    // Methods, each under its own anchored heading so it shows in the table
    // of contents and intra-doc links can target it. Trait-impl methods are
    // shown only when documented (the trait's page documents the rest).
    const anchors = owner ? this.anchorsFor(owner) : new Map<string, string>();
    for (const member of children) {
      const anchor = anchors.get(String(member.id));
      if (implDef.trait && anchor === undefined) continue;
      if (!implDef.trait && !("function" in member.inner) && !("assoc_const" in member.inner)) {
        continue;
      }
      if (implDef.trait && !("function" in member.inner)) continue;

      sections.push(this.memberHeading(member.name ?? "", anchor));
      sections.push("");
      sections.push("```rust");
      sections.push(this.formatMemberSignature(member));
      sections.push("```");
      this.pushDocs(sections, member, 4);
      sections.push("");
    }

    return sections.join("\n");
  }

  /** Impl ids recorded on a struct, enum or union. */
  private implIdsOf(item: Item): Id[] {
    if ("struct" in item.inner) return item.inner.struct.impls;
    if ("enum" in item.inner) return item.inner.enum.impls;
    if ("union" in item.inner) return item.inner.union.impls;
    return [];
  }

  /**
   * The implementations rendered on a type's page: inherent impls and trait
   * impls, without blanket impls (`impl<T> From<T> for T`, noise on every
   * type) and synthetic auto-trait impls (listed compactly instead, see
   * {@link renderAutoTraits}).
   */
  private getImplementations(item: Item): Item[] {
    const results: Item[] = [];
    for (const implId of this.implIdsOf(item)) {
      const impl = this.getItem(implId);
      if (!impl || !("impl" in impl.inner)) continue;
      if (impl.inner.impl.blanket_impl || impl.inner.impl.is_synthetic) continue;
      results.push(impl);
    }
    return results;
  }

  // Formatting helpers

  /**
   * Format frontmatter data as YAML with proper escaping.
   * Uses the yaml library for safe serialization of special characters,
   * newlines, colons, and other YAML-sensitive content.
   *
   * @param data - Frontmatter key-value pairs
   * @returns YAML frontmatter block with --- delimiters
   */
  private formatFrontmatter(data: Record<string, unknown>): string {
    // Use yaml library for proper escaping of special characters
    const yamlContent = stringify(data, {
      lineWidth: 120, // Reasonable line width for readability
      defaultStringType: "QUOTE_DOUBLE", // Quote strings by default for safety
      defaultKeyType: "PLAIN", // Keep keys unquoted
    }).trim();
    return `---\n${yamlContent}\n---`;
  }

  /**
   * One `- \`name\`: \`Type\` - first doc line` bullet for a struct, union
   * or variant field. The type is always inline code: rendered bare,
   * `Option<String>` or `Vec<[u8; 32]>` would be parsed by MDX as JSX.
   */
  private fieldLine(name: string, field: Item): string {
    const doc = firstLine(this.docsFor(field, 0));
    return `- ${inlineCode(name)}: ${inlineCode(this.formatFieldType(field))}${doc ? ` - ${doc}` : ""}`;
  }

  /**
   * Extracts and formats the type of a struct or union field.
   *
   * Looks for the `struct_field` variant in the item's inner data and
   * formats the type using the shared `formatType()` function.
   *
   * @param field - A field item (must have 'struct_field' in inner for valid output)
   * @returns Formatted type string, or "unknown" if not a valid field item
   */
  private formatFieldType(field: Item): string {
    if ("struct_field" in field.inner) {
      return formatType(field.inner.struct_field);
    }
    // Log warning for unexpected field structure (forward compatibility)
    this.warn(
      `Expected struct_field for "${field.name ?? String(field.id)}" but found: ${Object.keys(field.inner).join(", ")}`
    );
    return "unknown";
  }
}

// Default options

/**
 * Default frontmatter generator for FumaDocs v14+.
 * Generates title, description, and icon based on item kind.
 */
function defaultFrontmatter(item: Item, path: string[]): Record<string, unknown> {
  const kind = getItemKind(item.inner);
  // Handle unknown kinds gracefully with default icon
  const icon = kind === "unknown" ? "FileText" : kindToIcon(kind);
  return {
    title: path[path.length - 1] ?? item.name ?? "API",
    description:
      summaryLine(item.docs) || `Documentation for ${path[path.length - 1] ?? item.name}`,
    icon,
  };
}

/**
 * Default filter function that includes only public items.
 *
 * @param item - The item to evaluate for inclusion
 * @returns true if the item has public visibility, false otherwise
 */
function defaultFilter(item: Item): boolean {
  // Only include public items
  return item.visibility === "public";
}

// Utilities

/**
 * Maps an item kind to its plural filename for groupBy "kind" mode.
 *
 * @param kind - The item kind to convert
 * @returns Pluralized filename (e.g., "struct" -> "structs")
 *
 * @example
 * kindToFilename("struct") // "structs"
 * kindToFilename("type_alias") // "types"
 */
function kindToFilename(kind: ItemKind): string {
  const map: Partial<Record<ItemKind, string>> = {
    struct: "structs",
    union: "unions",
    enum: "enums",
    trait: "traits",
    function: "functions",
    type_alias: "types",
    constant: "constants",
    static: "statics",
    macro: "macros",
    proc_derive: "derives",
    proc_attribute: "attributes",
  };
  return map[kind] ?? kind;
}

/**
 * Maps an item kind to its display title for section headings.
 *
 * @param kind - The item kind to convert
 * @returns Human-readable plural title (e.g., "struct" -> "Structs")
 *
 * @example
 * kindToTitle("struct") // "Structs"
 * kindToTitle("type_alias") // "Type Aliases"
 */
function kindToTitle(kind: ItemKind): string {
  const map: Partial<Record<ItemKind, string>> = {
    struct: "Structs",
    union: "Unions",
    enum: "Enums",
    trait: "Traits",
    function: "Functions",
    type_alias: "Type Aliases",
    constant: "Constants",
    static: "Statics",
    macro: "Macros",
    proc_derive: "Derive Macros",
    proc_attribute: "Attribute Macros",
  };
  return map[kind] ?? kind;
}

/**
 * Map item kinds to FumaDocs-compatible icon names.
 * These icons work with lucide-react which FumaDocs uses by default.
 *
 * @param kind - The rustdoc item kind
 * @returns Icon name for FumaDocs frontmatter
 */
function kindToIcon(kind: ItemKind): string {
  const map: Partial<Record<ItemKind, string>> = {
    struct: "Box",
    union: "Layers",
    enum: "List",
    trait: "Puzzle",
    function: "Code",
    type_alias: "Type",
    constant: "Hash",
    static: "Database",
    macro: "Wand2",
    proc_derive: "Wand2",
    proc_attribute: "Wand2",
    module: "Folder",
  };
  return map[kind] ?? "FileText";
}
