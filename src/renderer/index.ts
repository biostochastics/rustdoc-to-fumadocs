/**
 * Renderer module for converting rustdoc items to MDX content.
 *
 * @module renderer
 * @description Provides type formatting, signature rendering, and a RenderContext
 * for tracking FumaDocs component usage during generation.
 *
 * @example
 * ```typescript
 * import { RenderContext, formatType, formatFunctionSignature } from './renderer/index.js';
 *
 * const ctx = new RenderContext(crate, options);
 * const typeStr = formatType({ primitive: "i32" });
 * const fnSig = formatFunctionSignature("my_func", fn);
 * ```
 */

import type { RustdocCrate, Item, Id } from "../types.js";

// Re-export type formatting utilities
export { formatType, formatGenericArg, formatGenericBound } from "./types.js";

// Re-export signature formatting utilities
export {
  formatFunctionSignature,
  formatStructSignature,
  formatUnionSignature,
  formatEnumSignature,
  formatTraitSignature,
  formatGenerics,
  formatGenericParam,
} from "./signatures.js";

// Re-export component rendering utilities
export {
  renderCallout,
  renderTabs,
  renderCards,
  renderCodeBlock,
  renderDeprecation,
  renderInfoNotice,
  renderDangerNotice,
  renderSafetyCallout,
  renderFeatureGateCallout,
  renderPanicsCallout,
  renderErrorsCallout,
  extractDocSection,
  indent,
  type CalloutType,
  type CardData,
  type CodeBlockOptions,
} from "./components.js";

/**
 * Maximum number of warnings to store in RenderContext.
 * Prevents unbounded memory growth from corrupted input.
 */
const MAX_WARNINGS = 100;

/**
 * FumaDocs components that can be used in generated MDX.
 */
export type FumaDocsComponent = "Callout" | "Tabs" | "Tab" | "Cards" | "Card";

/**
 * Severity level for generation warnings.
 */
export type WarningSeverity = "info" | "warn" | "error";

/**
 * Warning generated during MDX generation.
 */
export interface GenerationWarning {
  /** Warning severity */
  severity: WarningSeverity;
  /** Warning message */
  message: string;
  /** Item ID related to the warning */
  itemId?: Id;
  /** Item name if available */
  itemName?: string;
}

/**
 * Configuration options for rendering.
 */
export interface RenderOptions {
  /** Whether to use Tabs components for grouping content */
  useTabs: boolean;
  /** Whether to use Cards components for cross-references */
  useCards: boolean;
  /** Code block rendering options */
  codeBlocks: {
    /** Show title in code blocks */
    showTitle: boolean;
    /** Show line numbers in code blocks */
    showLineNumbers: boolean;
  };
}

/**
 * Default render options.
 */
export const defaultRenderOptions: RenderOptions = {
  useTabs: true,
  useCards: true,
  codeBlocks: {
    showTitle: false,
    showLineNumbers: false,
  },
};

/**
 * Context for rendering rustdoc items to MDX.
 *
 * Tracks FumaDocs component usage and provides access to the crate index
 * for resolving cross-references. Also collects warnings during generation.
 *
 * @example
 * ```typescript
 * const ctx = new RenderContext(crate, options);
 *
 * // Mark components as used
 * ctx.useComponent("Callout");
 * ctx.useComponent("Tabs");
 *
 * // Get import statements for used components
 * const imports = ctx.getImports();
 * // ["import { Callout, Tabs } from 'fumadocs-ui/components/callout';"]
 *
 * // Record warnings
 * ctx.warn({ severity: "warn", message: "Unknown type", itemId: "0:123" });
 * ```
 */
export class RenderContext {
  private readonly usedComponents = new Set<FumaDocsComponent>();
  private readonly warnings: GenerationWarning[] = [];

  /**
   * Create a new render context.
   *
   * @param crate - The rustdoc crate data
   * @param options - Render options
   */
  constructor(
    private readonly crate: RustdocCrate,
    private readonly options: RenderOptions = defaultRenderOptions
  ) {}

