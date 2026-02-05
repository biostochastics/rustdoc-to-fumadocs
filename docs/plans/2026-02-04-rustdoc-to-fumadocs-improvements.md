# rustdoc-to-fumadocs Improvement Design

**Date**: 2026-02-04
**Status**: Approved
**Author**: Claude Code (multi-model consensus: gpt-5.2-pro, glm-4.7, minimax-m2.1)

## Overview

This document describes comprehensive improvements to the rustdoc-to-fumadocs adapter, covering robustness, FumaDocs v14+ features, error handling, documentation, and testing.

## Goals

1. **Robustness**: Handle all rustdoc JSON edge cases gracefully
2. **FumaDocs v14+**: Leverage modern components (Tabs, Cards, enhanced code blocks)
3. **Error Handling**: Helpful errors with recovery hints
4. **Documentation**: Comprehensive JSDoc, README, and examples
5. **Testing**: Unit tests, integration tests, and snapshot testing

## Non-Goals

- Supporting rustdoc HTML output (JSON only)
- Real-time incremental generation
- Custom theming beyond FumaDocs defaults

---

## Architecture

### Current Structure

```
src/
├── index.ts      # Library entry point
├── cli.ts        # CLI argument parsing
├── types.ts      # TypeScript types for rustdoc JSON
└── generator.ts  # Core conversion logic (1128 lines)
```

### Proposed Structure

```
src/
├── index.ts              # Library entry (exports)
├── cli.ts                # CLI with improved UX
├── types.ts              # Rustdoc types (unchanged)
├── generator.ts          # Orchestration (simplified)
├── errors.ts             # NEW: Custom error types
├── validation.ts         # NEW: Zod schema validation
└── renderer/             # NEW: Extracted rendering logic
    ├── index.ts          # RenderContext class
    ├── components.ts     # FumaDocs component generators
    ├── signatures.ts     # Rust signature formatting
    └── types.ts          # Type rendering utilities
```

### Key Design Decisions

1. **Extract renderer module**: The `generator.ts` file is 1100+ lines with mixed concerns. Extract rendering logic into focused modules.

2. **Zod for validation**: Add runtime validation of rustdoc JSON with helpful error messages and format version checking.

3. **Explicit error types**: Replace `console.warn` with structured warnings that can be collected and reported.

4. **Component options**: Make FumaDocs component usage configurable for users who want simpler output.

---

## Section 1: FumaDocs v14+ Component Improvements

### 1.1 Enhanced Code Blocks

**Current**:

````mdx
```rust
pub fn new() -> Self
```
````

````

**Proposed**:
```mdx
```rust title="Signature"
pub fn new() -> Self
````

````

Implementation:
- Add `title` attribute with item name
- Optional `showLineNumbers` for longer signatures
- Use language `rust` consistently

### 1.2 Tabs for Implementations

When a type has both inherent methods and trait implementations, use Tabs:

```mdx
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';

<Tabs items={['Methods', 'Trait Implementations']}>
  <Tab value="Methods">
    ### `new`
    Creates a new instance.

    ```rust title="Signature"
    pub fn new() -> Self
    ```
  </Tab>
  <Tab value="Trait Implementations">
    ### `impl Clone for MyStruct`
    ```rust
    fn clone(&self) -> Self
    ```
  </Tab>
</Tabs>
````

Configuration option:

```typescript
interface GeneratorOptions {
  /** Use Tabs for separating methods vs trait impls (default: true) */
  useTabs?: boolean;
}
```

### 1.3 Cards for Cross-References

Generate Cards component for "See Also" sections linking to related types:

```mdx
import { Cards, Card } from "fumadocs-ui/components/card";

## See Also

<Cards>
  <Card title="Error" href="./Error">
    The error type returned by this function
  </Card>
  <Card title="Builder" href="./MyStructBuilder">
    Builder pattern for constructing MyStruct
  </Card>
