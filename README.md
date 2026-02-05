<h1 align="center">rustdoc-to-fumadocs</h1>

<p align="center">
  <strong>Convert Rust API documentation to beautiful FumaDocs sites</strong><br>
  <em>Transform rustdoc JSON output into FumaDocs v14+ compatible MDX files with full component support</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.3+-blue" alt="TypeScript: 5.3+"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-18+-green" alt="Node.js: 18+"></a>
  <a href="https://fumadocs.dev/"><img src="https://img.shields.io/badge/FumaDocs-v14+-purple" alt="FumaDocs: v14+"></a>
</p>

<p align="center">
  <a href="https://eslint.org/"><img src="https://img.shields.io/badge/ESLint-v9-4B32C3" alt="ESLint: v9"></a>
  <a href="https://prettier.io/"><img src="https://img.shields.io/badge/code_style-Prettier-ff69b4" alt="Code style: Prettier"></a>
  <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/tests-Vitest-yellow" alt="Tests: Vitest"></a>
  <img src="https://img.shields.io/badge/tests-222%20passing-brightgreen" alt="222 tests passing">
</p>

---

## What is rustdoc-to-fumadocs?

rustdoc-to-fumadocs converts Rust's `rustdoc` JSON output into [FumaDocs](https://fumadocs.dev/)-compatible MDX files. It bridges the gap between Rust's documentation system and modern documentation frameworks, enabling you to integrate Rust API docs into your existing FumaDocs site.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RUST PROJECT                                   │
│                                                                             │
│   cargo +nightly doc --output-format json                                   │
│                         │                                                   │
│                         ▼                                                   │
│              target/doc/my_crate.json                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         RUSTDOC-TO-FUMADOCS                                 │
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │  Validation │ -> │  Generator  │ -> │  Renderer   │ -> │   Output    │  │
│  │  (Zod)      │    │  (Modules)  │    │ (Components)│    │   (MDX)     │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘  │
│                                                                             │
│  • Format version check (v35-57)    • FumaDocs Callouts, Tabs, Cards       │
│  • Helpful error messages           • YAML frontmatter with icons          │
│  • Forward-compatible parsing       • meta.json navigation                 │
└─────────────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FUMADOCS SITE                                     │
│                                                                             │
│   content/docs/api/                                                         │
│   ├── meta.json              # Navigation with icons & separators          │
│   ├── my_module/                                                            │
│   │   ├── index.mdx          # Module overview                              │
│   │   ├── MyStruct.mdx       # Struct with implementations                  │
│   │   ├── MyEnum.mdx         # Enum with variants                           │
│   │   └── my_function.mdx    # Function documentation                       │
│   └── ...                                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## At a Glance

| Feature             | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| **FumaDocs v14+**   | Full support for icons, separators, Callouts, Tabs, Cards  |
| **Validation**      | Zod schemas with helpful error messages and hints          |
| **Components**      | Deprecation, Safety, Panics, Errors, Feature Gate callouts |
| **Navigation**      | auto-generated meta.json with icons and separators         |
| **Flexible Output** | Group by module, kind, or flat structure                   |
| **CI-Friendly**     | Dry-run mode, JSON output, progress indicators             |
| **Security**        | Path traversal prevention, input limits, sanitization      |

### Rustdoc Format Compatibility

| Format Version | Rust Version | Support                                  |
| -------------- | ------------ | ---------------------------------------- |
| 35-55          | 1.76 - 1.84  | Full                                     |
| 56-57          | 1.85+        | Full (numeric IDs, new attribute format) |
| > 57           | Future       | Warning + best-effort                    |

---

## Quick Start

### Prerequisites

| Requirement | Version | Notes                       |
| ----------- | ------- | --------------------------- |
| **Node.js** | 18+     | 20 recommended              |
| **Rust**    | nightly | For rustdoc JSON generation |
| **npm**     | 9+      | Comes with Node.js          |

### Installation

```bash
# Clone and install
git clone https://github.com/Biostochastics/rustdoc-to-fumadocs.git
cd rustdoc-to-fumadocs
npm install
```

### Generate Documentation

```bash
# 1. Generate rustdoc JSON from your Rust project
cd /path/to/your/rust/project
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps

# 2. Convert to FumaDocs MDX
cd /path/to/rustdoc-to-fumadocs
npx tsx src/cli.ts --input /path/to/target/doc/my_crate.json --output content/docs/api

# 3. Done! MDX files are ready for FumaDocs
```

### Verify Installation

```bash
npm run test:run    # Run 222 tests
npm run build       # Compile TypeScript
```

---

## CLI Reference

```
USAGE:
  rustdoc-to-fumadocs [OPTIONS]

OPTIONS:
  -i, --input <path>      Path to rustdoc JSON file
  -c, --crate <name>      Crate name (auto-finds target/doc/<name>.json)
  -o, --output <dir>      Output directory (default: content/docs/api)
  -b, --base-url <url>    Base URL for docs (default: /docs/api)
  -g, --group-by <mode>   Group by: module | kind | flat (default: module)
  --no-index              Skip index pages for modules
  --no-tabs               Disable Tabs component for implementations
  --no-cards              Disable Cards component for cross-references
  -n, --dry-run           Preview output without writing files
  --json                  JSON output for CI/scripting
  -h, --help              Show help message
```

