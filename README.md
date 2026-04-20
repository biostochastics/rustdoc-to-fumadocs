<h1 align="center">rustdoc-to-fumadocs</h1>

<p align="center">
  <strong>Convert Rust API documentation to beautiful FumaDocs sites</strong><br>
  <em>Transform rustdoc JSON output into FumaDocs-compatible MDX files with full component support.<br>
  Verified end-to-end against FumaDocs v16; schema-compatible with v14–v16+.</em>
</p>

<p align="center">
  <a href="https://github.com/biostochastics/rustdoc-to-fumadocs/actions/workflows/ci.yml"><img src="https://github.com/biostochastics/rustdoc-to-fumadocs/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/biostochastics/rustdoc-to-fumadocs/blob/main/package.json"><img src="https://img.shields.io/github/package-json/v/biostochastics/rustdoc-to-fumadocs?label=version" alt="Version"></a>
  <a href="https://github.com/biostochastics/rustdoc-to-fumadocs/blob/main/LICENSE"><img src="https://img.shields.io/github/license/biostochastics/rustdoc-to-fumadocs" alt="License"></a>
  <a href="https://github.com/biostochastics/rustdoc-to-fumadocs/commits/main"><img src="https://img.shields.io/github/last-commit/biostochastics/rustdoc-to-fumadocs" alt="Last commit"></a>
  <a href="https://github.com/biostochastics/rustdoc-to-fumadocs/pulls?q=is%3Apr+is%3Amerged"><img src="https://img.shields.io/github/issues-pr-closed/biostochastics/rustdoc-to-fumadocs?label=merged%20PRs" alt="Merged PRs"></a>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.3+-blue" alt="TypeScript: 5.3+"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-18+-green" alt="Node.js: 18+"></a>
  <a href="https://fumadocs.dev/"><img src="https://img.shields.io/badge/FumaDocs-v14%E2%80%93v16%2B-purple" alt="FumaDocs: v14–v16+"></a>
  <a href="https://eslint.org/"><img src="https://img.shields.io/badge/ESLint-v9-4B32C3" alt="ESLint: v9"></a>
  <a href="https://prettier.io/"><img src="https://img.shields.io/badge/code_style-Prettier-ff69b4" alt="Code style: Prettier"></a>
  <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/tests-Vitest-yellow" alt="Tests: Vitest"></a>
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

| Feature               | Description                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- |
| **FumaDocs v14–v16+** | Full support for icons, separators, Callouts, Tabs, Cards — verified end-to-end on v16 |
| **Cargo workspaces**  | `--workspace` processes every member into one FumaDocs tree                            |
| **Validation**        | Zod schemas with helpful error messages and hints                                      |
| **Error Handling**    | Structured errors with codes, hints, and recovery context                              |
| **Components**        | Deprecation, Safety, Panics, Errors, Feature Gate callouts                             |
| **Navigation**        | auto-generated meta.json with icons and separators                                     |
| **Flexible Output**   | Group by module, kind, or flat structure                                               |
| **CI-Friendly**       | Dry-run mode, JSON output, progress indicators                                         |
| **Security**          | Path traversal prevention, input limits, log-injection guard                           |

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
git clone https://github.com/biostochastics/rustdoc-to-fumadocs.git
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
npm run test:run    # Run 284 tests
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
  -w, --workspace [dir]   Treat <dir> (or cwd) as a Cargo workspace root and
                          generate docs for every [workspace].members entry.
                          Overrides --input/--crate.
  -o, --output <dir>      Output directory (default: content/docs/api)
  -b, --base-url <url>    Base URL for docs (default: /docs/api)
  -g, --group-by <mode>   Group by: module | kind | flat (default: module)
  --no-index              Skip index pages for modules
  --no-tabs               Disable Tabs component for implementations
  --no-cards              Disable Cards component for cross-references
  -n, --dry-run           Preview output without writing files
  --json                  JSON output for CI/scripting
  -v, --verbose           Show verbose output
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

# Whole Cargo workspace (one output subdir per member crate)
cargo doc --workspace --no-deps  # with the JSON RUSTDOCFLAGS
rustdoc-to-fumadocs --workspace --output docs/api
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

### Verified Stack (v16)

End-to-end tested on **2026-04-20** with the following versions — all 4 generated pages prerender and render correctly in a Next.js production build:

