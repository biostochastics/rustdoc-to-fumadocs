# rustdoc-to-fumadocs

Convert Rust's `rustdoc` JSON output to [Fumadocs](https://fumadocs.dev/)-compatible MDX files.

## Features

- **FumaDocs v14+ Compatible** - Full support for modern FumaDocs features
  - Icons in frontmatter (struct → Box, enum → List, trait → Puzzle)
  - Separators in meta.json navigation
  - Callout components (deprecation, safety, panics, errors, feature gates)
  - Tabs component for organizing implementations
  - Cards component for cross-references ("See Also" sections)
- **Robust Validation** - Zod schemas validate rustdoc JSON with helpful error messages
- **Smart Rendering** - Preserves documentation, signatures, fields, variants, and implementations
- **Flexible Output** - Group by module, kind, or flat structure
- **Forward-Compatible** - Gracefully handles unknown item types from newer rustdoc versions
- **CI-Friendly** - Dry-run mode, JSON output, and progress indicators
- **Security Hardened** - Path traversal prevention, input size limits, safe sanitization

## Quick Start

```bash
# 1. Generate rustdoc JSON
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps

# 2. Convert to MDX
npx tsx src/cli.ts --crate my_crate --output content/docs/api

# 3. Done! Files are in content/docs/api/
```

## Installation

```bash
cd tools/rustdoc-to-fumadocs
npm install
npm run build  # Optional: compile TypeScript
```

## CLI Reference

```
USAGE:
  rustdoc-to-fumadocs [OPTIONS] [INPUT]

OPTIONS:
  -i, --input <path>      Path to rustdoc JSON file
  -c, --crate <name>      Crate name (looks in target/doc/<name>.json)
  -o, --output <dir>      Output directory (default: content/docs/api)
  -b, --base-url <url>    Base URL for generated docs (default: /docs/api)
  -g, --group-by <mode>   Group items by: module, kind, or flat (default: module)
  --no-index              Don't generate index pages for modules
  --no-tabs               Don't use Tabs component for implementations
  --no-cards              Don't use Cards component for cross-references
  -n, --dry-run           Show what would be generated without writing files
  --json                  Output results as JSON (for scripting/CI)
  -v, --verbose           Show verbose output
  -h, --help              Show help message

EXAMPLES:
  # Basic usage
  rustdoc-to-fumadocs --input target/doc/my_crate.json --output docs/api

  # Auto-detect crate from Cargo.toml
  rustdoc-to-fumadocs --crate my_crate

  # Preview without writing
  rustdoc-to-fumadocs --crate my_crate --dry-run

  # JSON output for CI
  rustdoc-to-fumadocs --crate my_crate --json | jq '.stats'
```

## Output Structure

With `--group-by module` (default):

```
content/docs/api/
├── meta.json                    # Root navigation
├── module_name/
│   ├── meta.json                # Module navigation with separators
│   ├── index.mdx                # Module overview
│   ├── MyStruct.mdx             # Struct with implementations
│   ├── MyEnum.mdx               # Enum with variants
│   ├── my_function.mdx          # Function documentation
│   └── submodule/
│       ├── meta.json
│       └── ...
└── ...
```

## Generated MDX Features

### Frontmatter

```yaml
---
title: "MyStruct"
description: "A data structure for handling..."
icon: "Box"
---
```

### Callouts

The generator creates contextual callouts:

- **Deprecation** - Warnings for deprecated items with version and note
- **Safety** - Unsafe functions/traits with `# Safety` section extracted
- **Panics** - Functions with `# Panics` section extracted
- **Errors** - Functions with `# Errors` section extracted
- **Feature Gates** - Items requiring specific Cargo features

### Tabs for Implementations

When a struct or enum has both inherent methods and trait implementations, they're organized in tabs:

```mdx
<Tabs items={["Methods", "Trait Implementations"]}>
  <Tab value="Methods">### `impl MyStruct` ...methods...</Tab>
  <Tab value="Trait Implementations">### `impl Display for MyStruct` ...</Tab>
</Tabs>
```

### Cards for Cross-References

Related types are shown in a "See Also" section with Cards:

```mdx
## See Also

<Cards>
  <Card title="OtherStruct" href="./OtherStruct" description="A related struct" icon="Box" />
  <Card title="MyTrait" href="./MyTrait" description="The trait this implements" icon="Puzzle" />
</Cards>
```

## Programmatic API

