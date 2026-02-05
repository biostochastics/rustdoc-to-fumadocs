# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript tool that converts Rust's `rustdoc` JSON output to FumaDocs v14+ compatible MDX files. Part of the resume-factory monorepo under `tools/`.

## Commands

```bash
# Install dependencies
npm install

# Run the generator (development)
npm run dev -- --input <path-to-rustdoc-json> --output <output-dir>
npm run generate -- --crate <crate-name> --output <output-dir>

# Build for production
npm run build

# Run tests
npm run test           # Watch mode
npm run test:run       # Single run
npm run test:coverage  # With coverage

# Generate rustdoc JSON (prerequisite)
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps
# Or with stable Rust:
RUSTC_BOOTSTRAP=1 RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo doc --no-deps
```

## Architecture

```
src/
├── index.ts        # Library entry point, re-exports generator and types
├── cli.ts          # CLI with argument parsing, dry-run, JSON output
├── types.ts        # TypeScript types mirroring rustdoc_json_types (format v35-57)
├── errors.ts       # Custom error types with codes and hints
├── validation.ts   # Zod schemas for rustdoc JSON validation
├── generator.ts    # RustdocGenerator class - core conversion logic
└── renderer/       # Modular rendering utilities
    ├── index.ts    # RenderContext and exports
    ├── types.ts    # Type formatting (formatType, formatGenericArg)
    ├── signatures.ts # Signature formatting (function, struct, enum, trait)
    └── components.ts # FumaDocs component generators (Callout, Tabs, Cards)

tests/
├── fixtures/       # Test data (minimal.json, etc.)
├── unit/           # Unit tests for each module
└── integration/    # Integration tests for generator
```

### Key Components

**`RustdocGenerator`** (generator.ts) - The main class that:

- Recursively processes modules from the rustdoc JSON `index`
- Groups items by kind (struct, union, enum, trait, function, etc.)
- Generates MDX with YAML frontmatter (using `yaml` package for safe escaping)
- Creates `meta.json` with FumaDocs v14+ features (icons, separators, defaultOpen)
- Renders deprecations, safety warnings, panics, errors, and feature gates as Callouts
- Uses Tabs component to organize inherent methods vs trait implementations
- Adds "See Also" section with Cards for cross-references
- Renders Rust signatures including full generic arguments, impl traits, dyn traits
- Filters out blanket/synthetic implementations to reduce noise

**Validation** (validation.ts):

- Zod schemas validate rustdoc JSON structure
- Format version checking (35-57 supported, newer versions warn)
- Helpful error messages with hints and context

**Renderer** (renderer/):

- `RenderContext`: Tracks component usage, generates imports
- `formatType()`: Handles all rustdoc type variants
- `formatFunctionSignature()`, etc.: Item signature rendering
- `renderCallout()`, `renderTabs()`, `renderCards()`: FumaDocs components

**CLI** (cli.ts):

- Argument validation with helpful error messages
- `--dry-run`: Preview without writing files
- `--json`: Structured output for CI/scripts
- Progress indicators for large crates
- Auto-detection of crate name from `Cargo.toml`

### FumaDocs v14+ Features

**Frontmatter:**

```yaml
---
title: "MyStruct"
description: "A data structure for..."
icon: "Box"
---
```

**meta.json:**

```json
{
  "title": "module",
  "icon": "Folder",
  "defaultOpen": true,
  "pages": [
    "index",
    "---Structs---",
    "MyStruct",
    "---Functions---",
    "my_function",
    "---Modules---",
    "...submodule"
  ]
}
```

**Icon Mapping:**
| Kind | Icon |
|------|------|
| struct | Box |
| enum | List |
| trait | Puzzle |
| function | Code |
| type_alias | Type |
| constant | Hash |
| macro | Wand2 |
| module | Folder |

### Generation Modes

- `--group-by module` (default): One MDX file per item, organized by module hierarchy
- `--group-by kind`: Items grouped into files like `structs.mdx`, `functions.mdx`
- `--group-by flat`: Flat structure without module hierarchy

### CLI Options

- `--no-tabs`: Disable Tabs component for implementations
- `--no-cards`: Disable Cards component for cross-references
- `--dry-run`: Show what would be generated without writing
- `--json`: Output results as JSON for CI integration

## Type Rendering

The `formatType()` method handles all rustdoc type variants:

- `resolved_path`: Named types with generic args and associated type constraints
- `borrowed_ref`: References with lifetimes (e.g., `&'a mut T`)
- `impl_trait` / `dyn_trait`: Trait bounds with lifetimes
- `qualified_path`: Associated types (e.g., `<T as Trait>::Item`)
- `tuple`: Proper 1-tuple formatting with trailing comma `(T,)`
- `slice` / `array`: Slice and array types
- `raw_pointer`: Raw pointers (e.g., `*const T`)
- `function_pointer`: Function pointers (e.g., `fn(T) -> U`)
- Parenthesized generics for Fn traits: `Fn(A, B) -> C`

## Callout Variants

The generator creates multiple callout types:

- **Deprecation**: `<Callout type="warn">` with version and note
- **Safety**: `<Callout type="error">` for unsafe items, extracts `# Safety` section
- **Panics**: `<Callout type="error">` extracts `# Panics` section
- **Errors**: `<Callout type="warn">` extracts `# Errors` section
- **Feature Gate**: `<Callout type="info">` for `#[cfg(feature = "...")]`

## Implementation Filtering

The `getImplementations()` method filters out:

- **Blanket impls**: Generic implementations like `impl<T> From<T> for T`
- **Synthetic impls**: Auto-generated implementations
- **External trait impls with no local methods**: Reduces noise
- **Trait impls without documentation**: Only includes documented impl blocks

## Cross-Reference Detection

The `extractCrossReferences()` method scans:

- Function parameters and return types
- Struct and union field types
- Enum variant field types
- Trait supertraits (bounds)

Only local crate types with `visibility: "public"` are included.

## Rustdoc JSON Format

Supports format versions 35-57 (Rust 1.76+). The format is unstable - check `format_version` field if issues occur.

Key structures:

- Items stored in `crate.index` keyed by ID strings
- Paths stored in `crate.paths` for cross-references
- Implementations referenced via `impls: Id[]` on structs/enums/unions
- Constants have nested `const` field: `constant.type`, `constant.const.expr`

### Format Version 56+ Changes (Rust 1.85+)

Format v56 introduced several breaking changes that this tool handles:

| Change            | Old Format (v35-55)         | New Format (v56+)           |
| ----------------- | --------------------------- | --------------------------- |
| Item IDs          | String `"0:123:456"`        | Numeric `123`               |
| Attributes        | String `"#[derive(Debug)]"` | Object `{ "other": "..." }` |
| Unit struct kind  | `{ "unit": true }`          | `"unit"` string             |
| Unit variant kind | `{ "plain": true }`         | `"plain"` string            |
| Lifetime names    | Already include `'`         | `"'de"`, `"'static"`        |

The tool includes helper functions (`isUnitStruct`, `isPlainVariant`, etc.) to handle both formats transparently.

### External Crate Testing

Tested against popular public crates (format v56):

- **syn** (148 files) - Rust syntax parsing library
- **tokio** (76 files) - Async runtime
- **serde_core** (57 files) - Serialization framework
- **anyhow** (9 files) - Error handling

## Error Handling

- `RustdocError` class with error codes, hints, and context
- `validateRustdocJson()` provides helpful validation errors
- `getItemKind()` returns `"unknown"` for forward compatibility
- Unknown items are skipped with a warning instead of crashing

## Security

The tool includes several security measures:

- **Input Size Limits**: `MAX_INPUT_SIZE_BYTES` (100MB) prevents memory exhaustion
- **Path Sanitization**: `sanitizePath()` in generator.ts replaces:
  - `..` → `_` (directory traversal)
  - `/` and `\` → `_` (path separators)
  - Leading dots → `_` (hidden files)
  - Invalid filesystem characters
- **Output Path Validation**: `validateOutputPath()` in cli.ts ensures resolved paths stay within output directory
- **Recursion Limits**: `MAX_RECURSION_DEPTH` (100) prevents stack overflow
- **Warning Limits**: `MAX_WARNINGS` (50) prevents console flooding

## Testing

### Test Structure

```
tests/
├── fixtures/           # Sample rustdoc JSON files for testing
│   └── minimal.json    # Minimal valid rustdoc JSON (format v57)
├── unit/               # Unit tests by module
│   ├── types.test.ts           # Type guard and utility tests
│   ├── validation.test.ts      # Zod schema validation tests
│   ├── components.test.ts      # FumaDocs component rendering
│   ├── signatures.test.ts      # Rust signature formatting
│   ├── renderer-types.test.ts  # Type formatting (formatType, etc.)
│   ├── render-context.test.ts  # RenderContext component tracking
│   └── generator.test.ts       # Generator unit tests
└── integration/        # End-to-end generator tests
    └── generator.test.ts       # Full pipeline tests