</Cards>
```

Cross-references are extracted from:

- Function return types and parameters
- Struct field types
- Trait bounds
- Associated types

### 1.4 Callout Variants

Expand Callout usage beyond deprecation warnings:

| Scenario               | Callout Type | Title                |
| ---------------------- | ------------ | -------------------- |
| Deprecated item        | `warn`       | "Deprecated since X" |
| Unsafe function        | `error`      | "Safety"             |
| Panics section in docs | `error`      | "Panics"             |
| Examples in docs       | `info`       | "Example"            |
| Feature-gated items    | `info`       | "Feature: X"         |

```mdx
<Callout type="error" title="Safety">
  This function is unsafe because it dereferences raw pointers. The caller must ensure the pointer
  is valid.
</Callout>
```

### 1.5 Improved meta.json

Current meta.json uses string pages. Enhance with icon objects:

```json
{
  "title": "my_module",
  "icon": "Folder",
  "defaultOpen": true,
  "pages": [
    "index",
    "---Structs---",
    "MyStruct",
    "OtherStruct",
    "---Enums---",
    "MyEnum",
    "---Traits---",
    "MyTrait",
    "---Functions---",
    "process",
    "---Modules---",
    "...submodule"
  ]
}
```

### 1.6 MDX Imports Header

Add necessary imports at the top of MDX files:

```mdx
---
title: MyStruct
description: A data structure for...
icon: Box
---

import { Callout } from "fumadocs-ui/components/callout";
import { Tabs, Tab } from "fumadocs-ui/components/tabs";
import { Cards, Card } from "fumadocs-ui/components/card";

## `MyStruct`

...
```

Only include imports for components actually used in that file.

---

## Section 2: Error Handling & Validation

### 2.1 Custom Error Types

```typescript
// src/errors.ts

export enum ErrorCode {
  // Validation errors
  INVALID_JSON = "INVALID_JSON",
  UNSUPPORTED_FORMAT_VERSION = "UNSUPPORTED_FORMAT_VERSION",
  MISSING_ROOT_MODULE = "MISSING_ROOT_MODULE",
  INVALID_ITEM_STRUCTURE = "INVALID_ITEM_STRUCTURE",

  // Generation warnings (non-fatal)
  UNKNOWN_ITEM_KIND = "UNKNOWN_ITEM_KIND",
  UNRESOLVED_TYPE = "UNRESOLVED_TYPE",
  MISSING_ITEM_REFERENCE = "MISSING_ITEM_REFERENCE",

  // IO errors
  OUTPUT_WRITE_FAILED = "OUTPUT_WRITE_FAILED",
  INPUT_READ_FAILED = "INPUT_READ_FAILED",
}

export class RustdocError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly hint?: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "RustdocError";
  }

  toString(): string {
    let result = `${this.code}: ${this.message}`;
    if (this.hint) {
      result += `\n\nHint: ${this.hint}`;
    }
    return result;
  }
}

export interface GenerationWarning {
  code: ErrorCode;
  message: string;
  itemId?: string;
  itemName?: string;
  suggestion?: string;
}
```

### 2.2 Schema Validation with Zod

```typescript
// src/validation.ts

import { z } from "zod";
import { RustdocError, ErrorCode } from "./errors.js";

// Supported rustdoc JSON format versions
// Format changes: https://github.com/rust-lang/rust/blob/master/src/rustdoc-json-types/CHANGELOG.md
const SUPPORTED_VERSIONS = {
  min: 35, // Rust 1.76
  max: 57, // Rust 1.85+
};

const IdSchema = z.string();

const SpanSchema = z
  .object({
    filename: z.string(),
    begin: z.tuple([z.number(), z.number()]),
    end: z.tuple([z.number(), z.number()]),
  })
  .optional();

const DeprecationSchema = z
  .object({
    since: z.string().optional(),
    note: z.string().optional(),
  })
  .optional();