| Package         | Version |
| --------------- | ------- |
| `next`          | 16.2.4  |
| `react`         | 19.2.5  |
| `fumadocs-ui`   | 16.8.1  |
| `fumadocs-core` | 16.8.1  |
| `fumadocs-mdx`  | 14.3.1  |

The generator's output (frontmatter, `meta.json`, separators, Callout/Tabs/Cards usage) is also schema-compatible with FumaDocs v14 and v15. Consumer setup has changed across major versions — use the import paths that match your installed version.

### mdx-components.tsx

FumaDocs v16 ships `Callout`, `Tabs`, `Tab`, `Cards`, and `Card` in `defaultMdxComponents`, so the wrapper can be minimal:

```tsx
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
  };
}
```

### source.config.ts

```typescript
import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig();
```

### lib/source.ts (v16)

```typescript
import { docs } from "@/.source/server"; // v14/v15: '@/.source'
import { loader } from "fumadocs-core/source";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  // icon: (name) => lucideIcons[name],  // resolve string icons → components
});
```

> **Note on icons:** the generator emits `icon: "Folder"` / `"Box"` / etc. as strings in frontmatter and `meta.json`. Pass an `icon` resolver to `loader({...})` to map those strings to `lucide-react` components. Without a resolver, sidebar labels render the icon name as literal text (e.g. `BoxMyStruct`).

### app/layout.tsx (v16)

```tsx
// v16: provider moved under /provider/next for Next.js
import { RootProvider } from "fumadocs-ui/provider/next";
// v14/v15 equivalent: import { RootProvider } from 'fumadocs-ui/provider';

import "fumadocs-ui/style.css"; // self-contained bundle
// or, with Tailwind v4: @import "fumadocs-ui/css/preset.css" in globals.css
```

### Import Path Changes at a Glance

| What                   | v14 / v15              | v16                            |
| ---------------------- | ---------------------- | ------------------------------ |
| `RootProvider`         | `fumadocs-ui/provider` | `fumadocs-ui/provider/next`    |
| Generated source       | `@/.source`            | `@/.source/server`             |
| MDX default components | exported as `/mdx`     | exported as `/mdx` (unchanged) |

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
npm run test:run     # Single run (284 tests)
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
| workspace.ts           | 95%      |
| **Overall**            | ~62%     |

---

## Deploying to FumaDocs

The generated files are **deployment-ready** for FumaDocs v14+ projects (verified end-to-end on v16). Follow this checklist to integrate:

### Deployment Checklist

1. **Generate with dry-run first** to preview output:

   ```bash
   rustdoc-to-fumadocs --input my_crate.json --output content/docs/api --dry-run
   ```

2. **Copy generated files** to your FumaDocs content directory:

   ```bash
   rustdoc-to-fumadocs --input my_crate.json --output content/docs/api
   ```

3. **Verify required components** are exported in `mdx-components.tsx`:

   ```tsx
   import { Callout } from "fumadocs-ui/components/callout";
   import { Tabs, Tab } from "fumadocs-ui/components/tabs";
   import { Cards, Card } from "fumadocs-ui/components/card";
   ```

4. **Install Lucide icons** (used in frontmatter):

   ```bash
   npm install lucide-react
   ```

   Icons used: `Box`, `List`, `Puzzle`, `Code`, `Type`, `Hash`, `Wand2`, `Folder`

5. **Build and verify**:
   ```bash
   npm run build  # Verify MDX compilation
   npm run dev    # Check navigation and rendering
   ```

### Post-Generation Review

| Check                | What to Look For                                         |
| -------------------- | -------------------------------------------------------- |
| **Navigation**       | Sidebar shows module hierarchy with icons and separators |
| **Frontmatter**      | Pages have correct titles and descriptions               |
| **Components**       | Callouts render for deprecations, safety warnings, etc.  |
| **Cross-references** | "See Also" cards link to related types                   |
| **Code blocks**      | Rust syntax highlighting works                           |

### CI/CD Integration

```yaml
# Example GitHub Actions step
- name: Generate API docs
  run: |
    RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps
    npx rustdoc-to-fumadocs --input target/doc/my_crate.json --output content/docs/api --json
```

---

## Known Limitations & Caveats

### Generation Limitations