```

### Running Tests

```bash
npm test              # Watch mode (re-runs on file changes)
npm run test:run      # Single run (222 tests)
npm run test:coverage # Coverage report with HTML output
```

The test framework is **Vitest** with the following configuration:

- Environment: Node.js
- Globals enabled (`describe`, `it`, `expect` available without imports)
- Coverage provider: V8
- Coverage excludes: `src/cli.ts` (CLI tested manually)

### Writing New Tests

**Unit test pattern:**

```typescript
import { describe, it, expect } from "vitest";
import { myFunction } from "../../src/mymodule.js";

describe("myFunction", () => {
  it("handles normal input", () => {
    const result = myFunction("input");
    expect(result).toBe("expected");
  });

  it("throws RustdocError for invalid input", () => {
    expect(() => myFunction(null)).toThrow(RustdocError);

    try {
      myFunction(null);
    } catch (err) {
      expect(isRustdocError(err)).toBe(true);
      if (isRustdocError(err)) {
        expect(err.code).toBe(ErrorCode.INVALID_JSON);
        expect(err.hint).toBeDefined();
      }
    }
  });
});
```

**Using fixtures:**

```typescript
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "..", "fixtures");

// Load fixture
const content = readFileSync(join(fixturesDir, "minimal.json"), "utf-8");
const data = JSON.parse(content);
```

**Guidelines:**

- Unit tests go in `tests/unit/<module>.test.ts`
- Integration tests go in `tests/integration/`
- Use fixtures from `tests/fixtures/` for rustdoc JSON samples
- Follow existing test file patterns (describe/it structure)
- Test both success and error paths
- For error tests, verify `RustdocError` code and hint content

### Coverage Targets

| Module                   | Current  | Target   | Priority |
| ------------------------ | -------- | -------- | -------- |
| `validation.ts`          | 100%     | 100%     | Critical |
| `renderer/components.ts` | 100%     | 100%     | Critical |
| `renderer/types.ts`      | 99%      | 100%     | Critical |
| `renderer/signatures.ts` | ~80%     | 90%+     | High     |
| `generator.ts`           | ~50%     | 80%+     | High     |
| `errors.ts`              | ~70%     | 90%+     | Medium   |
| **Overall**              | **~61%** | **80%+** | -        |

**Priority areas for coverage improvement:**

1. `generator.ts` - Core logic needs more edge case coverage
2. Error handling paths in all modules
3. Edge cases in type formatting (complex generics, lifetimes)

## Code Quality (Multi-Model Consensus Review - Feb 2026)

The codebase was reviewed by 4 AI models (kimi-k2, glm-4.7, minimax-m2.1, gemini-3) with unanimous consensus:

| Area                 | Rating  | Notes                                                     |
| -------------------- | ------- | --------------------------------------------------------- |
| Architecture         | 8/10    | Clean pipeline: CLI → Validation → Generator → Renderer   |
| Error Handling       | 9-10/10 | Exemplary RustdocError with codes, hints, context         |
| Type Safety          | 8-9/10  | Excellent discriminated unions, forward-compatible design |
| FumaDocs Integration | 8-9/10  | Proper v14+ features, component tracking                  |
| CLI UX               | 7-9/10  | Feature-rich with dry-run, JSON output, auto-detection    |
| Testing              | 6/10    | 222 tests, ~61% coverage (target: 80%+)                   |
| Security             | 7-9/10  | Path sanitization, size limits, output validation         |

**Key strengths:**

- Loose Zod validation + strict TypeScript types = forward compatibility
- Comprehensive error system with actionable hints
- Component tracking via `RenderContext`

**Known improvements needed:**

- Split generator.ts (~1340 lines) into smaller modules
- Increase test coverage to 80%+
- Consider CLI framework (commander/yargs) for maintainability

## Known Limitations

- External crate types may render as `undefined` (types not in local index)
- Re-exports (`use` items) are not rendered as separate pages
- Macro documentation depends on rustdoc output completeness
- Maximum 6 cross-reference cards per item
- Some complex async return types with lifetime parameters may show simplified representations