### Examples

```bash
# Basic usage
rustdoc-to-fumadocs --input target/doc/my_crate.json --output docs/api

# Auto-detect crate from Cargo.toml
rustdoc-to-fumadocs --crate my_crate

# Preview without writing
rustdoc-to-fumadocs --crate my_crate --dry-run

# JSON output for CI pipelines
rustdoc-to-fumadocs --crate my_crate --json | jq '.stats'
```

---

## Generated Output

### FumaDocs Components

| Component   | Usage                                              | Example                                                 |
| ----------- | -------------------------------------------------- | ------------------------------------------------------- |
| **Callout** | Deprecation, safety, panics, errors, feature gates | `<Callout type="warn">Deprecated since 1.2.0</Callout>` |
| **Tabs**    | Organize methods vs trait implementations          | `<Tabs items={["Methods", "Traits"]}>`                  |
| **Cards**   | Cross-references in "See Also" sections            | `<Card title="OtherStruct" icon="Box" />`               |

### Icon Mapping

| Rust Item  | FumaDocs Icon |
| ---------- | ------------- |
| struct     | Box           |
| enum       | List          |
| trait      | Puzzle        |
| function   | Code          |
| type alias | Type          |
| constant   | Hash          |
| macro      | Wand2         |
| module     | Folder        |

### Sample Output

**Frontmatter:**

```yaml
---
title: "MyStruct"
description: "A data structure for handling..."
icon: "Box"
---
```

**meta.json:**

```json
{
  "title": "my_module",
  "icon": "Folder",
  "defaultOpen": true,
  "pages": ["index", "---Structs---", "MyStruct", "---Functions---", "my_function"]
}
```

---

## Programmatic API

```typescript
import { RustdocGenerator, validateRustdocJson } from "rustdoc-to-fumadocs";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

// Load and validate
const rawJson = JSON.parse(readFileSync("target/doc/my_crate.json", "utf-8"));
const { crate, warnings } = validateRustdocJson(rawJson);

// Generate
const generator = new RustdocGenerator(crate, {
  output: "content/docs/api",
  baseUrl: "/docs/api",
  useTabs: true,
  useCards: true,
});

const files = generator.generate();

// Write files
for (const file of files) {
  const fullPath = join("content/docs/api", file.path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, file.content);
}

console.log(`Generated ${files.length} files`);
```

---

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

---

## Generating Rustdoc JSON

Rustdoc JSON requires nightly Rust:

```bash
# Using nightly (recommended)
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps

# Using stable with bootstrap (CI environments)
RUSTC_BOOTSTRAP=1 RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo doc --no-deps
```

Output: `target/doc/<crate_name>.json`

---

## Security

| Protection            | Description                                    |
| --------------------- | ---------------------------------------------- |
| **Input Size Limits** | Maximum 100MB prevents memory exhaustion       |
| **Path Sanitization** | Blocks `..`, `/`, `\`, and invalid characters  |
| **Output Validation** | Ensures files stay within output directory     |
| **Recursion Limits**  | Prevents stack overflow on deep modules        |
| **Warning Limits**    | Prevents console flooding from malformed input |

### Processing Untrusted Input

1. Use `--dry-run` to preview output before writing
2. Inspect generated paths with `--json` output
3. Run in a sandboxed environment for untrusted crates

---

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run test         # Watch mode
npm run test:run     # Single run (222 tests)
npm run test:coverage # Coverage report
npm run lint         # ESLint
npm run format       # Prettier
```

### Test Coverage

| Module                 | Coverage |
| ---------------------- | -------- |
| validation.ts          | 100%     |
| renderer/components.ts | 100%     |
| renderer/types.ts      | 99%      |
| **Overall**            | ~61%     |

---

## Troubleshooting

| Issue                         | Solution                                                  |
| ----------------------------- | --------------------------------------------------------- |
| "Could not find rustdoc JSON" | Run `cargo +nightly doc` with `--output-format json` flag |
| "Format version too old"      | Upgrade Rust: `rustup update`                             |
| Missing implementations       | Blanket/synthetic impls are filtered by design            |
| Component import errors       | Ensure mdx-components.tsx exports Callout, Tabs, Cards    |

---

## Limitations

- Requires nightly Rust (or `RUSTC_BOOTSTRAP=1`) for JSON generation
- Blanket and synthetic implementations filtered out
- Cross-crate links point to docs.rs
- Re-exports not rendered as separate pages
- Maximum 6 cross-reference cards per item

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

```bash
# Development workflow
git checkout -b feature/my-feature
npm run test:run && npm run lint
npm run changeset  # Document your changes
git commit -m "feat: add my feature"
```

---

## License

**[MIT License](LICENSE)**

Copyright (c) 2026 Biostochastics

---

<p align="center">
  <em>Built for the Rust and FumaDocs communities</em>
</p>
