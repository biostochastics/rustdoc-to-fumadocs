/**
 * FumaDocs UI component generators for MDX output.
 *
 * @module renderer/components
 * @description Generates FumaDocs-compatible JSX components with proper escaping.
 * All string props use JSX expression syntax with JSON.stringify for safe escaping.
 *
 * @example
 * ```typescript
 * import { renderCallout, renderTabs, renderCards, renderCodeBlock } from './components.js';
 *
 * const callout = renderCallout('warn', 'Deprecated', 'Use v2 API instead.');
 * const tabs = renderTabs(['Methods', 'Traits'], new Map([['Methods', '...'], ['Traits', '...']]));
 * ```
 */

/**
 * Callout severity types supported by FumaDocs.
 */
export type CalloutType = "info" | "warn" | "error";

/**
 * Card data for rendering navigation cards.
 */
export interface CardData {
  /** Card title */
  title: string;
  /** Link target */
  href: string;
  /** Optional description text */
  description?: string;
  /** Optional icon name (lucide-react) */
  icon?: string;
}

/**
 * Options for code block rendering.
 */
export interface CodeBlockOptions {
  /** Title to display above the code block */
  title?: string;
  /** Whether to show line numbers */
  showLineNumbers?: boolean;
}

/**
 * Indent a multiline string by a given number of spaces.
 *
 * @param str - The string to indent
 * @param spaces - Number of spaces to indent each line
 * @returns Indented string
 *
 * @example
 * ```typescript
 * const indented = indent("line1\nline2", 2);
 * // "  line1\n  line2"
 * ```
 */
export function indent(str: string, spaces: number): string {
  const padding = " ".repeat(spaces);
  return str
    .split("\n")
    .map((line) => (line.length > 0 ? padding + line : line))
    .join("\n");
}

/**
 * Render a FumaDocs Callout component.
 *
 * Uses JSX expression syntax for string props to properly escape special characters.
 * This is the correct approach for MDX/JSX - HTML entity escaping does NOT work.
 *
 * @param type - Callout severity: 'info', 'warn', or 'error'
 * @param title - Callout title (will be JSON-escaped)
 * @param content - Callout body content (markdown supported)
 * @returns MDX string for the Callout component
 *
 * @example
 * ```typescript
 * const callout = renderCallout('warn', 'Deprecated since 1.2.0', 'Use `new_function` instead.');
 * // <Callout type="warn" title={"Deprecated since 1.2.0"}>
 * // Use `new_function` instead.
 * // </Callout>
 * ```
 */
export function renderCallout(type: CalloutType, title: string, content: string): string {
  // Use JSON.stringify for title to properly escape quotes and special chars
  // This produces JSX expression syntax: title={"string with \"quotes\""}
  return `<Callout type="${type}" title={${JSON.stringify(title)}}>
${content}
</Callout>`;
}

/**
 * Render a FumaDocs Tabs component with Tab children.
 *
 * Uses JSX expression syntax for string props to properly escape special characters.
 *
 * @param items - Array of tab labels
 * @param contents - Map of tab label to content
 * @returns MDX string for the Tabs component with Tab children
 *
 * @example
 * ```typescript
 * const tabs = renderTabs(
 *   ['Methods', 'Trait Implementations'],
 *   new Map([
 *     ['Methods', '## Methods\n\n...'],
 *     ['Trait Implementations', '## Traits\n\n...'],
 *   ])
 * );
 * ```
 */
export function renderTabs(items: string[], contents: Map<string, string>): string {
  // Format items array as JSX expression
  const itemsExpr = JSON.stringify(items);

  // Build Tab components
  const tabComponents = items
    .map((item) => {
      const tabContent = contents.get(item) ?? "";
      // Use JSON.stringify for value prop to escape special characters
      return `  <Tab value={${JSON.stringify(item)}}>
${indent(tabContent, 4)}
  </Tab>`;
    })
    .join("\n");

  return `<Tabs items={${itemsExpr}}>
${tabComponents}
</Tabs>`;
}