| Limitation                      | Impact                                        | Workaround                       |
| ------------------------------- | --------------------------------------------- | -------------------------------- |
| **Requires nightly Rust**       | Cannot use stable rustdoc                     | Use `RUSTC_BOOTSTRAP=1` in CI    |
| **Blanket impls filtered**      | Generic impls like `impl<T> From<T>` excluded | Usually desirable; reduces noise |
| **Max 6 cross-reference cards** | Large types may have incomplete "See Also"    | Acceptable for most use cases    |
| **Re-exports not rendered**     | `pub use` items don't get separate pages      | Document in parent module        |

### Content Caveats

| Issue                           | Symptom                           | Cause                                         | Resolution                                            |
| ------------------------------- | --------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| **Associated type fallback**    | `<Self as ?>::Err` in signatures  | External trait not in the local `paths` table | Expected for items whose trait lives in another crate |
| **Simplified async signatures** | Complex lifetimes abbreviated     | Async return types with many lifetime params  | Rarely affects readability                            |
| **Missing trait impls**         | Some trait implementations absent | Filtered as blanket/synthetic                 | Check if impl is truly needed                         |
| **Broken intra-doc links**      | Links to external crates fail     | External types not resolved                   | Links redirect to docs.rs                             |

### When to Expect Manual Editing

- **Complex generic bounds**: Deeply nested generics may render with simplified notation
- **Custom formatting**: If you need different component styles or layouts

### Tested Compatibility

Generated output verified against real-world crates (format v57):

| Crate            | Complexity                             | Files | Status   |
| ---------------- | -------------------------------------- | ----- | -------- |
| **syn**          | High (complex generics)                | 148   | ✅ Works |
| **tokio**        | High (async types)                     | 76    | ✅ Works |
| **serde_core**   | Medium (trait-heavy)                   | 57    | ✅ Works |
| **anyhow**       | Low (simple API)                       | 10    | ✅ Works |
| Cargo workspaces | Multi-crate with `[workspace].members` | —     | ✅ Works |

---

## Unsupported Features

The following rustdoc/documentation features are not currently supported:

- Doc aliases (`#[doc(alias = "...")]`)
- Auto-derive size documentation (`--show-type-sizes`)
- Item examples from external files
- Custom rustdoc CSS/themes
- Fuzzy search index generation
- Intra-doc links to external crates (redirects to docs.rs instead)

---

## Troubleshooting

### Generation Issues

| Issue                         | Solution                                                             |
| ----------------------------- | -------------------------------------------------------------------- |
| "Could not find rustdoc JSON" | Run `cargo +nightly doc` with `--output-format json` flag            |
| "Format version too old"      | Upgrade Rust: `rustup update nightly`                                |
| "Format version too new"      | Update rustdoc-to-fumadocs; newer formats are accepted with warnings |
| Missing implementations       | Blanket/synthetic impls are filtered by design                       |
| `<Self as ?>::Name` in output | The trait's ID wasn't in the local `paths` table (external trait)    |

### FumaDocs Deployment Issues

| Issue                             | Solution                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| Component import errors           | Ensure `mdx-components.tsx` exports `Callout`, `Tabs`, `Tab`, `Cards`, `Card`             |
| Icons not rendering               | Install `lucide-react` and verify icon names in frontmatter                               |
| Sidebar missing items             | Check `meta.json` exists in each module directory                                         |
| MDX compilation fails             | Verify all component imports are correct; check for unescaped special characters          |
| Navigation separators not showing | Ensure FumaDocs v14+ is installed (separators use `---Name---` format)                    |
| `defaultOpen` not working         | Requires FumaDocs v14+; check `meta.json` format                                          |
| `RootProvider` import fails (v16) | On v16, import from `fumadocs-ui/provider/next`, not `fumadocs-ui/provider`               |
| `@/.source` not found (v16)       | On v16, import from `@/.source/server` for server code, `@/.source/browser` for client    |
| Sidebar shows `BoxMyStruct` text  | Pass an `icon` resolver to `loader({ icon: (name) => ... })` to map strings to components |

### Validation Errors

| Error Code                   | Meaning                | Fix                                  |
| ---------------------------- | ---------------------- | ------------------------------------ |
| `INVALID_JSON`               | File is not valid JSON | Check rustdoc completed successfully |
| `UNSUPPORTED_FORMAT_VERSION` | Format outside v35-57  | Update Rust or this tool             |
| `MISSING_ROOT_MODULE`        | Root module not found  | Verify rustdoc output is complete    |
| `UNRESOLVED_TYPE`            | Type reference missing | External crate type - expected       |

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