// Partial schema for validation (full schema would be very large)
const ItemSchema = z.object({
  id: IdSchema,
  crate_id: z.number(),
  name: z.string().optional(),
  span: SpanSchema,
  visibility: z.union([
    z.literal("public"),
    z.literal("default"),
    z.literal("crate"),
    z.object({ restricted: z.object({ parent: IdSchema, path: z.string() }) }),
  ]),
  docs: z.string().optional(),
  links: z.record(z.string(), IdSchema),
  attrs: z.array(z.string()),
  deprecation: DeprecationSchema,
  inner: z.record(z.unknown()), // Loose validation for inner
});

const ItemSummarySchema = z.object({
  crate_id: z.number(),
  path: z.array(z.string()),
  kind: z.string(),
});

const ExternalCrateSchema = z.object({
  name: z.string(),
  html_root_url: z.string().optional(),
});

export const RustdocCrateSchema = z.object({
  root: IdSchema,
  crate_version: z.string().optional(),
  includes_private: z.boolean(),
  index: z.record(IdSchema, ItemSchema),
  paths: z.record(IdSchema, ItemSummarySchema),
  external_crates: z.record(z.string(), ExternalCrateSchema),
  format_version: z.number(),
});

export function validateRustdocJson(data: unknown): z.infer<typeof RustdocCrateSchema> {
  // First check if it's valid JSON object
  if (typeof data !== "object" || data === null) {
    throw new RustdocError(
      "Input is not a valid JSON object",
      ErrorCode.INVALID_JSON,
      "Ensure the file contains valid JSON. Check for syntax errors."
    );
  }

  // Check format version first for better error messages
  const obj = data as Record<string, unknown>;
  if (typeof obj.format_version === "number") {
    if (obj.format_version < SUPPORTED_VERSIONS.min) {
      throw new RustdocError(
        `Rustdoc JSON format version ${obj.format_version} is too old`,
        ErrorCode.UNSUPPORTED_FORMAT_VERSION,
        `Minimum supported version is ${SUPPORTED_VERSIONS.min}. Please regenerate with Rust 1.76 or later.`
      );
    }
    if (obj.format_version > SUPPORTED_VERSIONS.max) {
      throw new RustdocError(
        `Rustdoc JSON format version ${obj.format_version} is newer than supported`,
        ErrorCode.UNSUPPORTED_FORMAT_VERSION,
        `Maximum supported version is ${SUPPORTED_VERSIONS.max}. Please update rustdoc-to-fumadocs or report this issue.`,
        { format_version: obj.format_version }
      );
    }
  }

  // Full schema validation
  const result = RustdocCrateSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RustdocError(
      `Invalid rustdoc JSON: ${issue.message} at ${issue.path.join(".")}`,
      ErrorCode.INVALID_JSON,
      'Ensure you generated JSON with: RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps'
    );
  }

  // Check root module exists
  if (!result.data.index[result.data.root]) {
    throw new RustdocError(
      `Root module ID "${result.data.root}" not found in index`,
      ErrorCode.MISSING_ROOT_MODULE,
      "The rustdoc JSON appears corrupted. Try regenerating it."
    );
  }

  return result.data;
}
```

### 2.3 Generation Result with Warnings

```typescript
// In generator.ts

export interface GenerationResult {
  /** Generated files ready to write */
  files: GeneratedFile[];

  /** Non-fatal warnings encountered during generation */
  warnings: GenerationWarning[];

  /** Statistics about the generation */
  stats: GenerationStats;
}

export interface GenerationStats {
  /** Total items processed from the index */
  itemsProcessed: number;

  /** Items skipped (unknown kinds, filtered out) */
  itemsSkipped: number;

  /** Files generated (MDX + meta.json) */
  filesGenerated: number;

  /** Modules processed */
  modulesProcessed: number;

  /** Duration in milliseconds */
  durationMs: number;
}
```

### 2.4 CLI Error Display

```typescript
// In cli.ts

function displayError(error: unknown): void {
  if (error instanceof RustdocError) {
    console.error(`\n❌ ${error.code}: ${error.message}`);
    if (error.hint) {
      console.error(`\n💡 Hint: ${error.hint}`);
    }
    if (error.context) {
      console.error(`\nContext: ${JSON.stringify(error.context, null, 2)}`);
    }
  } else if (error instanceof Error) {
    console.error(`\n❌ Error: ${error.message}`);
  } else {
    console.error(`\n❌ Unknown error:`, error);
  }
}