```typescript
import { RustdocGenerator, type GeneratorOptions } from "rustdoc-to-fumadocs";
import { validateRustdocJson } from "rustdoc-to-fumadocs/validation";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

// Load and validate rustdoc JSON
const rawJson = JSON.parse(readFileSync("target/doc/my_crate.json", "utf-8"));
const { crate, warnings } = validateRustdocJson(rawJson);

if (warnings.length > 0) {
  console.warn("Warnings:", warnings);
}

// Configure generator
const options: GeneratorOptions = {
  output: "content/docs/api",
  baseUrl: "/docs/api",
  groupBy: "module",
  generateIndex: true,
  useTabs: true, // Group implementations in tabs
  useCards: true, // Add "See Also" sections

  // Custom frontmatter
  frontmatter: (item, path) => ({
    title: item.name ?? "API",
    description: item.docs?.split("\n")[0] ?? "",
    custom: { path: path.join("::") },
  }),

  // Custom filter
  filter: (item) => item.visibility === "public",
};

// Generate and write files
const generator = new RustdocGenerator(crate, options);
const files = generator.generate();

for (const file of files) {
  const fullPath = join("content/docs/api", file.path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, file.content);
}

console.log(`Generated ${files.length} files`);
```

## FumaDocs Integration

### mdx-components.tsx

```tsx
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Callout } from "fumadocs-ui/components/callout";
import { Tabs, Tab } from "fumadocs-ui/components/tabs";
import { Cards, Card } from "fumadocs-ui/components/card";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Callout,
    Tabs,
    Tab,
    Cards,
    Card,
    ...components,
  };
}
```

### source.config.ts

```typescript
import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const apiDocs = defineDocs({
  dir: "content/docs/api",
});

export default defineConfig();
```

## Generating Rustdoc JSON

Rustdoc JSON requires nightly Rust or `RUSTC_BOOTSTRAP=1`:

```bash
# Using nightly
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps

# Using stable with bootstrap (for CI)
RUSTC_BOOTSTRAP=1 RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo doc --no-deps
```

The JSON file will be at `target/doc/<crate_name>.json`.

## Format Compatibility

| Rustdoc Format | Rust Version | Support               |
| -------------- | ------------ | --------------------- |
| 35-57          | 1.76 - 1.85+ | Full                  |
| < 35           | < 1.76       | Unsupported           |
| > 57           | Future       | Warning + best-effort |

## Troubleshooting

### "Could not find rustdoc JSON"

Make sure you've generated the JSON first:

```bash
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps
```

Check that the file exists at `target/doc/<crate_name>.json`.

### "Format version X is too old"

Upgrade your Rust toolchain:

```bash
rustup update
```

### Missing implementations

Blanket and synthetic implementations are filtered out by default. Only inherent implementations and trait implementations with documented methods are included.

### Component import errors

Make sure your `mdx-components.tsx` exports all required components:

- `Callout` from `fumadocs-ui/components/callout`
- `Tabs`, `Tab` from `fumadocs-ui/components/tabs`
- `Cards`, `Card` from `fumadocs-ui/components/card`

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run test         # Run tests in watch mode
npm run test:run     # Run tests once (222 tests)
npm run test:coverage # Run with coverage report (~61% coverage)
```

### Test Coverage

| Module                 | Coverage     |
| ---------------------- | ------------ |
| renderer/components.ts | 100%         |
| renderer/types.ts      | 99%          |
| validation.ts          | 100%         |
| types.ts               | 100% (lines) |
| Overall                | ~61%         |

## Security

The tool includes several security measures:

- **Input Size Limits** - Maximum 100MB input file size prevents memory exhaustion
- **Path Sanitization** - `sanitizePath()` replaces `..`, `/`, `\`, and invalid characters
- **Output Path Validation** - Ensures generated files stay within the output directory
- **Recursion Limits** - `MAX_RECURSION_DEPTH` prevents stack overflow on deep modules
- **Warning Limits** - `MAX_WARNINGS` prevents console flooding from malformed input

### Security Considerations

When processing untrusted rustdoc JSON:

1. Use `--dry-run` to preview output before writing
2. Inspect generated file paths in JSON output mode
3. Run in a sandboxed environment if processing untrusted crates

## Limitations

- Requires nightly Rust or `RUSTC_BOOTSTRAP=1` to generate rustdoc JSON
- Blanket and synthetic implementations are filtered out
- Cross-crate links point to external documentation (docs.rs)
- Re-exports (`use` items) are not rendered as separate pages
- Macro documentation depends on rustdoc output completeness
- Maximum 6 cross-reference cards per item

## License

MIT OR Apache-2.0
