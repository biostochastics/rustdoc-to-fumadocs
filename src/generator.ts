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
  Attribute,
  GenericArgs,
} from "./types.js";
import { getItemKind, isPlainStruct, getPathName } from "./types.js";
import { RustdocError, ErrorCode } from "./errors.js";

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
}

/** A `pub use` that points at an item documented elsewhere. */
interface ReexportEntry {
  name: string;
  source: string;
  isGlob: boolean;
  href: string | null;
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
  /** Lower-cased names claimed in this directory. */
  taken: Set<string>;
}

/** First line of a docstring, or "" when there is none. */
function firstLine(docs: string | null | undefined): string {
  return docs?.split("\n")[0]?.trim() ?? "";
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
  renderTabs,
  renderCards,
  renderSafetyCallout,
  renderFeatureGateCallout,
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
 * Code-fence langs emitted by rustdoc that Shiki cannot resolve. These are
 * all Rust — the `compile_fail` / `ignore` / `no_run` / `should_panic` /
 * `edition20XX` tokens are doctest directives, not languages. Rewrite them
 * to `rust` and preserve the directive as the block title so it stays
 * visible to the reader.
 */
const RUSTDOC_DOCTEST_DIRECTIVES = new Set([
  "compile_fail",
  "ignore",
  "no_run",
  "should_panic",
  "edition2015",
  "edition2018",
  "edition2021",
  "edition2024",
]);

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
 *   2. Code-fence language normalization: rewrite rustdoc's doctest
 *      directives (`compile_fail`, `ignore`, `no_run`, `should_panic`,
 *      `editionYYYY`) to `rust` with a `title="directive"` preserved so
 *      the doctest intent stays legible.
 *
 * This was ported from a downstream fluxid-docs sync pipeline to the tool
 * itself — every consumer benefits without re-implementing the filters.
 */
export function sanitizeDocstring(raw: string): string {
  if (!raw) return raw;
  const out: string[] = [];
  let inFence = false;
  for (const rawLine of raw.split("\n")) {
    const fenceMatch = /^(\s*```)(\S+)?(.*)$/.exec(rawLine);
    if (fenceMatch) {
      // Entering or leaving a fence. Normalize langs on the opening fence.
      if (!inFence && fenceMatch[2] && RUSTDOC_DOCTEST_DIRECTIVES.has(fenceMatch[2])) {
        // Rewrite doctest directive → rust lang + title.
        // Strip any `,ignore`/`,compile_fail`/etc. secondary tokens that
        // rustdoc sometimes appends in the `rest` segment.
        let rest = fenceMatch[3] ?? "";
        rest = rest
          .replace(/^[\s,]+/, "")
          .replace(
            /(^|[,\s])(compile_fail|ignore|no_run|should_panic|edition20(15|18|21|24))(\b)/g,
            "$1"
          );
        out.push(`${fenceMatch[1]}rust title="${fenceMatch[2]}"${rest ? ` ${rest}` : ""}`);
      } else {
        out.push(rawLine);
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
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
}

/** Options after defaults have been applied. */
type ResolvedOptions = Required<Omit<GeneratorOptions, "externalPages">> &
  Pick<GeneratorOptions, "externalPages">;

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
    const entry: PageEntry = { item, name, file, kind, node, via, url };
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
        href: u.id !== undefined && u.id !== null ? this.resolveIdUrl(u.id) : null,
      });
      return;
    }

    if (target?.crate_id !== 0) {
      node.reexports.push({
        name,
        source: u.source,
        isGlob: false,
        href: u.id !== undefined && u.id !== null ? this.resolveIdUrl(u.id) : null,
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
        docs: firstLine(target.docs),
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
    const local = this.itemUrls.get(key);
    if (local) return local;
    const summary = this.crate.paths[key] as ItemSummary | undefined;
    if (!summary || summary.crate_id === 0) return null;
    const sibling = this.options.externalPages?.get(summary.path.join("::"));
    if (sibling) return sibling;
    return externalDocUrl(summary, this.crate.external_crates[String(summary.crate_id)]);
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

    if (node.item.docs) {
      sections.push(node.item.docs);
      sections.push("");
    }

    if (node.submodules.length > 0) {
      sections.push("## Modules");
      sections.push("");
      for (const sub of [...node.submodules].sort((a, b) => a.name.localeCompare(b.name))) {
        sections.push(this.indexLine(sub.name, this.nodeUrl(sub), sub.item.docs));
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
        sections.push(this.indexLine(displayName(page.name, kind), page.url, page.item.docs));
      }
      sections.push("");
    }

    if (node.reexports.length > 0) {
      sections.push("## Re-exports");
      sections.push("");
      for (const re of [...node.reexports].sort((a, b) => a.name.localeCompare(b.name))) {
        const label = `\`${re.name}\``;
        const link = re.href ? `[${label}](${re.href})` : label;
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
  private indexLine(name: string, url: string, docs: string | undefined): string {
    const desc = firstLine(docs);
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
   * inherent methods and trait implementations, in Tabs when both exist.
   */
  private renderImplementations(page: PageEntry): string {
    const impls = this.getImplementations(page.item);
    if (impls.length === 0) return "";
    const sections: string[] = ["## Implementations", ""];

    const inherentImpls = impls.filter((impl) => "impl" in impl.inner && !impl.inner.impl.trait);
    const traitImpls = impls.filter((impl) => "impl" in impl.inner && impl.inner.impl.trait);

    if (this.options.useTabs && inherentImpls.length > 0 && traitImpls.length > 0) {
      const tabContents = new Map<string, string>();
      tabContents.set("Methods", inherentImpls.map((impl) => this.renderImpl(impl)).join("\n\n"));
      tabContents.set(
        "Trait Implementations",
        traitImpls.map((impl) => this.renderImpl(impl)).join("\n\n")
      );
      sections.push(renderTabs(["Methods", "Trait Implementations"], tabContents));
    } else {
      for (const impl of impls) {
        sections.push(this.renderImpl(impl));
        sections.push("");
      }
    }
    return sections.join("\n");
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

      // Build path to referenced item
      const path = this.getPath(refId);
      const href = path ? `./${path.slice(1).join("/")}` : `./${refItem.name}`;

      cards.push({
        title: refItem.name,
        href,
        description: refItem.docs?.split("\n")[0] ?? `A ${refKind}`,
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

    // Feature gate callout (check attrs for cfg(feature = "..."))
    const featureGate = this.extractFeatureGate(item.attrs);
    if (featureGate) {
      sections.push(renderFeatureGateCallout(featureGate));
      sections.push("");
    }

    // Safety callout for unsafe items
    const isUnsafe = this.isUnsafeItem(item);
    if (isUnsafe) {
      sections.push(renderSafetyCallout(item.docs));
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
        sections.push(this.renderMacro(item, name));
        break;
      default:
        sections.push(`## ${name}`);
        if (item.docs) {
          sections.push("");
          sections.push(item.docs);
        }
    }

    // Add panics callout if docs contain # Panics section (for functions)
    if (kind === "function") {
      const panicsCallout = renderPanicsCallout(item.docs);
      if (panicsCallout) {
        sections.push("");
        sections.push(panicsCallout);
      }

      const errorsCallout = renderErrorsCallout(item.docs);
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
   * Extract feature gate from item attributes.
   * Looks for patterns like `#[cfg(feature = "feature_name")]`
   * Supports both old string format and new object format (format 56+).
   */
  private extractFeatureGate(attrs: Attribute[]): string | null {
    for (const attr of attrs) {
      // Normalize attribute to string
      let attrStr: string;
      if (typeof attr === "string") {
        attrStr = attr;
      } else if (typeof attr === "object" && attr !== null && "other" in attr) {
        attrStr = (attr as { other: string }).other;
      } else {
        continue;
      }

      // Match cfg(feature = "...") and cfg_attr(feature = "...", ...)
      // Also handles cfg_attr(not(feature = "..."), ...) and similar patterns
      // Support both double and single quotes for compatibility with different rustdoc versions
      const doubleQuoteMatch =
        /(?:cfg|cfg_attr)\s*\(\s*(?:not\s*\(\s*)?feature\s*=\s*"([^"]+)"/.exec(attrStr);
      if (doubleQuoteMatch) {
        return doubleQuoteMatch[1];
      }
      const singleQuoteMatch =
        /(?:cfg|cfg_attr)\s*\(\s*(?:not\s*\(\s*)?feature\s*=\s*'([^']+)'/.exec(attrStr);
      if (singleQuoteMatch) {
        return singleQuoteMatch[1];
      }
    }
    return null;
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

    if (item.docs) {
      sections.push("");
      sections.push(item.docs);
    }

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

    if (item.docs) {
      sections.push("");
      sections.push(item.docs);
    }

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
          sections.push(
            `- \`${field.name}\`: ${this.formatFieldType(field)}${field.docs ? ` - ${field.docs.split("\n")[0]}` : ""}`
          );
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

    if (item.docs) {
      sections.push("");
      sections.push(item.docs);
    }

    // Render fields
    if (union.fields.length > 0) {
      sections.push("");
      sections.push("### Fields");
      sections.push("");
      for (const fieldId of union.fields) {
        const field = this.getItem(fieldId);
        if (!field) continue;
        sections.push(
          `- \`${field.name}\`: ${this.formatFieldType(field)}${field.docs ? ` - ${field.docs.split("\n")[0]}` : ""}`
        );
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

    if (item.docs) {
      sections.push("");
      sections.push(item.docs);
    }

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
        sections.push(`#### \`${variantSig}\``);

        if (variantItem.docs) {
          sections.push("");
          sections.push(variantItem.docs);
        }

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
              const fieldType = this.formatFieldType(field);
              const fieldDoc = field.docs ? ` - ${field.docs.split("\n")[0]}` : "";
              sections.push(`- \`${field.name}\`: \`${fieldType}\`${fieldDoc}`);
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
              const fieldType = this.formatFieldType(field);
              const fieldDoc = field.docs ? ` - ${field.docs.split("\n")[0]}` : "";
              sections.push(`- \`${i}\`: \`${fieldType}\`${fieldDoc}`);
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

    if (item.docs) {
      sections.push("");
      sections.push(item.docs);
    }

    // Render required methods
    const methods = trait.items
      .map((id) => this.getItem(id))
      .filter((i): i is Item => i !== undefined && "function" in i.inner);

    if (methods.length > 0) {
      sections.push("");
      sections.push("### Required Methods");
      sections.push("");
      for (const method of methods) {
        if (!("function" in method.inner)) continue;
        sections.push("```rust");
        sections.push(formatFunctionSignature(method.name ?? "", method.inner.function));
        sections.push("```");
        if (method.docs) {
          sections.push("");
          sections.push(method.docs);
        }
        sections.push("");
      }
    }

    return sections.join("\n");
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

    if (item.docs) {
      sections.push("");
      sections.push(item.docs);
    }

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

    if (item.docs) {
      sections.push("");
      sections.push(item.docs);
    }

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
    sections.push(`## \`${name}!\``);
    sections.push("");

    if ("macro" in item.inner) {
      sections.push("```rust");
      sections.push(item.inner.macro);
      sections.push("```");
    }

    if (item.docs) {
      sections.push("");
      sections.push(item.docs);
    }

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
  private renderImpl(impl: Item): string {
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

    sections.push(`### \`${header}\``);
    sections.push("");

    // Render impl methods
    for (const methodId of implDef.items) {
      const method = this.getItem(methodId);
      if (!method || !("function" in method.inner)) continue;

      sections.push("```rust");
      sections.push(formatFunctionSignature(method.name ?? "", method.inner.function));
      sections.push("```");

      if (method.docs) {
        sections.push("");
        sections.push(method.docs);
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  /**
   * Check if an implementation should be excluded from documentation.
   *
   * @param impl - The implementation item to check
   * @returns true if the impl should be excluded, false if it should be included
   */
  private shouldExcludeImpl(impl: Item): boolean {
    if (!("impl" in impl.inner)) return true;

    const implDef = impl.inner.impl;

    // FILTER 1: Blanket implementations
    // Generic impls like `impl<T> From<T> for T` that apply to all types
    if (implDef.blanket_impl) return true;

    // FILTER 2: Synthetic implementations
    // Auto-generated impls for auto traits like Send, Sync, Unpin
    if (implDef.is_synthetic) return true;

    // FILTER 3: Empty external trait implementations
    // Trait impls with no local method overrides (all defaults)
    if (implDef.trait && implDef.items.length === 0) return true;

    return false;
  }

  /**
   * Check if a trait implementation has at least one documented method.
   *
   * @param impl - The implementation item to check
   * @returns true if the impl has documented methods or is an inherent impl
   */
  private hasDocumentedMethods(impl: Item): boolean {
    if (!("impl" in impl.inner)) return false;

    const implDef = impl.inner.impl;

    // Inherent impls (no trait) are always included
    if (!implDef.trait) return true;

    // For trait impls, require at least one documented method
    return implDef.items.some((methodId) => {
      const method = this.getItem(methodId);
      return method?.docs !== undefined;
    });
  }

  /**
   * Gets all relevant implementations for a type (struct, enum, or union).
   *
   * This method retrieves and filters implementations to show only the most
   * useful ones in the documentation. The filtering removes:
   *
   * - **Blanket implementations**: Generic impls like `impl<T> From<T> for T`
   * - **Synthetic implementations**: Compiler-generated auto trait impls
   * - **Empty external trait impls**: Trait impls using only default methods
   * - **Undocumented trait impls**: Trait impls without any documented methods
   *
   * Inherent impls (the type's own methods) are always included.
   *
   * @param item - The type item (struct, enum, or union) to get implementations for
   * @returns Array of impl Items that passed all filters
   */
  private getImplementations(item: Item): Item[] {
    // Extract impl IDs from the type
    let implIds: Id[] = [];
    if ("struct" in item.inner) implIds = item.inner.struct.impls;
    else if ("enum" in item.inner) implIds = item.inner.enum.impls;
    else if ("union" in item.inner) implIds = item.inner.union.impls;

    const results: Item[] = [];

    for (const implId of implIds) {
      const impl = this.getItem(implId);
      if (!impl) continue;

      // Apply exclusion filters
      if (this.shouldExcludeImpl(impl)) continue;

      // Check for documented methods (trait impls only)
      if (!this.hasDocumentedMethods(impl)) continue;

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
    description: firstLine(item.docs) || `Documentation for ${path[path.length - 1] ?? item.name}`,
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
    module: "Folder",
  };
  return map[kind] ?? "FileText";
}
