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
  Variant,
  Type,
  GenericArgs,
} from "./types.js";
import { getItemKind, isPlainStruct, isTupleStruct, getPathName } from "./types.js";
import { ensureRustdocCrate } from "./validation.js";
import { RustdocError, ErrorCode } from "./errors.js";
import {
  createMarkdownParser,
  type MarkdownParser,
  rewriteDocLinks,
  demoteHeadings,
  mapProse,
  summaryLine,
  summaryMarkdown,
  sanitizeDocstring,
  takeSection,
} from "./docs.js";
import { itemCfgs, dedupeCfgs, describeCfgs, requiredFeatures, type Cfg } from "./cfg.js";

import {
  formatType,
  formatFunctionSignature,
  formatStructSignature,
  formatUnionSignature,
  formatEnumSignature,
  formatTraitSignature,
  formatGenerics,
  formatWhereClause,
  formatGenericBound,
  formatGenericArgs,
  renderTabs,
  renderCards,
  renderSafetyCallout,
  renderCfgCallout,
  renderDeprecation,
  renderCallout,
  type CardData,
} from "./renderer/index.js";

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
  "trait_alias",
  "function",
  "type_alias",
  "constant",
  "static",
  "macro",
  "proc_derive",
  "proc_attribute",
  "foreign_type",
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
  /** Explicit item heading id on a shared kind page. */
  anchor?: string;
  /** Allocated on the first doc link that tests a member heading at this placement. */
  memberHeadings?: Set<string>;
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
  /** Local target, whose summary line is read when the index renders. */
  target?: Item;
  via: Item;
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
  /** Group-page heading ids already claimed. */
  anchors: Map<string, number>;
  /** Glob paths can converge on the same use at the same destination. */
  expandedUses: Set<Id>;
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

/**
 * Attributes that are part of an item's API, as Rust source lines for the
 * top of its signature block: `#[non_exhaustive]`, `#[must_use]` (with
 * its reason) and `#[repr(..)]`. Handles the string attributes of older
 * format versions and the structured ones of format 56+.
 */
export function attrLines(item: Pick<Item, "attrs">): string[] {
  const lines: string[] = [];
  const known = /^#\[(non_exhaustive|must_use|repr)\b/;
  for (const attr of item.attrs) {
    if (typeof attr === "string") {
      const text = attr.startsWith("#[") ? attr : `#[${attr}]`;
      if (known.test(text)) lines.push(text);
      continue;
    }
    if ("must_use" in attr) {
      const reason = (attr.must_use as { reason?: string | null } | null)?.reason;
      lines.push(reason ? `#[must_use = ${JSON.stringify(reason)}]` : "#[must_use]");
    } else if ("repr" in attr) {
      const r = attr.repr as {
        kind?: string;
        align?: number | null;
        packed?: number | null;
        int?: string | null;
      };
      const parts: string[] = [];
      if (r.kind && r.kind !== "rust") parts.push(r.kind === "c" ? "C" : r.kind);
      if (r.int) parts.push(r.int);
      if (r.align != null) parts.push(`align(${r.align})`);
      if (r.packed != null) parts.push(r.packed === 1 ? "packed" : `packed(${r.packed})`);
      if (parts.length > 0) lines.push(`#[repr(${parts.join(", ")})]`);
    } else if ("other" in attr && typeof attr.other === "string" && known.test(attr.other)) {
      lines.push(attr.other);
    }
  }
  return lines;
}

/** Spell rustdoc's effective scope as Rust visibility for an included tuple field. */
function fieldVisibility(visibility: Item["visibility"]): string {
  if (visibility === "public") return "pub ";
  if (visibility === "crate") return "pub(crate) ";
  if (visibility === "default") return "";
  const scope = visibility.restricted.path.replace(/^::/, "crate::");
  return `pub(in ${scope}) `;
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

/** Public std re-exports whose defining paths occur in rustdoc's paths table. */
const STD_OWNERS: Record<string, string> = {
  "std::vec::Vec": "alloc::vec::Vec",
  "std::string::String": "alloc::string::String",
  "std::option::Option": "core::option::Option",
  "std::result::Result": "core::result::Result",
};

/** Common unqualified members for which the standard API fixes the rustdoc anchor kind. */
const STD_MEMBER_KINDS: Record<string, string> = {
  "alloc::vec::Vec::new": "method",
  "alloc::string::String::new": "method",
  "core::option::Option::Some": "variant",
  "core::option::Option::None": "variant",
  "core::result::Result::Ok": "variant",
  "core::result::Result::Err": "variant",
};

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

  // Rust identifiers such as CON are device names even with a .mdx extension on Windows.
  sanitized = sanitized.replace(/[. ]+$/, "_");
  if (/^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(sanitized))
    sanitized = "_" + sanitized;

  if (Buffer.byteLength(sanitized) > MAX_FILENAME_LENGTH) {
    const ext = /\.[^.]{1,8}$/.exec(sanitized)?.[0] ?? "";
    sanitized =
      truncateUtf8(
        ext ? sanitized.slice(0, -ext.length) : sanitized,
        MAX_FILENAME_LENGTH - Buffer.byteLength(ext)
      ) + ext;
  }

  // Final check: if sanitization resulted in empty string (e.g., "../../"), return "unnamed"
  if (!sanitized || sanitized.trim() === "") {
    return "unnamed";
  }

  return sanitized;
}
/** Limit a path component in bytes without splitting a Unicode scalar. */
function truncateUtf8(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > limit) break;
    end += char.length;
  }
  return text.slice(0, end);
}