function displayResult(result: GenerationResult, verbose: boolean): void {
  const { files, warnings, stats } = result;

  console.log(`\n✅ Generated ${stats.filesGenerated} files in ${stats.durationMs}ms`);
  console.log(`   Processed: ${stats.itemsProcessed} items, ${stats.modulesProcessed} modules`);

  if (stats.itemsSkipped > 0) {
    console.log(`   Skipped: ${stats.itemsSkipped} items`);
  }

  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, verbose ? undefined : 5)) {
      console.log(`   - ${w.message}`);
      if (w.suggestion && verbose) {
        console.log(`     → ${w.suggestion}`);
      }
    }
    if (!verbose && warnings.length > 5) {
      console.log(`   ... and ${warnings.length - 5} more (use --verbose to see all)`);
    }
  }
}
```

### 2.5 Dry-run Mode

```typescript
// CLI option
interface CliArgs {
  // ... existing
  dryRun: boolean;
}

// In main()
if (args.dryRun) {
  console.log(`\n📋 Dry run - would generate ${result.files.length} files:\n`);
  for (const file of result.files.slice(0, 20)) {
    console.log(`   ${file.path}`);
  }
  if (result.files.length > 20) {
    console.log(`   ... and ${result.files.length - 20} more`);
  }
  displayResult(result, args.verbose);
  return;
}
```

---

## Section 3: Renderer Module Extraction

### 3.1 RenderContext Class

```typescript
// src/renderer/index.ts

import type { RustdocCrate, Item, Type, Id } from "../types.js";
import type { GenerationWarning } from "../errors.js";

export interface RenderOptions {
  useTabs: boolean;
  useCards: boolean;
  codeBlocks: {
    showTitle: boolean;
    showLineNumbers: boolean;
  };
}

export class RenderContext {
  private warnings: GenerationWarning[] = [];

  constructor(
    private readonly crate: RustdocCrate,
    private readonly options: RenderOptions
  ) {}

  /** Get an item by ID, returning undefined if not found */
  getItem(id: Id): Item | undefined {
    return this.crate.index[id];
  }

  /** Get the path for an ID from the paths map */
  getPath(id: Id): string[] | undefined {
    return this.crate.paths[id]?.path;
  }

  /** Record a warning during rendering */
  warn(warning: Omit<GenerationWarning, "code"> & { code?: GenerationWarning["code"] }): void {
    this.warnings.push({
      code: warning.code ?? ErrorCode.UNKNOWN_ITEM_KIND,
      ...warning,
    });
  }

  /** Get all warnings accumulated during rendering */
  getWarnings(): GenerationWarning[] {
    return [...this.warnings];
  }

  /** Check if Tabs should be used */
  shouldUseTabs(): boolean {
    return this.options.useTabs;
  }

  /** Check if Cards should be used */
  shouldUseCards(): boolean {
    return this.options.useCards;
  }
}
```

### 3.2 Component Generators

```typescript
// src/renderer/components.ts

export function renderCallout(
  type: "info" | "warn" | "error",
  title: string,
  content: string
): string {
  return `<Callout type="${type}" title="${escapeAttribute(title)}">\n${content}\n</Callout>`;
}

export function renderTabs(items: string[], contents: Map<string, string>): string {
  const tabs = items
    .map(
      (item) =>
        `  <Tab value="${escapeAttribute(item)}">\n${indent(contents.get(item) ?? "", 4)}\n  </Tab>`
    )
    .join("\n");

  return `<Tabs items={${JSON.stringify(items)}}>\n${tabs}\n</Tabs>`;
}

export function renderCards(
  cards: Array<{ title: string; href: string; description?: string; icon?: string }>
): string {
  const cardElements = cards
    .map((card) => {
      const iconAttr = card.icon ? ` icon={<${card.icon} />}` : "";
      const desc = card.description ? `\n  ${card.description}` : "";
      return `<Card${iconAttr} title="${escapeAttribute(card.title)}" href="${card.href}">${desc}\n</Card>`;
    })
    .join("\n");

  return `<Cards>\n${cardElements}\n</Cards>`;
}

