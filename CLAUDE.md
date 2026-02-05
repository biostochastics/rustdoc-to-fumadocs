# rustdoc-to-fumadocs

**TypeScript tool that converts Rust's `rustdoc` JSON output to FumaDocs v14+ compatible MDX files.**

Part of the resume-factory monorepo under `tools/`.

## Quick Reference

| Category        | Command/Value                                                                          |
| --------------- | -------------------------------------------------------------------------------------- |
| **Install**     | `npm install && npm run build`                                                         |
| **Dev Run**     | `npm run dev -- --input <json> --output <dir>`                                         |
| **Test**        | `npm run test:run` (222 tests)                                                         |
| **Coverage**    | `npm run test:coverage` (~61% coverage)                                                |
| **Lint**        | `npm run lint && npm run format:check`                                                 |
| **Rustdoc Gen** | `RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps` |

## Commands

```bash
# Install dependencies
npm install

# Development - run CLI directly
npm run dev -- --input <path-to-rustdoc-json> --output <output-dir>
npm run generate -- --crate <crate-name> --output <output-dir>

# Production build
npm run build

# Testing
npm test              # Watch mode (re-runs on file changes)
npm run test:run      # Single run (222 tests)
npm run test:coverage # Coverage report with HTML output

# Code quality
npm run lint          # ESLint with fixes
npm run format        # Prettier formatting
npm run format:check  # Check formatting only
npm run typecheck     # TypeScript type checking

# Release (requires changesets)
npm run changeset     # Create changeset
npm run version       # Bump versions
npm run release       # Build + publish
```

## Architecture

```

src/
├── index.ts          # Library entry point, re-exports generator and types
├── cli.ts            # CLI with argument parsing, dry-run, JSON output
├── types.ts          # TypeScript types mirroring rustdoc_json_types (format v35-57)
├── errors.ts         # Custom error types with codes and hints
├── validation.ts     # Zod schemas for rustdoc JSON validation
├── generator.ts      # RustdocGenerator class - core conversion logic (~1770 lines)
└── renderer/         # Modular rendering utilities
    ├── index.ts      # RenderContext and exports
    ├── types.ts      # Type formatting (formatType, formatGenericArg)
    ├── signatures.ts # Signature formatting (function, struct, enum, trait)
    └── components.ts # FumaDocs component generators (Callout, Tabs, Cards)

tests/
├── fixtures/         # Test data (minimal.json, etc.)
├── unit/             # Unit tests for each module
└── integration/      # Integration tests for generator
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
- `validateRustdocJson()` returns `{ crate: Crate, warnings: string[] }`

**Renderer** (renderer/):

- `RenderContext`: Tracks component usage, generates imports for MDX
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
|-------------|--------|
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

```bash
# Core options
-i, --input <path>      Path to rustdoc JSON file
-c, --crate <name>      Crate name (looks in target/doc/<name>.json)
-o, --output <dir>      Output directory (default: content/docs/api)
-b, --base-url <url>    Base URL for generated docs (default: /docs/api)
-g, --group-by <mode>   Group items by: module, kind, or flat (default: module)

# Output customization
--no-index              Don't generate index pages for modules
--no-tabs               Don't use Tabs component for implementations
--no-cards              Don't use Cards component for cross-references

# Output modes
-n, --dry-run           Show what would be generated without writing files
--json                  Output results as JSON (for scripting/CI)
-v, --verbose           Show verbose output
-h, --help              Show help message
```

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

| Type         | Component                | Trigger                   | Content                         |
| ------------ | ------------------------ | ------------------------- | ------------------------------- |
| Deprecation  | `<Callout type="warn">`  | `#[deprecated]` attribute | Version and note from attribute |
| Safety       | `<Callout type="error">` | `unsafe` keyword          | Extracted `# Safety` section    |
| Panics       | `<Callout type="error">` | `# Panics` in docs        | Full `# Panics` section content |
| Errors       | `<Callout type="warn">`  | `# Errors` in docs        | Full `# Errors` section content |
| Feature Gate | `<Callout type="info">`  | `#[cfg(feature = "...")]` | Feature name and status         |

## Implementation Filtering

The `getImplementations()` method filters items using multiple strategies:

**Excluded:**

- **Blanket impls**: Generic implementations matching patterns like `impl<T> From<T> for T`
- **Synthetic impls**: Auto-generated implementations (compiler-created)
- **External trait impls**: Trait implementations from other crates without local methods
- **Undocumented impls**: Trait blocks without any documented methods

**Included:**

- Inherent implementations (`impl StructName`)
- Trait implementations with at least one documented method
- Local trait implementations with documentation

## Cross-Reference Detection

The `extractCrossReferences()` method scans:

1. Function parameters and return types
2. Struct and union field types
3. Enum variant field types
4. Trait supertraits (bounds)

**Constraints:**

- Only local crate types (not external crates)
- Only public visibility items (`visibility: "public"`)
- Maximum 6 cross-reference cards per item
- External crate types may show as `undefined`

## Rustdoc JSON Format

Supports format versions 35-57 (Rust 1.76-1.85+). The format is unstable - check `format_version` field if issues occur.

### Key Structures