export { sanitizeDocstring };

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
  return message.replace(/[\x00-\x1f\x7f]/g, "?");
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
  /** Receives generation warnings; defaults to console.warn. */
  onWarning?: (message: string) => void;
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
type OptionalKeys = "externalPages" | "sourceUrlBase" | "sourceRef" | "packageName" | "frontmatter";

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
  private owners = new Map<string, PageEntry>();
  private htmlTargets = new Map<string, Id>();
  private moduleIds = new Set<Id>();
  private externalTypePaths?: Map<string, ItemSummary>;
  private membersIndexed = false;
  private flatNames = new Set(["index", "meta"]);
  private filenameSuffixes = new WeakMap<Set<string>, Map<string, number>>();
  private parseMarkdown?: MarkdownParser;
  private plainSummaries = new WeakMap<Item, { source: string; value: string }>();
  private resolvedDocs = new Map<Id, string>();
  private summaries = new Map<Id, string>();
  private calloutDocs = new Map<Id, { rest: string; sections: Map<string, string> }>();
  /** Processed docstrings by `id:demote`. */
  private docsCache = new Map<string, string>();
  /** Member heading ids at each placement, including kind-page prefixes. */
  private anchorCache = new Map<string, Map<string, string>>();

  constructor(crate: RustdocCrate, options: GeneratorOptions) {
    this.crate = crate;
    this.options = {
      ...options,
      onWarning: options.onWarning ?? ((message: string) => console.warn(message)),
      generateIndex: options.generateIndex ?? true,
      filter: options.filter ?? defaultFilter,
      groupBy: options.groupBy ?? "module",
      useTabs: options.useTabs ?? true,
      useCards: options.useCards ?? true,
    };
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
      this.options.onWarning(sanitizeLogMessage(message));
    } else if (this.warningCount === MAX_WARNINGS + 1) {
      this.options.onWarning(
        `Warning limit (${MAX_WARNINGS}) reached. Further warnings suppressed.`
      );
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
    if (!this.membersIndexed) {
      this.buildMemberUrls(plan);
      this.membersIndexed = true;
    }
    const files: GeneratedFile[] = [];
    const previousParser = this.parseMarkdown;
    this.parseMarkdown = createMarkdownParser();
    try {
      this.renderNode(plan, files);
    } finally {
      this.parseMarkdown = previousParser;
    }
    if (this.missingRefCount > RustdocGenerator.MAX_VERBOSE_MISSING_REFS) {
      this.options.onWarning(
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
      if (this.options.generateIndex && modPath && node.item.crate_id === 0) {
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

  /** First emitted page to link from a workspace landing page. */
  landingUrl(): string | null {
    const root = this.buildPlan();
    if (this.options.generateIndex) return this.nodeUrl(root);
    return this.itemUrls.values().next().value ?? null;
  }

  /**
   * Provide the page index of sibling crates (see {@link pageIndex}). Call
   * before {@link generate}; workspace mode builds every member's index
   * first, then renders each member with the union.
   */
  setExternalPages(pages: Map<string, string>): void {
    this.options.externalPages = pages;
    // Docstrings processed so far resolved their links without these pages.
    this.docsCache.clear();
    this.resolvedDocs.clear();
    this.summaries.clear();
    this.calloutDocs.clear();
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

  private logicalPath(node: ModuleNode): string[] {
    const names: string[] = [];
    for (let n: ModuleNode | undefined = node; n; n = n.parent) names.push(n.name);
    return names.reverse();
  }

  private indexHtmlTarget(path: string[], kind: string, id: Id): void {
    const name = path.at(-1);
    if (!name) return;
    const file =
      kind === "module"
        ? [...path, "index.html"]
        : HTML_KIND_PREFIX[kind] && [
            ...path.slice(0, -1),
            HTML_KIND_PREFIX[kind] + "." + name + ".html",
          ];
    if (file) this.htmlTargets.set(file.join("/"), id);
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
    if (
      !/^\.{1,2}\/|\.(md|rs|toml|json|txt|ya?ml|html?|png|jpe?g|gif|svg|webp|avif|pdf)(?:[?#].*)?$|\/$/i.test(
        dest
      )
    )
      return undefined;
    const [rustdocFile, fragment] = dest.split("#", 2);
    if (
      /(?:^|\/)(?:index|(?:struct|union|enum|trait|type|fn|constant|static|macro|attr|derive|foreigntype)\.[^/]+)\.html$/.test(
        rustdocFile
      )
    ) {
      const owner = this.owners.get(String(item.id));
      const path = this.getPath(owner?.item.id ?? item.id);
      const dirs = [
        owner && this.logicalPath(owner.node),
        path && ("module" in item.inner ? path : path.slice(0, -1)),
      ];
      for (const dir of dirs) {
        if (!dir) continue;
        const target = this.htmlTargets.get(posix.join(...dir, rustdocFile));
        if (target == null) continue;
        const page = this.owners.get(String(target));
        const url = this.resolveIdUrl(target);
        return fragment && url
          ? page
            ? this.fragmentUrl(page, fragment)
            : url + "#" + fragment
          : url;
      }
      return null;
    }
    const span = item.span;
    if (!span || span.filename.startsWith("/")) return null;
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
    this.crate = ensureRustdocCrate(this.crate, (message) => this.warn(message));
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
      if (node.expandedUses.has(use.id)) continue;
      node.expandedUses.add(use.id);
      this.placeUse(node, use, pendingUses);
    }

    this.plan = root;
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
      taken: new Set([
        "index",
        "meta",
        ...(this.options.groupBy === "kind" ? KIND_ORDER.map(kindToFilename) : []),
      ]),
      anchors: new Map(),
      expandedUses: new Set(),
    };
  }

  /** Record the canonical URL of a module node's item, if it has none yet. */
  private registerModuleUrl(node: ModuleNode): void {
    const key = String(node.item.id);
    this.moduleIds.add(node.item.id);
    if (this.options.generateIndex && !this.itemUrls.has(key))
      this.itemUrls.set(key, this.nodeUrl(node));
  }

  /**
   * Phase A for one module subtree: place every directly reachable child and
   * queue its `pub use` items for phase B.
   */
  private placeDirectTree(start: ModuleNode, pending: { node: ModuleNode; use: Item }[]): void {
    const queue: ModuleNode[] = [start];
    for (const node of queue) {
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
    const dir = this.outputName(parent, name, "module");
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
    const file = this.outputName(node, name, kind);
    const group = kindToFilename(kind);
    let anchor: string | undefined;
    if (this.options.groupBy === "kind") {
      const slug = headingSlug(name) || "item";
      anchor = claimAnchor(node.anchors, group + "#" + slug, 2).slice(group.length + 1);
    }
    const url =
      joinUrl(
        this.options.baseUrl,
        [...this.outputDirectory(node), anchor ? group : file].map(encodeSegment)
      ) + (anchor ? "#" + anchor : "");
    const gates = [...node.gates];
    if (via) gates.push(...itemCfgs(via));
    gates.push(...itemCfgs(item));
    const entry: PageEntry = {
      item,
      name,
      file,
      kind,
      node,
      via,
      url,
      anchor,
      gates: dedupeCfgs(gates),
    };
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
  private outputName(node: ModuleNode, name: string, kind: ItemKind): string {
    const flat = this.options.groupBy === "flat";
    const prefix = flat && node.parent ? node.segments.at(-1) + "--" : "";
    const base = prefix + sanitizePath(name);
    const taken = flat ? this.flatNames : node.taken;
    const limit = MAX_FILENAME_LENGTH - (kind !== "module" || flat ? 4 : 0);
    let candidate = truncateUtf8(base, limit);
    if (taken.has(candidate.toLowerCase())) {
      let cursors = this.filenameSuffixes.get(taken);
      if (!cursors) {
        cursors = new Map<string, number>();
        this.filenameSuffixes.set(taken, cursors);
      }
      // ASCII case variants truncate at identical byte offsets. For Unicode only
      // share a cursor for the exact base, since folding can change byte length.
      const key = kind + "/" + (/^[\x20-\x7e]+$/.test(base) ? base.toLowerCase() : base);
      let n = cursors.get(key) ?? 1;
      do {
        const suffix = "-" + kindSuffix(kind) + (n > 1 ? "-" + n : "");
        candidate = truncateUtf8(base, limit - suffix.length) + suffix;
        n++;
      } while (taken.has(candidate.toLowerCase()));
      cursors.set(key, n);
    }
    taken.add(candidate.toLowerCase());
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
        via: use,
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
        via: use,
        name,
        source: u.source,
        isGlob: false,
        href: null,
        targetId: u.id ?? undefined,
      });
      return;
    }
    // Enum variants inherit visibility from their enum.
    if (!this.memberIncluded(target, "variant" in target.inner)) return;
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
    if (
      kind === "variant" ||
      ((existing !== undefined || this.moduleIds.has(target.id)) && (!inline || noInline))
    ) {
      node.reexports.push({
        via: use,
        name,
        source,
        isGlob: false,
        href: existing ?? null,
        targetId: target.id,
        target,
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

  /** Trait members and enum variants inherit their owner's public visibility. */
  private memberIncluded(item: Item, inherited = false): boolean {
    if (inherited && this.options.filter === defaultFilter) return true;
    return this.options.filter(item);
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

  /** rustdoc can resolve an external member without providing its summary.
   * Only qualify it when links prove its owner or its full defining path is explicit.
   */
  private unindexedMemberUrl(item: Item, key: string, id: Id): string | null {
    if (this.getItem(id) || this.crate.paths[String(id)]) return null;
    const match =
      /^(?:(fn|method|variant|associatedtype|associatedconstant)@)?([\w:]+)::(\w+)(\(\))?$/.exec(
        key.replace(/^`|`$/g, "")
      );
    if (!match) return null;
    const [, kind, owner, member, call] = match;
    const ownerId = item.links["`" + owner + "`"] ?? item.links[owner];
    let summary = ownerId == null ? undefined : this.crate.paths[String(ownerId)];
    if (!summary && owner.includes("::")) {
      // Prefer the full path over a suffix match: unrelated types in different
      // crates frequently share a name.
      this.externalTypePaths ??= new Map(
        Object.values(this.crate.paths)
          .filter((p) => p.crate_id !== 0 && ["enum", "struct", "union", "trait"].includes(p.kind))
          .map((p) => [p.path.join("::"), p])
      );
      summary = this.externalTypePaths.get(STD_OWNERS[owner] ?? owner);
    }
    if (!summary || summary.crate_id === 0) return null;
    const memberKind =
      kind === "fn" || kind === "method" || call
        ? "method"
        : (kind ?? STD_MEMBER_KINDS[summary.path.join("::") + "::" + member]);
    if (!memberKind) return null;
    const url = externalDocUrl(summary, this.crate.external_crates[String(summary.crate_id)]);
    return url && url + "#" + memberKind + "." + member;
  }

  /** Map rustdoc's HTML fragment names to the headings emitted on the target page. */
  private fragmentUrl(page: PageEntry, fragment: string): string {
    const prefix = page.anchor ? page.anchor + "." : "";
    const member = fragment.replace(/^tymethod\./, "method.");
    let anchor: string;
    if (member.startsWith("structfield.")) {
      const field = this.fieldsAnchor(page);
      const url = page.url.split("#")[0] + "#" + field;
      const ids = this.fieldIds(page.item);
      const name = member.slice("structfield.".length);
      if (
        !ids.some(
          (id) =>
            id != null && this.getItem(id)?.name === name && this.memberUrls.get(String(id)) === url
        )
      )
        return page.url;
      anchor = field;
    } else if (/^(method|associatedtype|associatedconstant|variant)\./.test(member)) {
      // A trait implementation can inherit a method without documenting a
      // heading; in that case the implementing type is the nearest destination.
      const desired = prefix + member.replace(/^(variant\.[^.]+)\.field\..+$/, "$1");
      page.memberHeadings ??= new Set(this.anchorsFor(page).values());
      if (!page.memberHeadings.has(desired)) return page.url;
      anchor = desired;
    } else {
      anchor = prefix + (page.anchor ? "section." : "") + fragment;
    }
    return page.url.split("#")[0] + "#" + anchor;
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
    let body = this.resolvedDocs.get(item.id);
    if (body === undefined) {
      const resolve = (key: string): string | null | undefined => {
        const owner = this.owners.get(String(item.id));
        if (key.startsWith("#") && owner) return this.fragmentUrl(owner, key.slice(1));
        const hash = key.indexOf("#", 1);
        const bare = hash >= 0 ? key.slice(0, hash) : key;
        const id = item.links[key] ?? item.links[bare] ?? item.links[bare + "`"];
        if (id === undefined) return this.resolveRelativeDocLink(item, key);
        const dest = this.resolveIdUrl(id) ?? this.unindexedMemberUrl(item, bare, id);
        if (!dest || hash < 0) return dest;
        const fragment = key.slice(hash + 1).replace(/`$/, "");
        const target = this.owners.get(String(id));
        return target ? this.fragmentUrl(target, fragment) : dest.split("#")[0] + "#" + fragment;
      };
      body = sanitizeDocstring(
        rewriteDocLinks(item.docs, resolve, false, this.parseMarkdown),
        resolve,
        this.parseMarkdown
      );
      this.resolvedDocs.set(item.id, body);
    }
    if (strip.length) body = this.calloutsFor(item).rest;
    const out = demoteHeadings(body, demote, this.parseMarkdown);
    this.docsCache.set(cacheKey, out);
    return out;
  }

  private summary(item: Item): string {
    let summary = this.summaries.get(item.id);
    if (summary === undefined) {
      summary = summaryMarkdown(this.docsFor(item, 0), this.parseMarkdown);
      this.summaries.set(item.id, summary);
    }
    return summary;
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

  /** Extract and remove each displayed section together, reusing both results. */
  private calloutsFor(item: Item): { rest: string; sections: Map<string, string> } {
    const cached = this.calloutDocs.get(item.id);
    if (cached) return cached;
    let rest = this.docsFor(item, 0);
    const sections = new Map<string, string>();
    for (const name of this.calloutSections(item)) {
      const extracted = takeSection(rest, name, this.parseMarkdown);
      if (extracted.section) sections.set(name, extracted.section);
      rest = extracted.rest;
    }
    const value = { rest, sections };
    this.calloutDocs.set(item.id, value);
    return value;
  }

  /** Append an item's docs (preceded by a blank line) when it has any. */
  private pushDocs(
    sections: string[],
    item: Item,
    demote: number,
    strip: readonly string[] = [],
    sectionScope?: string
  ): void {
    let docs = this.docsFor(item, demote, strip);
    if (docs && sectionScope) {
      const used = new Map<string, number>();
      docs = mapProse(
        docs,
        (chunk) =>
          chunk.replace(/^(#{1,6})[ \t]+([^\n]+)$/gm, (line, _level, text: string) => {
            const slug = headingSlug(text.replace(/`/g, "")) || "section";
            const id = claimAnchor(used, slug, 1);
            return line + " [#" + sectionScope + ".section." + id + "]";
          }),
        this.parseMarkdown
      );
    }
    if (docs) {
      sections.push("");
      sections.push(docs);
    }
  }

  /**
   * One member (method, associated type or constant) of a trait or impl:
   * anchored heading, deprecation, signature with its attributes, source
   * link and docs.
   */
  private pushMember(sections: string[], member: Item, anchor: string | undefined): void {
    sections.push(this.memberHeading(member.name ?? "", anchor));
    sections.push("");
    this.pushAvailability(sections, member);
    const deprecation = this.renderDeprecationOf(member);
    if (deprecation) {
      sections.push(deprecation);
      sections.push("");
    }
    sections.push("```rust");
    sections.push(...attrLines(member));
    sections.push(this.formatMemberSignature(member));
    sections.push("```");
    this.pushSource(sections, member);
    this.pushDocs(sections, member, 4);
    sections.push("");
  }

  private pushStability(sections: string[], item: Item): void {
    for (const [label, stability] of [
      ["Unstable", item.stability],
      ["Unstable in const contexts", item.const_stability],
    ] as const) {
      if (stability?.level !== "unstable") continue;
      sections.push(
        "**" +
          label +
          "**" +
          (stability.feature ? " (feature " + inlineCode(stability.feature) + ")" : ""),
        ""
      );
    }
  }

  private pushAvailability(sections: string[], item: Item): void {
    this.pushStability(sections, item);
    const gate = this.renderGate(itemCfgs(item));
    if (gate) sections.push("", gate, "");
  }

  /** A deprecation callout (escaped title, MDX-safe note), or "". */
  private renderDeprecationOf(item: Item): string {
    if (!item.deprecation) return "";
    const note = item.deprecation.note
      ? sanitizeDocstring(item.deprecation.note, undefined, this.parseMarkdown)
      : undefined;
    return renderDeprecation(item.deprecation.since ?? undefined, note);
  }

  /** `[Source](...)` after a signature, when a source URL base is set. */
  private pushSource(sections: string[], item: Item): void {
    const span = item.span;
    if (!span) return;
    const url = this.sourceUrl(span.filename, [span.begin[0], span.end[0]]);
    if (!url) return;
    sections.push("");
    sections.push(`[Source](${url})`);
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
  private anchorsFor(page: PageEntry): Map<string, string> {
    const item = page.item;
    const key = page.url;
    const cached = this.anchorCache.get(key);
    if (cached) return cached;
    const anchors = new Map<string, string>();
    const used = new Map<string, number>();
    const claim = (id: Id, base: string): void => {
      if (anchors.has(String(id))) return;
      base = page.anchor ? page.anchor + "." + base : base;
      anchors.set(String(id), claimAnchor(used, base, 2));
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
        if (v?.name && this.memberIncluded(v, true)) claim(vid, `variant.${v.name}`);
      }
    }
    if ("trait" in item.inner) {
      for (const id of item.inner.trait.items) {
        const child = this.getItem(id);
        if (child && this.memberIncluded(child, true)) member(child);
      }
    }
    for (const impl of this.getImplementations(item)) {
      if (!("impl" in impl.inner)) continue;
      const isTrait = Boolean(impl.inner.impl.trait);
      for (const id of impl.inner.impl.items) {
        const child = this.getItem(id);
        if (!child || !this.memberIncluded(child, isTrait)) continue;
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

  private fieldsAnchor(page: PageEntry): string {
    return page.anchor ? page.anchor + ".fields" : "fields";
  }

  /**
   * URLs of members (methods, variants, fields, associated items) of every
   * item that has a canonical page, so intra-doc links like
   * `` [`Foo::bar`] `` or `` [`Self::Variant`] `` land on the right heading.
   */
  private buildMemberUrls(node: ModuleNode): void {
    for (const page of node.pages) {
      if (page.via && !this.owners.has(String(page.via.id)))
        this.owners.set(String(page.via.id), page);
      if (this.itemUrls.get(String(page.item.id)) !== page.url) continue; // not canonical
      this.owners.set(String(page.item.id), page);
      const pagePath = page.url.split("#")[0];
      for (const [id, anchor] of this.anchorsFor(page)) {
        if (!this.memberUrls.has(id)) {
          this.memberUrls.set(id, pagePath + "#" + anchor);
          this.owners.set(id, page);
        }
      }
      const inner = page.item.inner;
      for (const id of this.fieldIds(page.item)) {
        const field = id != null ? this.getItem(id) : undefined;
        if (field && this.memberIncluded(field) && !this.memberUrls.has(String(id))) {
          this.memberUrls.set(String(id), pagePath + "#" + this.fieldsAnchor(page));
          this.owners.set(String(id), page);
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
            const field = this.getItem(fid);
            if (field && this.memberIncluded(field, true) && !this.memberUrls.has(String(fid))) {
              this.memberUrls.set(String(fid), variantUrl);
              this.owners.set(String(fid), page);
            }
          }
        }
      }
    }
    const modulePath = this.logicalPath(node);
    this.indexHtmlTarget(modulePath, "module", node.item.id);
    for (const page of node.pages) {
      this.indexHtmlTarget([...modulePath, page.name], page.kind, page.item.id);
      const original = this.getPath(page.item.id);
      if (original) this.indexHtmlTarget(original, page.kind, page.item.id);
    }
    for (const alias of node.reexports) {
      if (alias.kind && alias.target)
        this.indexHtmlTarget([...modulePath, alias.name], alias.kind, alias.target.id);
    }
    node.submodules.forEach((sub) => this.buildMemberUrls(sub));
  }

  /** Absolute URL of a module node's index page. */
  private outputDirectory(node: ModuleNode): string[] {
    return this.options.groupBy === "flat" ? node.segments.slice(0, 1) : node.segments;
  }

  private moduleIndexFile(node: ModuleNode): string {
    return this.options.groupBy === "flat" && node.parent ? node.segments.at(-1)! : "index";
  }

  private nodeUrl(node: ModuleNode): string {
    const segments = this.outputDirectory(node);
    const file = this.moduleIndexFile(node);
    return joinUrl(
      this.options.baseUrl,
      (file === "index" ? segments : [...segments, file]).map(encodeSegment)
    );
  }

  /** Render one module node (index, meta.json, pages) and its submodules. */
  private renderNode(node: ModuleNode, files: GeneratedFile[]): void {
    const dirPath = this.outputDirectory(node).join("/");

    if (this.options.generateIndex) {
      files.push({
        path: `${dirPath}/${this.moduleIndexFile(node)}.mdx`,
        content: this.generateModuleIndex(node),
      });
    }
    if (!node.parent || this.options.groupBy !== "flat") {
      files.push({ path: `${dirPath}/meta.json`, content: this.generateMeta(node) });
    }

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
    const frontmatter = this.frontmatter(node.item, this.logicalPath(node), node.via);
    const sections: string[] = [];

    sections.push(this.formatFrontmatter(frontmatter));
    sections.push("");

    this.pushStability(sections, node.item);
    const gate = this.renderGate(node.gates);
    if (gate) {
      sections.push(gate);
      sections.push("");
    }

    if (node.via) {
      const note = this.renderDeprecationOf(node.via);
      if (note) sections.push(note, "");
      this.pushDocs(sections, node.via, 1);
    }
    const docs = this.docsFor(node.item, 1);
    if (docs) {
      sections.push(docs);
      sections.push("");
    }

    const source: string[] = [];
    this.pushSource(source, node.item);
    if (source.length > 0) {
      sections.push(...source.slice(1));
      sections.push("");
    }

    if (node.submodules.length > 0) {
      sections.push("## Modules");
      sections.push("");
      for (const sub of [...node.submodules].sort((a, b) => a.name.localeCompare(b.name))) {
        sections.push(
          this.indexLine(sub.name, this.nodeUrl(sub), sub.via?.docs ? sub.via : sub.item)
        );
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
        sections.push(
          this.indexLine(
            displayName(page.name, kind),
            page.url,
            page.via?.docs ? page.via : page.item
          )
        );
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
        const summary = re.via.docs
          ? this.summary(re.via)
          : re.target
            ? this.summary(re.target)
            : "";
        const aliasNotice = this.renderDeprecationOf(re.via);
        const gate = this.renderGate(itemCfgs(re.via));
        const desc = summary ? ` - ${summary}` : "";
        sections.push(`- ${link}${glob}${desc}`);
        if (aliasNotice) sections.push("", aliasNotice, "");
        if (gate) sections.push("", gate, "");
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  /** One `- [`name`](url) - first doc line` bullet for an index page. */
  private indexLine(name: string, url: string, item: Item): string {
    const desc = this.summary(item);
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
      const append = (sub: ModuleNode): void => {
        if (this.options.groupBy !== "flat" || this.options.generateIndex)
          pages.push(sub.segments[sub.segments.length - 1]);
        if (this.options.groupBy === "flat") {
          pages.push(...sub.pages.map((p) => p.file).sort());
          [...sub.submodules].sort((a, b) => a.name.localeCompare(b.name)).forEach(append);
        }
      };
      [...node.submodules].sort((a, b) => a.name.localeCompare(b.name)).forEach(append);
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
        description: `${kindToTitle(kind)} in ${this.logicalPath(node).join("::")}`,
      })
    );
    sections.push("");

    for (const page of [...pages].sort((a, b) => a.name.localeCompare(b.name))) {
      sections.push(this.renderItemBody(page));
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
    const frontmatter = this.frontmatter(
      page.item,
      [...this.logicalPath(page.node), page.name],
      page.via
    );
    const sections: string[] = [];

    sections.push(this.formatFrontmatter(frontmatter));
    sections.push("");
    sections.push(this.renderItemBody(page));
    return sections.join("\n");
  }

  private renderItemBody(page: PageEntry): string {
    const sections = [this.renderItem(page)];
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
      list.map((impl) => this.renderImpl(impl, page)).join("\n\n");
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
      names.push(
        inlineCode(
          `${impl.inner.impl.is_negative ? "!" : ""}${name}${formatWhereClause(impl.inner.impl.generics)}`
        )
      );
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
          if (isPlainStruct(struct.kind) || isTupleStruct(struct.kind)) {
            for (const fieldId of isPlainStruct(struct.kind)
              ? struct.kind.plain.fields
              : struct.kind.tuple) {
              const field = fieldId != null ? this.getItem(fieldId) : undefined;
              if (field && this.memberIncluded(field) && "struct_field" in field.inner) {
                this.collectTypeReferences(field.inner.struct_field, refs);
              }
            }
          }
        }
        break;
      case "union":
        if ("union" in item.inner) {
          for (const id of item.inner.union.fields) {
            const field = this.getItem(id);
            if (field && this.memberIncluded(field) && "struct_field" in field.inner)
              this.collectTypeReferences(field.inner.struct_field, refs);
          }
        }
        break;
      case "enum":
        if ("enum" in item.inner) {
          const enumDef = item.inner.enum;
          // Scan variant field types
          for (const variantId of enumDef.variants) {
            const variant = this.getItem(variantId);
            if (variant && this.memberIncluded(variant, true) && "variant" in variant.inner) {
              const variantKind = variant.inner.variant.kind;
              if (isTupleVariant(variantKind)) {
                for (const fieldId of variantKind.tuple) {
                  if (fieldId != null) {
                    const field = this.getItem(fieldId);
                    if (
                      field &&
                      this.memberIncluded(field, true) &&
                      "struct_field" in field.inner
                    ) {
                      this.collectTypeReferences(field.inner.struct_field, refs);
                    }
                  }
                }
              } else if (isStructVariant(variantKind)) {
                for (const fieldId of variantKind.struct.fields) {
                  const field = this.getItem(fieldId);
                  if (field && this.memberIncluded(field, true) && "struct_field" in field.inner) {
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
              if (traitPath.id != null) {
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
    const targets: { item: Item; title: string; href: string; kind: ItemKind }[] = [];
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

      targets.push({ item: refItem, title: refItem.name, href, kind: refKind });
    }

    // Sort by title and limit to 6 cards
    return targets
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, 6)
      .map(({ item, title, href, kind }) => ({
        title,
        href,
        description: this.plainSummary(item) || `A ${kind}`,
      }));
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
    if (!type || typeof type !== "object" || depth > MAX_TYPE_DEPTH) {
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
    args: GenericArgs | null | undefined,
    refs: Set<Id>,
    depth: number
  ): void {
    if (!args || typeof args !== "object") return;
    if ("angle_bracketed" in args) {
      for (const arg of args.angle_bracketed.args) {
        if (typeof arg === "object" && "type" in arg) {
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

    // Deprecation warning: the title goes through JSON escaping and the note
    // through docstring sanitization, so quotes or `<T>` cannot break MDX.
    if (page.via) {
      const aliasNote = this.renderDeprecationOf(page.via);
      if (aliasNote) sections.push(aliasNote, "");
      this.pushDocs(sections, page.via, 2);
    }
    const deprecation = this.renderDeprecationOf(item);
    if (deprecation) {
      sections.push(deprecation);
      sections.push("");
    }

    this.pushStability(sections, item);

    // Feature gate callout: #[doc(cfg)] / #[cfg], module gates inherited.
    const gate = this.renderGate(page.gates);
    if (gate) {
      sections.push(gate);
      sections.push("");
    }

    // Safety callout for unsafe items
    const isUnsafe = this.isUnsafeItem(item);
    if (isUnsafe) {
      const safety = this.calloutsFor(item).sections.get("Safety");
      sections.push(safety ? renderCallout("error", "Safety", safety) : renderSafetyCallout());
      sections.push("");
    }

    // Render based on item kind
    const declaration = sections.length;
    switch (kind) {
      case "function":
        sections.push(this.renderFunction(page));
        break;
      case "struct":
        sections.push(this.renderStruct(page));
        break;
      case "union":
        sections.push(this.renderUnion(page));
        break;
      case "enum":
        sections.push(this.renderEnum(page));
        break;
      case "trait":
        sections.push(this.renderTrait(page));
        break;
      case "type_alias":
        sections.push(this.renderTypeAlias(page));
        break;
      case "constant":
      case "static":
        sections.push(this.renderConstant(page));
        break;
      case "macro":
      case "proc_derive":
      case "proc_attribute":
        sections.push(this.renderMacro(page));
        break;
      case "trait_alias":
        if ("trait_alias" in item.inner) {
          const alias = item.inner.trait_alias;
          const bounds = alias.params.map(formatGenericBound).join(" + ");
          const signature = `trait ${name}${formatGenerics(alias.generics)} = ${bounds}${formatWhereClause(alias.generics)};`;
          sections.push(`## ${inlineCode(name)}\n\n\`\`\`rust\n${signature}\n\`\`\``);
          this.pushSource(sections, item);
          this.pushDocs(sections, item, 2, [], page.anchor);
        }
        break;
      case "foreign_type":
        sections.push(`## ${inlineCode(name)}\n\n\`\`\`rust\nextern { type ${name}; }\n\`\`\``);
        this.pushDocs(sections, item, 2);
        break;
      default:
        sections.push(`## ${name}`);
        this.pushDocs(sections, item, 2);
    }

    if (page.anchor) {
      const [heading, ...body] = sections[declaration].split("\n");
      sections[declaration] = body.join("\n");
      sections.unshift(heading + " [#" + page.anchor + "]", "");
    }

    if (kind === "function") {
      const callouts = this.calloutsFor(item).sections;
      for (const title of ["Panics", "Errors"]) {
        const content = callouts.get(title);
        if (content)
          sections.push("", renderCallout(title === "Panics" ? "error" : "warn", title, content));
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
  private renderFunction(page: PageEntry): string {
    const { item, name } = page;
    if (!("function" in item.inner)) return "";
    const fn = item.inner.function;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(...attrLines(item));
    sections.push(formatFunctionSignature(name, fn));
    sections.push("```");
    this.pushSource(sections, item);

    this.pushDocs(sections, item, 2, this.calloutSections(item), page.anchor);

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
  private renderStruct(page: PageEntry): string {
    const { item, name } = page;
    if (!("struct" in item.inner)) return "";
    const struct = item.inner.struct;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(...attrLines(item));
    const tupleFields = isTupleStruct(struct.kind)
      ? struct.kind.tuple.map((id) => {
          const field = id != null ? this.getItem(id) : undefined;
          return field && this.memberIncluded(field)
            ? fieldVisibility(field.visibility) + this.formatFieldType(field)
            : "_";
        })
      : undefined;
    sections.push(formatStructSignature(name, struct, tupleFields));
    sections.push("```");
    this.pushSource(sections, item);

    this.pushDocs(sections, item, 2, this.calloutSections(item), page.anchor);

    this.pushFields(sections, page);
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
  private renderUnion(page: PageEntry): string {
    const { item, name } = page;
    if (!("union" in item.inner)) return "";
    const union = item.inner.union;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(...attrLines(item));
    sections.push(formatUnionSignature(name, union));
    sections.push("```");
    this.pushSource(sections, item);

    this.pushDocs(sections, item, 2, this.calloutSections(item), page.anchor);

    this.pushFields(sections, page);

    return sections.join("\n");
  }

  private fieldIds(item: Item): (Id | null)[] {
    if ("union" in item.inner) return item.inner.union.fields;
    if ("struct" in item.inner) {
      const kind = item.inner.struct.kind;
      if (isPlainStruct(kind)) return kind.plain.fields;
      if (isTupleStruct(kind)) return kind.tuple;
    }
    return [];
  }

  private pushFields(sections: string[], page: PageEntry): void {
    const lines = this.fieldIds(page.item).flatMap((id, i) => {
      const field = id != null ? this.getItem(id) : undefined;
      return field && this.memberIncluded(field)
        ? [this.fieldLine(field.name ?? String(i), field)]
        : [];
    });
    if (lines.length)
      sections.push(
        "",
        "### Fields" + (page.anchor ? " [#" + this.fieldsAnchor(page) + "]" : ""),
        "",
        ...lines
      );
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
  private renderEnum(page: PageEntry): string {
    const { item, name } = page;
    if (!("enum" in item.inner)) return "";
    const enumDef = item.inner.enum;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(...attrLines(item));
    sections.push(formatEnumSignature(name, enumDef));
    sections.push("```");
    this.pushSource(sections, item);

    this.pushDocs(sections, item, 2, this.calloutSections(item), page.anchor);

    // Render variants
    if (enumDef.variants.length > 0) {
      sections.push("");
      sections.push("### Variants");
      sections.push("");
      for (const variantId of enumDef.variants) {
        const variantItem = this.getItem(variantId);
        if (
          !variantItem ||
          !("variant" in variantItem.inner) ||
          !this.memberIncluded(variantItem, true)
        )
          continue;

        const variant = variantItem.inner.variant;
        const variantName = variantItem.name ?? "Unknown";

        // Render variant with its fields
        const variantSig = this.formatVariantSignature(variantName, variant);
        sections.push(
          this.memberHeading(variantSig, this.anchorsFor(page).get(String(variantItem.id)))
        );

        this.pushAvailability(sections, variantItem);
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
              if (!field || !this.memberIncluded(field, true)) continue;
              sections.push(this.fieldLine(field.name ?? "_", field));
            }
          }
        }

        // Render tuple-style variant fields
        if (isTupleVariant(variant.kind)) {
          const tupleFields = variant.kind.tuple;
          if (tupleFields.length > 0) {
            sections.push("");
            sections.push("**Fields:**");
            sections.push("");
            for (let i = 0; i < tupleFields.length; i++) {
              const id = tupleFields[i];
              const field = id != null ? this.getItem(id) : undefined;
              if (!field || !this.memberIncluded(field, true)) continue;
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
  private formatVariantSignature(name: string, variant: Variant): string {
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
          if (!this.memberIncluded(field, true)) return "_";
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
  private renderTrait(page: PageEntry): string {
    const { item, name } = page;
    if (!("trait" in item.inner)) return "";
    const trait = item.inner.trait;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(...attrLines(item));
    sections.push(formatTraitSignature(name, trait));
    sections.push("```");
    this.pushSource(sections, item);

    this.pushDocs(sections, item, 2, this.calloutSections(item), page.anchor);

    const members = trait.items
      .map((id) => this.getItem(id))
      .filter((i): i is Item => i !== undefined && this.memberIncluded(i, true));
    const anchors = this.anchorsFor(page);
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
        this.pushMember(sections, member, anchors.get(String(member.id)));
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
      const where = formatWhereClause(at.generics);
      return (
        `type ${name}${formatGenerics(at.generics)}` +
        (bounds.length > 0 ? `: ${bounds.join(" + ")}` : "") +
        (at.type ? ` = ${formatType(at.type)}` : "") +
        `${where};`
      );
    }
    if ("assoc_const" in member.inner) {
      const ac = member.inner.assoc_const;
      return `const ${name}: ${formatType(ac.type)}${ac.value != null ? ` = ${ac.value}` : ""};`;
    }
    return name;
  }

  /**
   * Bullet list of the types implementing a trait, linked to their pages
   * when they have one.
   */
  private renderImplementors(implIds: Id[]): string {
    const entries: { label: string; qualified: string; href: string | null; blanket: boolean }[] =
      [];
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const implId of implIds) {
      const item = this.getItem(implId);
      if (!item || !("impl" in item.inner)) continue;
      const impl = item.inner.impl;
      if (impl.is_synthetic) continue;
      const path =
        typeof impl.for === "object" && "resolved_path" in impl.for
          ? impl.for.resolved_path
          : undefined;
      if (path && this.getItem(path.id)?.crate_id === 0 && !this.itemUrls.has(String(path.id)))
        continue;
      const prefix = impl.is_negative ? "!" : "";
      const name = path ? getPathName(path) : formatType(impl.for);
      const args = path ? formatGenericArgs(path.args) : "";
      const label = prefix + (path ? name.split("::").at(-1)! : name) + args;
      const qualified =
        prefix + (path ? (this.getPath(path.id)?.slice(1).join("::") ?? name) : name) + args;
      const identity = String(implId);
      if (seen.has(identity)) continue;
      seen.add(identity);
      counts.set(label, (counts.get(label) ?? 0) + 1);
      entries.push({
        label,
        qualified,
        href: path ? this.resolveIdUrl(path.id) : null,
        blanket: Boolean(impl.blanket_impl),
      });
    }
    return entries
      .map(({ label, qualified, href, blanket }) => {
        const text = inlineCode(counts.get(label)! > 1 ? qualified : label);
        return "- " + (href ? `[${text}](${href})` : text) + (blanket ? " (blanket)" : "");
      })
      .sort((a, b) => a.localeCompare(b))
      .join("\n");
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
  private renderTypeAlias(page: PageEntry): string {
    const { item, name } = page;
    if (!("type_alias" in item.inner)) return "";
    const alias = item.inner.type_alias;
    const sections: string[] = [];

    sections.push(`## \`${name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(`type ${name}${formatGenerics(alias.generics)} = ${formatType(alias.type)};`);
    sections.push("```");
    this.pushSource(sections, item);

    this.pushDocs(sections, item, 2, this.calloutSections(item), page.anchor);

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
  private renderConstant(page: PageEntry): string {
    const { item, name } = page;
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
      this.pushSource(sections, item);
    } else if ("static" in item.inner) {
      const staticDef = item.inner.static;
      const typeName = formatType(staticDef.type);
      sections.push("");
      sections.push("```rust");
      const declaration = `static ${staticDef.is_mutable ? "mut " : ""}${name}: ${typeName}`;
      if (staticDef.expr) sections.push(`${declaration} = ${staticDef.expr};`);
      else {
        const qualifier =
          staticDef.is_unsafe === undefined ? "" : staticDef.is_unsafe ? "unsafe " : "safe ";
        sections.push(
          `${staticDef.is_unsafe === undefined ? "" : "unsafe "}extern { ${qualifier}${declaration}; }`
        );
      }
      sections.push("```");
      this.pushSource(sections, item);
    }

    this.pushDocs(sections, item, 2, this.calloutSections(item), page.anchor);

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
  private renderMacro(page: PageEntry): string {
    const { item, name } = page;
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

    this.pushDocs(sections, item, 2, this.calloutSections(item), page.anchor);

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
  private renderImpl(impl: Item, page: PageEntry): string {
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
    header += ` ${formatType(implDef.for)}${formatWhereClause(implDef.generics)}`;

    sections.push(`### ${inlineCode(header)}`);
    sections.push("");

    // An impl gated on more than the type itself (e.g. a feature-only
    // inherent impl) says so under its header.
    const ownerKeys = new Set(page.gates.map((g) => JSON.stringify(g)));
    const extra = dedupeCfgs(itemCfgs(impl)).filter((g) => !ownerKeys.has(JSON.stringify(g)));
    if (extra.length > 0) {
      sections.push(`*${describeCfgs(extra)}*`);
      sections.push("");
    }

    const children = implDef.items
      .map((id) => this.getItem(id))
      .filter((i): i is Item => i !== undefined && this.memberIncluded(i, Boolean(implDef.trait)));

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
    const anchors = this.anchorsFor(page);
    for (const member of children) {
      const anchor = anchors.get(String(member.id));
      if (implDef.trait && anchor === undefined) continue;
      if (!implDef.trait && !("function" in member.inner) && !("assoc_const" in member.inner)) {
        continue;
      }
      if (implDef.trait && !("function" in member.inner)) continue;

      this.pushMember(sections, member, anchor);
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
      const trait = impl.inner.impl.trait;
      if (trait && this.getItem(trait.id)?.crate_id === 0 && !this.itemUrls.has(String(trait.id)))
        continue;
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
    const doc = this.summary(field);
    const gate = describeCfgs(itemCfgs(field));
    return `- ${inlineCode(name)}: ${inlineCode(this.formatFieldType(field))}${doc ? ` - ${doc}` : ""}${gate ? ` *${gate}*` : ""}`;
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
  private plainSummary(item: Item): string {
    if (!item.docs) return "";
    const cached = this.plainSummaries.get(item);
    if (cached?.source === item.docs) return cached.value;
    const value = summaryLine(item.docs, this.parseMarkdown);
    this.plainSummaries.set(item, { source: item.docs, value });
    return value;
  }

  private frontmatter(item: Item, path: string[], via?: Item): Record<string, unknown> {
    if (this.options.frontmatter) return this.options.frontmatter(item, path);
    const kind = getItemKind(item.inner);
    const name = path.at(-1) ?? item.name;
    return {
      title: name ?? "API",
      description: via?.docs
        ? this.plainSummary(via)
        : this.plainSummary(item) || `Documentation for ${name}`,
      icon: kind === "unknown" ? "FileText" : kindToIcon(kind),
    };
  }
}

/** Map every occupied anchor to the next numeric suffix to try for that base. */
function claimAnchor(used: Map<string, number>, base: string, firstSuffix: number): string {
  let candidate = base;
  let n = used.get(base);
  if (n !== undefined) {
    do {
      candidate = base + "-" + n++;
    } while (used.has(candidate));
    used.set(base, n);
  }
  used.set(candidate, firstSuffix);
  return candidate;
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
    trait_alias: "trait-aliases",
    function: "functions",
    type_alias: "types",
    constant: "constants",
    static: "statics",
    macro: "macros",
    proc_derive: "derives",
    proc_attribute: "attributes",
    foreign_type: "extern-types",
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
    trait_alias: "Trait Aliases",
    function: "Functions",
    type_alias: "Type Aliases",
    constant: "Constants",
    static: "Statics",
    macro: "Macros",
    proc_derive: "Derive Macros",
    proc_attribute: "Attribute Macros",
    foreign_type: "Extern Types",
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
    trait_alias: "Puzzle",
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