export function renderCodeBlock(
  code: string,
  language: string,
  options?: { title?: string; showLineNumbers?: boolean }
): string {
  const attrs: string[] = [];
  if (options?.title) attrs.push(`title="${options.title}"`);
  if (options?.showLineNumbers) attrs.push("showLineNumbers");

  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
  return `\`\`\`${language}${attrStr}\n${code}\n\`\`\``;
}

export function collectImports(content: string): string[] {
  const imports: string[] = [];

  if (content.includes("<Callout")) {
    imports.push("import { Callout } from 'fumadocs-ui/components/callout';");
  }
  if (content.includes("<Tabs") || content.includes("<Tab")) {
    imports.push("import { Tabs, Tab } from 'fumadocs-ui/components/tabs';");
  }
  if (content.includes("<Cards") || content.includes("<Card")) {
    imports.push("import { Cards, Card } from 'fumadocs-ui/components/card';");
  }

  return imports;
}

// Utilities
function escapeAttribute(str: string): string {
  return str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function indent(str: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return str
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}
```

### 3.3 Type Rendering (Extracted)

```typescript
// src/renderer/types.ts

import type { Type, GenericArg, GenericBound } from "../types.js";
import type { RenderContext } from "./index.js";

/**
 * Format a rustdoc Type as a human-readable Rust type string.
 *
 * Handles all type variants:
 * - resolved_path: Named types (structs, enums, traits)
 * - generic: Type parameters (T, U)
 * - primitive: Built-in types (i32, str, bool)
 * - tuple: Tuple types, including 1-tuple with trailing comma
 * - slice/array: [T] and [T; N]
 * - borrowed_ref: &T, &mut T, &'a T
 * - raw_pointer: *const T, *mut T
 * - impl_trait: impl Trait
 * - dyn_trait: dyn Trait + 'a
 * - function_pointer: fn(A, B) -> C
 * - qualified_path: <T as Trait>::Item
 * - pat: Pattern types (unstable)
 * - infer: _ placeholder
 */
export function formatType(type: Type, ctx?: RenderContext): string {
  // ... extracted from generator.ts formatTypeSimple
  // Add ctx parameter for warning collection on unresolved types
}

export function formatGenericArg(arg: GenericArg, ctx?: RenderContext): string {
  // ... extracted from generator.ts
}

export function formatGenericBound(bound: GenericBound, ctx?: RenderContext): string {
  // ... extracted from generator.ts
}
```

---

## Section 4: Documentation & Testing

### 4.1 README.md Structure

````markdown
# rustdoc-to-fumadocs

Convert Rust API documentation (rustdoc JSON) to beautiful [FumaDocs](https://fumadocs.dev) sites.

[![npm version](https://badge.fury.io/js/rustdoc-to-fumadocs.svg)](https://www.npmjs.com/package/rustdoc-to-fumadocs)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Features

- 🦀 **Full rustdoc JSON support** - Format versions 35-57 (Rust 1.76+)
- 📚 **FumaDocs v14+ compatible** - Modern MDX with UI components
- 🎨 **Rich components** - Tabs, Cards, Callouts for better UX
- 🔍 **Smart cross-references** - Automatic linking between types
- ⚡ **Zero runtime deps** - Only build-time processing
- 🛡️ **Type-safe** - Full TypeScript support with validation

## Quick Start

### 1. Generate rustdoc JSON

```bash
# Using nightly Rust
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps

# Or with stable Rust (using bootstrap)
RUSTC_BOOTSTRAP=1 RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo doc --no-deps
```
````

### 2. Convert to FumaDocs MDX

```bash
npx rustdoc-to-fumadocs --input target/doc/my_crate.json --output content/docs/api
```

### 3. View your docs

The generated MDX files are ready to use with FumaDocs. See [FumaDocs Getting Started](https://fumadocs.dev/docs/ui).

## CLI Usage

```bash
rustdoc-to-fumadocs [OPTIONS]

Options:
  -i, --input <path>      Path to rustdoc JSON file
  -c, --crate <name>      Crate name (looks in target/doc/<name>.json)
  -o, --output <dir>      Output directory (default: content/docs/api)
  -b, --base-url <url>    Base URL for docs (default: /docs/api)
  -g, --group-by <mode>   Group by: module, kind, or flat (default: module)
  --no-index              Don't generate module index pages
  --no-tabs               Don't use Tabs component for implementations
  --no-cards              Don't use Cards component for cross-references
  --dry-run               Preview files without writing
  -v, --verbose           Show detailed output
  -h, --help              Show help
```

## Programmatic API

```typescript
import { RustdocGenerator } from "rustdoc-to-fumadocs";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const json = JSON.parse(readFileSync("target/doc/my_crate.json", "utf-8"));

const generator = new RustdocGenerator(json, {
  output: "content/docs/api",
  baseUrl: "/docs/api",
  groupBy: "module",
  useTabs: true,
  useCards: true,
});

const result = generator.generate();

for (const file of result.files) {
  const fullPath = join("content/docs/api", file.path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, file.content);
}

console.log(`Generated ${result.stats.filesGenerated} files`);
if (result.warnings.length > 0) {
  console.warn(`${result.warnings.length} warnings`);
}
```

## Configuration Options

| Option          | Type                           | Default     | Description                    |
| --------------- | ------------------------------ | ----------- | ------------------------------ |
| `output`        | `string`                       | required    | Output directory path          |
| `baseUrl`       | `string`                       | required    | Base URL for generated docs    |
| `generateIndex` | `boolean`                      | `true`      | Generate index.mdx for modules |
| `groupBy`       | `'module' \| 'kind' \| 'flat'` | `'module'`  | How to organize output         |
| `useTabs`       | `boolean`                      | `true`      | Use Tabs for implementations   |
| `useCards`      | `boolean`                      | `true`      | Use Cards for cross-references |
| `frontmatter`   | `function`                     | default     | Custom frontmatter generator   |
| `filter`        | `function`                     | public only | Item filter function           |

## Output Structure

```
content/docs/api/
├── meta.json              # Root navigation
├── index.mdx              # Crate overview
├── structs/
│   ├── meta.json
│   ├── MyStruct.mdx
│   └── OtherStruct.mdx
├── enums/
│   └── MyEnum.mdx
├── traits/
│   └── MyTrait.mdx
└── submodule/
    ├── meta.json
    ├── index.mdx
    └── ...
```

## Troubleshooting

### "Unsupported format version"

Update your Rust toolchain or rustdoc-to-fumadocs:

```bash
rustup update nightly
npm update rustdoc-to-fumadocs
```

### "Root module not found"

Ensure you're pointing to the correct JSON file. The file should be named `<crate_name>.json` in `target/doc/`.

### External types show as "undefined"

External crate types may not be fully resolved. This is expected - the JSON only contains local crate information.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

Apache-2.0 - See [LICENSE](LICENSE)

```

### 4.2 Test Structure

```

tests/
├── fixtures/
│ ├── minimal.json # Smallest valid crate
│ ├── all-types.json # All Type variants
│ ├── generics.json # Complex generics
│ ├── implementations.json # Trait impls, blanket impls
│ ├── deprecated.json # Deprecated items
│ └── invalid/
│ ├── bad-syntax.json
│ ├── old-version.json
│ └── missing-root.json
├── unit/
│ ├── types.test.ts
│ ├── validation.test.ts
│ ├── signatures.test.ts
│ ├── components.test.ts
│ └── errors.test.ts
├── integration/
│ ├── generator.test.ts
│ └── cli.test.ts
└── snapshots/
└── **snapshots**/

````

### 4.3 Example Test Cases

```typescript
// tests/unit/validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateRustdocJson } from '../../src/validation';
import { RustdocError, ErrorCode } from '../../src/errors';

describe('validateRustdocJson', () => {
  it('accepts valid rustdoc JSON', () => {
    const valid = {
      root: '0:0',
      crate_version: '1.0.0',
      includes_private: false,
      index: {
        '0:0': {
          id: '0:0',
          crate_id: 0,
          name: 'test',
          visibility: 'public',
          docs: 'Test crate',
          links: {},
          attrs: [],
          inner: { module: { is_crate: true, items: [], is_stripped: false } },
        },
      },
      paths: {},
      external_crates: {},
      format_version: 57,
    };

    expect(() => validateRustdocJson(valid)).not.toThrow();
  });

  it('rejects old format versions with helpful message', () => {
    const old = { format_version: 30, root: '0:0', index: {}, paths: {}, external_crates: {}, includes_private: false };

    expect(() => validateRustdocJson(old)).toThrow(RustdocError);
    try {
      validateRustdocJson(old);
    } catch (e) {
      expect(e).toBeInstanceOf(RustdocError);
      expect((e as RustdocError).code).toBe(ErrorCode.UNSUPPORTED_FORMAT_VERSION);
      expect((e as RustdocError).hint).toContain('Rust 1.76');
    }
  });

  it('rejects missing root module', () => {
    const noRoot = {
      root: 'missing',
      includes_private: false,
      index: {},
      paths: {},
      external_crates: {},
      format_version: 57,
    };

    expect(() => validateRustdocJson(noRoot)).toThrow(RustdocError);
  });
});
````

````typescript
// tests/unit/components.test.ts
import { describe, it, expect } from "vitest";
import { renderCallout, renderTabs, renderCodeBlock } from "../../src/renderer/components";

describe("renderCallout", () => {
  it("renders deprecation warning", () => {
    const result = renderCallout("warn", "Deprecated since 1.2.0", "Use `new_function` instead.");
    expect(result).toBe(
      '<Callout type="warn" title="Deprecated since 1.2.0">\nUse `new_function` instead.\n</Callout>'
    );
  });

  it("escapes special characters in title", () => {
    const result = renderCallout("info", "Test <script>", "Content");
    expect(result).toContain("&lt;script&gt;");
  });
});

describe("renderCodeBlock", () => {
  it("renders with title", () => {
    const result = renderCodeBlock("fn main() {}", "rust", { title: "Example" });
    expect(result).toBe('```rust title="Example"\nfn main() {}\n```');
  });

  it("renders with line numbers", () => {
    const result = renderCodeBlock("let x = 1;", "rust", { showLineNumbers: true });
    expect(result).toContain("showLineNumbers");
  });
});
````

### 4.4 Package.json Updates

```json
{
  "name": "rustdoc-to-fumadocs",
  "version": "0.3.0",
  "description": "Convert rustdoc JSON to Fumadocs-compatible MDX files",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "rustdoc-to-fumadocs": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "test": "vitest",
    "test:watch": "vitest --watch",
    "test:coverage": "vitest --coverage",
    "lint": "eslint src tests",
    "lint:fix": "eslint src tests --fix",
    "typecheck": "tsc --noEmit",
    "docs": "typedoc --out docs/api src/index.ts",
    "prepublishOnly": "npm run build && npm run test"
  },
  "dependencies": {
    "yaml": "^2.3.4",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "eslint": "^9.0.0",
    "tsx": "^4.7.0",
    "typedoc": "^0.26.0",
    "typescript": "^5.3.3",
    "vitest": "^2.0.0"
  },
  "engines": {
    "node": ">=18"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "keywords": ["rustdoc", "fumadocs", "mdx", "documentation", "rust", "api-docs"]
}
```

---

## Implementation Plan

### Phase 1: Foundation (Tasks 1-3)

1. Add Zod validation and custom error types
2. Extract renderer module from generator.ts
3. Add basic test infrastructure

### Phase 2: FumaDocs Components (Tasks 4-6)

4. Implement enhanced code blocks with titles
5. Add Tabs component for implementations
6. Add Cards component for cross-references
7. Implement Callout variants (safety, panics, features)

### Phase 3: CLI & UX (Tasks 8-9)

8. Add --dry-run mode
9. Improve error display with hints
10. Add progress indicators for large crates

### Phase 4: Documentation & Polish (Tasks 10-12)

11. Write comprehensive README
12. Add JSDoc to all public APIs
13. Create test fixtures and snapshot tests

---

## Multi-Model Consensus Review

**Reviewed by**: GPT-5.2-pro (7/10), minimax-m2.1 (7/10)

### Consensus Agreements

1. **Architecture**: Extraction is sound and appropriate for 1100-line file
2. **RenderContext**: Pattern provides clean state management
3. **FumaDocs Components**: Patterns are correct for v14+
4. **Structured Errors**: Improve CI usability over console.warn

### Critical Issues Identified

#### 1. MDX/JSX Escaping (HIGH PRIORITY)

The proposed `escapeAttribute()` using HTML entities is **unsound** for JSX.

**Wrong:**

```typescript
`<Callout type="${type}" title="${escapeAttribute(title)}">`;
```

**Correct:**

```typescript
`<Callout type="${type}" title={${JSON.stringify(title)}}>`;
```

Use `JSON.stringify` for all JSX props to ensure proper escaping.

#### 2. Import Detection (MEDIUM PRIORITY)

String-based `collectImports()` can false-positive on documentation containing `<Callout`.

**Solution**: Track component usage during rendering via `ctx.use('Callout')` instead of post-hoc string scanning.

#### 3. Validation Approach (MEDIUM PRIORITY)

- Schema too strict on unused fields (`links`, `attrs`)
- Schema too loose on `inner` field (`z.record(z.unknown())`)
- Performance concern for large crates

**Solution**:

- Fast path: validate top-level + format_version + root presence
- Optional `--strict` flag for full deep validation
- Validate `inner` lazily when item is actually rendered

#### 4. Missing Rustdoc Coverage (HIGH PRIORITY)

| Missing Feature         | Location                                     | Impact                           |
| ----------------------- | -------------------------------------------- | -------------------------------- |
| Where clauses           | `renderTypeAlias`, `formatFunctionSignature` | Incomplete signatures            |
| Function ABI            | `formatFunctionSignature`                    | extern "C" not shown             |
| Const generic defaults  | `formatGenericParam`                         | Missing defaults                 |
| Trait default methods   | `renderTrait`                                | Only shows required              |
| Enum variant fields     | `renderEnum`                                 | Struct/tuple variants incomplete |
| Auto/unsafe traits      | `formatTraitSignature`                       | Missing markers                  |
| Reexports (`use` items) | `processModule`                              | Public APIs missing              |
| `trait.implementations` | `getImplementations`                         | Trait impls missed               |

#### 5. Breaking Change (LOW PRIORITY)

`GenerationResult` conflicts with current `generate(): GeneratedFile[]` API.

**Solution**: Keep `generate()` returning `files` for backward compatibility, add new `generateWithStats()` method.

#### 6. Name Collisions (MEDIUM PRIORITY)

`${childItem.name}.mdx` will collide in `groupBy: 'flat'` mode when items share names.

**Solution**: Add disambiguation scheme using module path prefix when collision detected.

### Updated Implementation Plan

Based on consensus, add these tasks before Phase 2:

**Task 1.5**: Fix JSX escaping to use JSON.stringify
**Task 1.6**: Add where clause and ABI rendering to signatures
**Task 1.7**: Implement component tracking via ctx.use() instead of string scan
**Task 1.8**: Add enum variant field rendering

---

## Success Criteria

1. **Robustness**: All rustdoc JSON format versions 35-57 handled without crashes
2. **Components**: Generated MDX uses Tabs, Cards, and Callout appropriately
3. **Errors**: Invalid input produces actionable error messages
4. **Tests**: >80% code coverage, all edge cases covered
5. **Docs**: README covers all CLI options and API usage
6. **JSX Safety**: All props use JSON.stringify escaping (consensus requirement)
7. **Signatures**: Where clauses and ABIs rendered correctly (consensus requirement)