/**
 * Render a FumaDocs Cards component with Card children.
 *
 * Cards are useful for navigation and cross-references between API items.
 *
 * @param cards - Array of card data objects
 * @returns MDX string for the Cards component with Card children
 *
 * @example
 * ```typescript
 * const cards = renderCards([
 *   { title: 'MyStruct', href: './MyStruct', description: 'A data structure', icon: 'Box' },
 *   { title: 'my_func', href: './my_func', description: 'A function', icon: 'Code' },
 * ]);
 * ```
 */
export function renderCards(cards: CardData[]): string {
  if (cards.length === 0) {
    return "<Cards>\n</Cards>";
  }

  const cardComponents = cards
    .map((card) => {
      // Build props list - always use JSON.stringify for string values
      const props: string[] = [
        `title={${JSON.stringify(card.title)}}`,
        `href={${JSON.stringify(card.href)}}`,
      ];

      if (card.description !== undefined) {
        props.push(`description={${JSON.stringify(card.description)}}`);
      }

      if (card.icon !== undefined) {
        props.push(`icon={${JSON.stringify(card.icon)}}`);
      }

      return `  <Card ${props.join(" ")} />`;
    })
    .join("\n");

  return `<Cards>
${cardComponents}
</Cards>`;
}

/**
 * Render a fenced code block with optional metadata.
 *
 * Supports FumaDocs code block features like title and line numbers.
 *
 * @param code - The code content
 * @param language - Language identifier for syntax highlighting (e.g., 'rust', 'typescript')
 * @param options - Optional settings for title and line numbers
 * @returns Fenced code block string
 *
 * @example
 * ```typescript
 * const block = renderCodeBlock('fn main() {}', 'rust', { title: 'main.rs', showLineNumbers: true });
 * // ```rust title="main.rs" showLineNumbers
 * // fn main() {}
 * // ```
 * ```
 */
export function renderCodeBlock(
  code: string,
  language: string,
  options?: CodeBlockOptions
): string {
  // Build metadata string after language identifier
  const meta: string[] = [];

  if (options?.title) {
    // Title uses attribute syntax with quotes
    meta.push(`title="${options.title}"`);
  }

  if (options?.showLineNumbers) {
    meta.push("showLineNumbers");
  }

  // Construct the opening fence line
  const metaStr = meta.length > 0 ? ` ${meta.join(" ")}` : "";
  const openFence = "```" + language + metaStr;

  return `${openFence}
${code}
\`\`\``;
}

/**
 * Render a deprecation callout for deprecated items.
 *
 * This is a convenience wrapper around renderCallout for consistent deprecation formatting.
 *
 * @param since - Version when the item was deprecated (optional)
 * @param note - Deprecation message explaining what to use instead
 * @returns MDX Callout component for deprecation warning
 *
 * @example
 * ```typescript
 * const deprecation = renderDeprecation('1.2.0', 'Use `new_function` instead.');
 * ```
 */
export function renderDeprecation(since?: string, note?: string): string {
  const title = since ? `Deprecated since ${since}` : "Deprecated";
  const content = note ?? "This item is deprecated.";
  return renderCallout("warn", title, content);
}

/**
 * Render an info callout for stability notices, feature gates, etc.
 *
 * @param title - The notice title
 * @param content - The notice content
 * @returns MDX Callout component for info notice
 *
 * @example
 * ```typescript
 * const notice = renderInfoNotice('Unstable', 'This feature requires `#![feature(my_feature)]`');
 * ```
 */
export function renderInfoNotice(title: string, content: string): string {
  return renderCallout("info", title, content);
}

/**
 * Render an error callout for unsafe code warnings, etc.
 *
 * @param title - The warning title
 * @param content - The warning content
 * @returns MDX Callout component for error/danger notice
 *
 * @example
 * ```typescript
 * const warning = renderDangerNotice('Unsafe', 'This function is unsafe and requires careful usage.');
 * ```
 */
export function renderDangerNotice(title: string, content: string): string {
  return renderCallout("error", title, content);
}

/**
 * Render a safety callout for unsafe functions, traits, and impl blocks.
 *
 * Extracts and displays the `# Safety` section from documentation if present,
 * or displays a generic warning if no safety documentation is provided.
 *
 * @param docs - The item's documentation string (may contain # Safety section)
 * @returns MDX Callout component for safety notice, or empty string if not unsafe
 *
 * @example
 * ```typescript
 * const safety = renderSafetyCallout("# Safety\n\nCaller must ensure pointer is valid.");
 * // <Callout type="error" title={"Safety"}>
 * // Caller must ensure pointer is valid.
 * // </Callout>
 * ```
 */
