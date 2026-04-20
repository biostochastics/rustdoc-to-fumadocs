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
import type { RustdocCrate, Item, ItemKind, Id, VariantKind, Type, Attribute } from "./types.js";
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
}

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
  private options: Required<GeneratorOptions>;
  private warningCount = 0;
  private missingRefCount = 0;

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
    } as Required<GeneratorOptions>;
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
   * @throws RustdocError if root item is missing or not a module
   */
  generate(): GeneratedFile[] {
    const files: GeneratedFile[] = [];
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

    // Process the root module recursively with visited set for circular reference detection
    const visited = new Set<string>();
    this.processModule(rootItem, [], files, 0, visited);

    return files;
  }

  /**
   * Recursively processes a module and its children, generating MDX files.
   *
   * This method performs a depth-first traversal of the module hierarchy:
   * 1. Validates recursion depth to prevent stack overflow
   * 2. Detects circular module references via visited set
   * 3. Collects and categorizes child items by kind (struct, enum, function, etc.)
   * 4. Recursively processes submodules (incrementing depth)
   * 5. Generates index page for the module (if enabled)
   * 6. Generates meta.json for FumaDocs navigation
   * 7. Generates individual item pages based on groupBy mode
   *
   * Items are filtered using the configured filter function, and implementations
   * (impls) are skipped here since they're rendered with their associated types.
   *
   * @param item - The module item to process (must have 'module' in inner)
   * @param parentPath - Array of ancestor module names forming the path
   * @param files - Accumulator array for generated files (mutated)
   * @param depth - Current recursion depth for overflow protection (default: 0)
   * @param visited - Set of visited module IDs for circular reference detection
   *
   * @remarks
   * - Module names are sanitized via `sanitizePath()` to prevent directory traversal
   * - Unknown item kinds are skipped with a warning for forward compatibility
   * - Missing item references are tracked and summarized at the end
   * - Circular module references are detected and warned about
   */
  private processModule(
    item: Item,
    parentPath: string[],
    files: GeneratedFile[],
    depth = 0,
    visited = new Set<string>()
  ): void {
    // Prevent stack overflow from deeply nested or circular module hierarchies
    if (depth > MAX_RECURSION_DEPTH) {
      this.warn(
        `Maximum module nesting depth (${MAX_RECURSION_DEPTH}) exceeded at ${item.name ?? "unknown"}. ` +
          `Skipping further nested modules.`
      );
      return;
    }

    // Detect circular module references
    const itemKey = String(item.id);
    if (visited.has(itemKey)) {
      this.warn(`Circular module reference detected: ${item.name ?? itemKey}. Skipping.`);
      return;
    }
    visited.add(itemKey);

    // Check for module type with proper warning for unexpected items
    if (!("module" in item.inner)) {
      // Only warn if this appears to be a genuine module item (has docs or non-empty name)
      // This handles format differences and edge cases gracefully
      const itemName = item.name ?? `id:${String(item.id)}`;
      if (item.docs || (item.name && item.name.length > 0)) {
        this.warn(
          `Expected module type for "${itemName}" but found: ${Object.keys(item.inner).join(", ")}`
        );
      }
      return;
    }

    const module = item.inner.module;
    // Sanitize module name to prevent path traversal
    const sanitizedName = item.name ? sanitizePath(item.name) : null;
    const modulePath = sanitizedName ? [...parentPath, sanitizedName] : parentPath;
    const dirPath = modulePath.length > 0 ? modulePath.join("/") : "";

    // Collect items by kind for this module
    const itemsByKind = new Map<ItemKind, Item[]>();

    for (const childId of module.items) {
      const childItem = this.getItem(childId);
      if (!childItem) {
        // Track missing references instead of silently skipping
        this.warnMissingRef(childId, item.name);
        continue;
      }
      if (!this.options.filter(childItem)) continue;

      const kind = getItemKind(childItem.inner);

      // Skip unknown item kinds (forward compatibility)
      if (kind === "unknown") {
        this.warn(`Skipping unknown item kind in ${childItem.name ?? childId}`);
        continue;
      }

      // Recursively process submodules with incremented depth
      if (kind === "module") {
        this.processModule(childItem, modulePath, files, depth + 1, visited);
        continue;
      }

      // Skip impls - they'll be rendered with their types
      if (kind === "impl") continue;

      if (!itemsByKind.has(kind)) {
        itemsByKind.set(kind, []);
      }
      itemsByKind.get(kind)!.push(childItem);
    }

    // Generate index page for this module
    if (this.options.generateIndex && modulePath.length > 0) {
      const indexContent = this.generateModuleIndex(item, modulePath, itemsByKind);
      files.push({
        path: `${dirPath}/index.mdx`,
        content: indexContent,
      });
    }

    // Generate meta.json for Fumadocs navigation
    // Only generate at root if this is the root module
    const isRootModule = parentPath.length === 0 && !item.name;
    const metaContent = this.generateMeta(item, itemsByKind);
    files.push({
      path: dirPath ? `${dirPath}/meta.json` : "meta.json",
      content: metaContent,
    });

    // Generate individual item pages based on groupBy
    if (this.options.groupBy === "kind") {
      // Group by kind: functions.mdx, structs.mdx, etc.
      for (const [kind, items] of itemsByKind) {
        if (items.length === 0) continue;
        const content = this.generateKindPage(kind, items, modulePath);
        // Fix: For root module (empty dirPath), still need valid path
        const filename = kindToFilename(kind);
        files.push({
          path: dirPath ? `${dirPath}/${filename}.mdx` : `${filename}.mdx`,
          content,
        });
      }
    } else {
      // One page per item
      for (const [, items] of itemsByKind) {
        for (const childItem of items) {
          if (!childItem.name) continue;
          // Sanitize item name for path safety
          const safeName = sanitizePath(childItem.name);
          const content = this.generateItemPage(childItem, modulePath);
          files.push({
            path: dirPath ? `${dirPath}/${safeName}.mdx` : `${safeName}.mdx`,
            content,
          });
        }
      }
    }

    // Report summary of missing references at end of root module processing
    if (isRootModule && this.missingRefCount > 5) {
      console.warn(`Total missing item references: ${this.missingRefCount} (only first 5 shown)`);
    }
  }

  /**
   * Generates the index.mdx page content for a module.
   *
   * The index page provides an overview of the module including:
   * - YAML frontmatter with title, description, and icon
   * - Module-level documentation (if present)
   * - Table of contents organized by item kind (Structs, Enums, Functions, etc.)
   *
   * Items are sorted alphabetically within each kind section and linked
   * appropriately based on the groupBy mode (linking to kind file or item file).
   *
   * @param item - The module item containing docs and metadata
   * @param path - Module path segments for URL generation (e.g., ["crate", "module"])
   * @param itemsByKind - Map of item kind to array of items in this module
   * @returns Complete MDX content string for the module index page
   */
  private generateModuleIndex(
    item: Item,
    path: string[],
    itemsByKind: Map<ItemKind, Item[]>
  ): string {
    const frontmatter = this.options.frontmatter(item, path);
    const sections: string[] = [];

    sections.push(this.formatFrontmatter(frontmatter));
    sections.push("");

    if (item.docs) {
      sections.push(item.docs);
      sections.push("");
    }

    // Generate table of contents by kind
    for (const kind of KIND_ORDER) {
      const items = itemsByKind.get(kind);
      if (!items || items.length === 0) continue;

      sections.push(`## ${kindToTitle(kind)}`);
      sections.push("");

      for (const childItem of items.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
        if (!childItem.name) continue;
        const desc = childItem.docs?.split("\n")[0] ?? "";
        // Fix: Link to kind file when groupBy is "kind", otherwise link to item file
        const linkTarget =
          this.options.groupBy === "kind"
            ? `./${kindToFilename(kind)}#${childItem.name?.toLowerCase()}`
            : `./${childItem.name}`;
        sections.push(`- [\`${childItem.name}\`](${linkTarget}) - ${desc}`);
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  /**
   * Generate meta.json for FumaDocs v14+ navigation.
   * Includes separators, icons, and proper page ordering.
   *
   * @see https://fumadocs.dev/docs/ui/navigation
   */
  private generateMeta(item: Item, itemsByKind: Map<ItemKind, Item[]>): string {
    const pages: (string | { type: string; name: string; icon?: string })[] = [];

    if (this.options.generateIndex && item.name) {
      pages.push("index");
    }

    // Add items in a logical order with FumaDocs v14+ separators
    if (this.options.groupBy === "kind") {
      // Group by kind: add kind files with separators
      let addedAny = false;
      for (const kind of KIND_ORDER) {
        const items = itemsByKind.get(kind);
        if (items && items.length > 0) {
          if (addedAny) {
            // Add separator between kinds (FumaDocs v14+ separator syntax)
            pages.push(`---${kindToTitle(kind)}---`);
          }
          pages.push(kindToFilename(kind));
          addedAny = true;
        }
      }
    } else {
      // Module mode: group items by kind with separators
      for (const kind of KIND_ORDER) {
        const items = itemsByKind.get(kind);
        if (!items || items.length === 0) continue;

        // Add separator for each kind section (FumaDocs v14+ syntax)
        pages.push(`---${kindToTitle(kind)}---`);

        for (const childItem of items.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
          if (childItem.name) {
            pages.push(childItem.name);
          }
        }
      }
    }

    // Find submodules and add them with folder icon
    if ("module" in item.inner) {
      const submodules = item.inner.module.items
        .map((childId) => this.getItem(childId))
        .filter(
          (childItem): childItem is Item =>
            childItem !== undefined && "module" in childItem.inner && Boolean(childItem.name)
        )
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

      if (submodules.length > 0) {
        pages.push("---Modules---");
        for (const childItem of submodules) {
          // Use FumaDocs v14+ folder extraction syntax
          pages.push(`...${childItem.name}`);
        }
      }
    }

    // Build meta.json with FumaDocs v14+ structure
    const meta: Record<string, unknown> = {
      title: item.name ?? this.crate.crate_version ?? "API",
      icon: "Folder",
      defaultOpen: true,
      pages,
    };

    return JSON.stringify(meta, null, 2);
  }

  /**
   * Generates a page grouping all items of a specific kind.
   *
   * Used when groupBy is set to "kind" to create files like `structs.mdx`,
   * `functions.mdx`, etc. Each item is rendered with full documentation
   * and separated by horizontal rules.
   *
   * @param kind - The item kind being grouped (e.g., "struct", "function")
   * @param items - Array of items of this kind to render
   * @param path - Module path for generating description context
   * @returns Complete MDX content string with all items of this kind
   */
  private generateKindPage(kind: ItemKind, items: Item[], path: string[]): string {
    const sections: string[] = [];

    sections.push(
      this.formatFrontmatter({
        title: kindToTitle(kind),
        description: `${kindToTitle(kind)} in ${path.join("::")}`,
      })
    );
    sections.push("");

    for (const item of items.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
      sections.push(this.renderItem(item));
      sections.push("");
      sections.push("---");
      sections.push("");
    }

    return sections.join("\n");
  }

  /**
   * Generates a complete MDX page for a single item.
   *
   * This is the main page generation method for individual items. It produces:
   * 1. YAML frontmatter via the configured frontmatter function
   * 2. Item content via renderItem() (signature, docs, fields/variants)
   * 3. Implementations section (for structs, enums, unions) with:
   *    - Inherent methods and trait implementations
   *    - Optional Tabs component to separate method types
   * 4. "See Also" section with Cards linking to related types
   *
   * @param item - The item to generate a page for
   * @param path - Module path for context and frontmatter generation
   * @returns Complete MDX content string for the item page
   */
  private generateItemPage(item: Item, path: string[]): string {
    const frontmatter = this.options.frontmatter(item, [...path, item.name ?? ""]);
    const sections: string[] = [];

    sections.push(this.formatFrontmatter(frontmatter));
    sections.push("");
    sections.push(this.renderItem(item));

    // Render implementations for structs, enums, unions
    const impls = this.getImplementations(item);
    if (impls.length > 0) {
      sections.push("");
      sections.push("## Implementations");
      sections.push("");

      // Separate inherent impls from trait impls
      const inherentImpls = impls.filter((impl) => "impl" in impl.inner && !impl.inner.impl.trait);
      const traitImpls = impls.filter((impl) => "impl" in impl.inner && impl.inner.impl.trait);

      // Use Tabs if both types exist and useTabs is enabled
      if (this.options.useTabs && inherentImpls.length > 0 && traitImpls.length > 0) {
        const methodsContent = inherentImpls.map((impl) => this.renderImpl(impl)).join("\n\n");
        const traitsContent = traitImpls.map((impl) => this.renderImpl(impl)).join("\n\n");

        const tabContents = new Map<string, string>();
        tabContents.set("Methods", methodsContent);
        tabContents.set("Trait Implementations", traitsContent);

        sections.push(renderTabs(["Methods", "Trait Implementations"], tabContents));
      } else {
        // Render without tabs
        for (const impl of impls) {
          sections.push(this.renderImpl(impl));
          sections.push("");
        }
      }
    }

    // Add "See Also" section with cross-references
    if (this.options.useCards) {
      const crossRefs = this.extractCrossReferences(item);
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
      // Also collect generic arguments
      if (type.resolved_path.args) {
        const args = type.resolved_path.args;
        if ("angle_bracketed" in args) {
          for (const arg of args.angle_bracketed.args) {
            if ("type" in arg) {
              this.collectTypeReferences(arg.type, refs, depth + 1);
            }
          }
        }
      }
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
        }
      }
    } else if ("dyn_trait" in type) {
      for (const polyTrait of type.dyn_trait.traits) {
        refs.add(polyTrait.trait.id);
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
      // Traverse qualified path self type
      this.collectTypeReferences(type.qualified_path.self_type, refs, depth + 1);
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
  private renderItem(item: Item): string {
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
        sections.push(this.renderFunction(item));
        break;
      case "struct":
        sections.push(this.renderStruct(item));
        break;
      case "union":
        sections.push(this.renderUnion(item));
        break;
      case "enum":
        sections.push(this.renderEnum(item));
        break;
      case "trait":
        sections.push(this.renderTrait(item));
        break;
      case "type_alias":
        sections.push(this.renderTypeAlias(item));
        break;
      case "constant":
      case "static":
        sections.push(this.renderConstant(item));
        break;
      case "macro":
        sections.push(this.renderMacro(item));
        break;
      default:
        sections.push(`## ${item.name ?? "Unknown"}`);
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
  private renderFunction(item: Item): string {
    if (!("function" in item.inner)) return "";
    const fn = item.inner.function;
    const sections: string[] = [];

    sections.push(`## \`${item.name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatFunctionSignature(item.name ?? "", fn));
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
  private renderStruct(item: Item): string {
    if (!("struct" in item.inner)) return "";
    const struct = item.inner.struct;
    const sections: string[] = [];

    sections.push(`## \`${item.name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatStructSignature(item.name ?? "", struct));
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
  private renderUnion(item: Item): string {
    if (!("union" in item.inner)) return "";
    const union = item.inner.union;
    const sections: string[] = [];

    sections.push(`## \`${item.name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatUnionSignature(item.name ?? "", union));
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
  private renderEnum(item: Item): string {
    if (!("enum" in item.inner)) return "";
    const enumDef = item.inner.enum;
    const sections: string[] = [];

    sections.push(`## \`${item.name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatEnumSignature(item.name ?? "", enumDef));
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
  private renderTrait(item: Item): string {
    if (!("trait" in item.inner)) return "";
    const trait = item.inner.trait;
    const sections: string[] = [];

    sections.push(`## \`${item.name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(formatTraitSignature(item.name ?? "", trait));
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
  private renderTypeAlias(item: Item): string {
    if (!("type_alias" in item.inner)) return "";
    const alias = item.inner.type_alias;
    const sections: string[] = [];

    sections.push(`## \`${item.name}\``);
    sections.push("");
    sections.push("```rust");
    sections.push(
      `type ${item.name}${formatGenerics(alias.generics)} = ${formatType(alias.type)};`
    );
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
  private renderConstant(item: Item): string {
    const sections: string[] = [];
    sections.push(`## \`${item.name}\``);

    if ("constant" in item.inner) {
      const constant = item.inner.constant;
      const typeName = formatType(constant.type);
      sections.push("");
      sections.push("```rust");
      // Show value if available, otherwise just the expression
      const constExpr = constant.const;
      const value = constExpr.value ?? constExpr.expr;
      sections.push(`const ${item.name}: ${typeName} = ${value};`);
      sections.push("```");
    } else if ("static" in item.inner) {
      const staticDef = item.inner.static;
      const typeName = formatType(staticDef.type);
      sections.push("");
      sections.push("```rust");
      sections.push(
        `static ${staticDef.is_mutable ? "mut " : ""}${item.name}: ${typeName} = ${staticDef.expr};`
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
  private renderMacro(item: Item): string {
    const sections: string[] = [];
    sections.push(`## \`${item.name}!\``);
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
    title: item.name ?? path[path.length - 1] ?? "API",
    description: item.docs?.split("\n")[0] ?? `Documentation for ${item.name}`,
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