| Field          | Description                                  |
| -------------- | -------------------------------------------- |
| `crate.index`  | Items keyed by ID strings/numbers            |
| `crate.paths`  | Path information for cross-references        |
| `crate.impls`  | All implementation blocks                    |
| `item.impls[]` | References to impls for structs/enums/unions |

### Constants and Special Cases

Constants have nested structure:

```typescript
{
  type: Type,      // TypeScript type representation
  const: {
    expr: string,  // Constant expression as string
  }
}
```

### Format Version 56+ Changes (Rust 1.85+)

Format v56 introduced breaking changes that this tool handles transparently:

| Feature      | Old Format (v35-55)         | New Format (v56+)                              |
| ------------ | --------------------------- | ---------------------------------------------- |
| Item IDs     | String `"0:123:456"`        | Numeric `123`                                  |
| Attributes   | String `"#[derive(Debug)]"` | Object `{ "kind": "derive", "path": "Debug" }` |
| Unit struct  | `{ "unit": true }`          | `"unit"` string                                |
| Unit variant | `{ "plain": true }`         | `"plain"` string                               |
| Lifetimes    | `'` included                | `"'de"`, `"'static"`                           |

**Helper functions for compatibility:**

- `isUnitStruct(kind)` - Detect unit structs (types.ts)
- `isPlainVariant(kind)` - Detect plain enum variants (generator.ts)
- `is_synthetic` field - Check `implDef.is_synthetic` for compiler-generated impls

### External Crate Testing

Verified against popular crates (format v56):

| Crate      | Files | Purpose             |
| ---------- | ----- | ------------------- |
| syn        | 148   | Rust syntax parsing |
| tokio      | 76    | Async runtime       |
| serde_core | 57    | Serialization       |
| anyhow     | 9     | Error handling      |

## Error Handling

- `RustdocError` class with error codes, hints, and context
- `validateRustdocJson()` provides helpful validation errors
- `getItemKind()` returns `"unknown"` for forward compatibility
- Unknown items are skipped with a warning instead of crashing

### Error Codes

| Code                       | Description                  | Hint                                 |
| -------------------------- | ---------------------------- | ------------------------------------ |
| INVALID_JSON               | JSON parse error             | Check file is valid JSON             |
| UNSUPPORTED_FORMAT_VERSION | Format version outside 35-57 | Update Rust toolchain or tool        |
| MISSING_ROOT_MODULE        | Root module ID not in index  | Verify rustdoc output completeness   |
| INVALID_ITEM_STRUCTURE     | Item missing required fields | Check rustdoc JSON structure         |
| UNKNOWN_ITEM_KIND          | Unrecognized item kind       | Update tool for new rustdoc features |
| UNRESOLVED_TYPE            | Type reference not found     | External crate or missing item       |
| MISSING_ITEM_REFERENCE     | Referenced ID not in index   | Check for corrupted rustdoc output   |
| INPUT_READ_FAILED          | Cannot read input file       | Check file exists and permissions    |
| OUTPUT_WRITE_FAILED        | Cannot write output file     | Check output directory permissions   |

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

### Security Best Practices

When using this tool:

1. **Validate input sources** - Only process rustdoc JSON from trusted crates
2. **Use dry-run first** - Preview output before writing files: `--dry-run`
3. **Review JSON output** - Use `--json` to inspect generated paths programmatically
4. **Sandbox untrusted input** - Run in container/VM when processing external crates
5. **Monitor resource usage** - Watch for unusual memory consumption with large inputs

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

| Module                   | Current | Target   | Priority |
| ------------------------ | ------- | -------- | -------- |
| `validation.ts`          | 100%    | 100%     | Critical |
| `renderer/components.ts` | 100%    | 100%     | Critical |
| `renderer/types.ts`      | 99%     | 100%     | Critical |
| `renderer/signatures.ts` | 85%     | 90%+     | High     |
| `generator.ts`           | 41%     | 80%+     | High     |
| `errors.ts`              | 62%     | 90%+     | Medium   |
| `renderer/index.ts`      | 70%     | 90%+     | Medium   |
| **Overall**              | **60%** | **80%+** | -        |

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

- Split generator.ts (~1770 lines) into smaller modules
- Increase test coverage to 80%+ (currently 60%)
- Consider CLI framework (commander/yargs) for maintainability

## Known Limitations

- External crate types may render as `undefined` (types not in local index)
- Re-exports (`use` items) are not rendered as separate pages
- Macro documentation depends on rustdoc output completeness
- Maximum 6 cross-reference cards per item
- Some complex async return types with lifetime parameters may show simplified representations
- Blanket implementations are filtered out (may miss some trait impls)
- Requires nightly Rust or RUSTC_BOOTSTRAP=1 for rustdoc JSON generation

### Unsupported Features

The following rustdoc features are not currently supported:

- Auto-derive documentation (rustdoc --show-type-sizes)
- Item examples from external files
- Custom rustdoc CSS/themes
- Intra-doc links to external crates (links to docs.rs instead)
- Doc aliases (`#[doc(alias = "...")]`)
- Fuzzy search index generation
- Theme customization in output

### Performance Considerations

- Large crates (100+ modules) may take several minutes to process
- Memory usage scales with crate complexity (~500MB for large crates)
- Consider `--group-by kind` for simpler navigation of complex crates