export function renderSafetyCallout(docs?: string | null): string {
  const safetySection = extractDocSection(docs, "Safety");
  if (safetySection) {
    return renderCallout("error", "Safety", safetySection);
  }
  return renderCallout(
    "error",
    "Unsafe",
    "This item is marked as `unsafe`. Callers must uphold the safety invariants documented for this item."
  );
}

/**
 * Render a feature gate callout for items requiring specific Cargo features.
 *
 * @param feature - The required feature name
 * @returns MDX Callout component for feature gate notice
 *
 * @example
 * ```typescript
 * const featureGate = renderFeatureGateCallout("async-std");
 * // <Callout type="info" title={"Feature Gate"}>
 * // This item requires the `async-std` feature to be enabled in `Cargo.toml`.
 * // </Callout>
 * ```
 */
export function renderFeatureGateCallout(feature: string): string {
  return renderCallout(
    "info",
    "Feature Gate",
    `This item requires the \`${feature}\` feature to be enabled in \`Cargo.toml\`.\n\n\`\`\`toml\n[dependencies]\ncrate_name = { version = "...", features = ["${feature}"] }\n\`\`\``
  );
}

/**
 * Render a panics callout for functions that may panic.
 *
 * Extracts the `# Panics` section from documentation if present.
 *
 * @param docs - The item's documentation string
 * @returns MDX Callout component for panics notice, or empty string if no panics section
 *
 * @example
 * ```typescript
 * const panics = renderPanicsCallout("# Panics\n\nPanics if index is out of bounds.");
 * // <Callout type="error" title={"Panics"}>
 * // Panics if index is out of bounds.
 * // </Callout>
 * ```
 */
export function renderPanicsCallout(docs?: string | null): string {
  const panicsSection = extractDocSection(docs, "Panics");
  if (panicsSection) {
    return renderCallout("error", "Panics", panicsSection);
  }
  return "";
}

/**
 * Render an errors callout for functions that may return errors.
 *
 * Extracts the `# Errors` section from documentation if present.
 *
 * @param docs - The item's documentation string
 * @returns MDX Callout component for errors notice, or empty string if no errors section
 *
 * @example
 * ```typescript
 * const errors = renderErrorsCallout("# Errors\n\nReturns `Err` if the file does not exist.");
 * ```
 */
export function renderErrorsCallout(docs?: string | null): string {
  const errorsSection = extractDocSection(docs, "Errors");
  if (errorsSection) {
    return renderCallout("warn", "Errors", errorsSection);
  }
  return "";
}

/**
 * Extract a named section from Rust documentation.
 *
 * Looks for a markdown heading like `# Safety` or `## Panics` and extracts
 * the content until the next heading of equal or higher level.
 *
 * @param docs - The documentation string to search
 * @param sectionName - The section name to extract (case-insensitive)
 * @returns The section content, or undefined if not found
 *
 * @example
 * ```typescript
 * const safety = extractDocSection(docs, "Safety");
 * const panics = extractDocSection(docs, "Panics");
 * ```
 */
export function extractDocSection(
  docs: string | null | undefined,
  sectionName: string
): string | undefined {
  if (!docs) return undefined;

  // Match # Safety, ## Safety, ### Safety, etc. (case-insensitive)
  const pattern = new RegExp(`^(#{1,6})\\s+${sectionName}\\s*$`, "im");
  const match = docs.match(pattern);

  if (match?.index === undefined) return undefined;

  const headingLevel = match[1].length;
  const startIndex = match.index + match[0].length;

  // Find the next heading of equal or higher level
  const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s+`, "m");
  const restOfDoc = docs.slice(startIndex);
  const nextMatch = restOfDoc.match(nextHeadingPattern);

  let content: string;
  if (nextMatch?.index !== undefined) {
    content = restOfDoc.slice(0, nextMatch.index);
  } else {
    content = restOfDoc;
  }

  return content.trim();
}