  /**
   * Get an item from the crate index by ID.
   * Handles both string and numeric IDs (format v56+ uses numeric).
   *
   * @param id - The item ID (string or number)
   * @returns The item if found, undefined otherwise
   */
  getItem(id: Id): Item | undefined {
    // JSON object keys are always strings, so convert numeric IDs
    const key = String(id);
    return this.crate.index[key];
  }

  /**
   * Get the path segments for an item by ID.
   * Handles both string and numeric IDs (format v56+ uses numeric).
   *
   * @param id - The item ID (string or number)
   * @returns Array of path segments, or undefined if not found
   */
  getPath(id: Id): string[] | undefined {
    // JSON object keys are always strings, so convert numeric IDs
    const key = String(id);
    return this.crate.paths[key]?.path;
  }

  /**
   * Get the full crate data.
   *
   * @returns The rustdoc crate
   */
  getCrate(): RustdocCrate {
    return this.crate;
  }

  /**
   * Get the render options.
   *
   * @returns Current render options
   */
  getOptions(): RenderOptions {
    return this.options;
  }

  /**
   * Mark a FumaDocs component as used in the current rendering context.
   *
   * @param name - The component name
   */
  useComponent(name: FumaDocsComponent): void {
    this.usedComponents.add(name);
  }

  /**
   * Check if a component has been used.
   *
   * @param name - The component name
   * @returns true if the component has been used
   */
  hasComponent(name: FumaDocsComponent): boolean {
    return this.usedComponents.has(name);
  }

  /**
   * Get all used components.
   *
   * @returns Set of used component names
   */
  getUsedComponents(): Set<FumaDocsComponent> {
    return new Set(this.usedComponents);
  }

  /**
   * Generate import statements for all used FumaDocs components.
   *
   * Groups imports by their source module for cleaner output.
   *
   * @returns Array of import statement strings
   */
  getImports(): string[] {
    const imports: string[] = [];

    // Group components by source
    const calloutComponents = ["Callout"].filter((c) =>
      this.usedComponents.has(c as FumaDocsComponent)
    );
    const tabComponents = ["Tabs", "Tab"].filter((c) =>
      this.usedComponents.has(c as FumaDocsComponent)
    );
    const cardComponents = ["Cards", "Card"].filter((c) =>
      this.usedComponents.has(c as FumaDocsComponent)
    );

    if (calloutComponents.length > 0) {
      imports.push(
        `import { ${calloutComponents.join(", ")} } from 'fumadocs-ui/components/callout';`
      );
    }
    if (tabComponents.length > 0) {
      imports.push(`import { ${tabComponents.join(", ")} } from 'fumadocs-ui/components/tabs';`);
    }
    if (cardComponents.length > 0) {
      imports.push(`import { ${cardComponents.join(", ")} } from 'fumadocs-ui/components/card';`);
    }

    return imports;
  }

  /**
   * Reset the used components set.
   * Call this when starting a new file to track imports per-file.
   */
  resetComponents(): void {
    this.usedComponents.clear();
  }

  /**
   * Record a warning that occurred during generation.
   * Warnings are limited to MAX_WARNINGS to prevent unbounded memory growth.
   *
   * @param warning - The warning to record
   */
  warn(warning: GenerationWarning): void {
    if (this.warnings.length >= MAX_WARNINGS) {
      return; // Silently drop warnings beyond the limit
    }
    this.warnings.push(warning);
  }

  /**
   * Get all recorded warnings.
   *
   * @returns Array of warnings
   */
  getWarnings(): GenerationWarning[] {
    return [...this.warnings];
  }

  /**
   * Get warnings filtered by severity.
   *
   * @param severity - The minimum severity to include
   * @returns Array of warnings at or above the given severity
   */
  getWarningsBySeverity(severity: WarningSeverity): GenerationWarning[] {
    const severityOrder: WarningSeverity[] = ["info", "warn", "error"];
    const minIndex = severityOrder.indexOf(severity);
    return this.warnings.filter((w) => severityOrder.indexOf(w.severity) >= minIndex);
  }

  /**
   * Clear all recorded warnings.
   */
  clearWarnings(): void {
    this.warnings.length = 0;
  }
}
