# rustdoc-to-fumadocs

Generate a browsable Rust API reference for a Fumadocs site. The CLI reads rustdoc JSON and writes MDX pages and sidebar metadata. It follows public re-exports, links types across Cargo workspace members, and renders Rust signatures, members, implementations, feature gates, and safety documentation.

[![CI](https://github.com/biostochastics/rustdoc-to-fumadocs/actions/workflows/ci.yml/badge.svg)](https://github.com/biostochastics/rustdoc-to-fumadocs/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Quick start

Use Node.js 20.19+ on the 20.x line, or 22.12+. Rust is needed to **produce** the input. A machine with Node alone can convert prebuilt JSON. From a checkout of this repository, build and install the CLI locally.

```sh
npm ci
npm pack
npm install --global ./rustdoc-to-fumadocs-0.5.0.tgz
rustdoc-to-fumadocs --version
```

From your Rust project's directory, generate JSON and point the converter at the docs content directory in your site.

```sh
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps
rustdoc-to-fumadocs --input target/doc/my_crate.json \
  --output ../my-site/content/docs/api --base-url /docs/api
```

The result includes `my_crate/index.mdx`, `my_crate/meta.json`, and public item pages. Mount the same path in your Fumadocs source loader that you pass as the base URL. For stable-toolchain testing, `RUSTC_BOOTSTRAP=1` permits the unstable rustdoc JSON option. [Installation guide](INSTALLATION.md)

## Compatibility

| Producer or consumer  | Coverage                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rust and rustdoc JSON | Accepts formats 27–61. Real inputs exercise Rust 1.76 (27), 1.80 (30), 1.83 (35), 1.86 (39), 1.89 (53), 1.92 (56), 1.94 (57), 1.98 (60), and 1.99–1.100 (61). The November 17, 2026 nightly also emitted 61. |
| Newer rustdoc formats | The generator warns, checks the shapes it consumes, and renders recognized items. A breaking change to a known shape produces a diagnostic identifying the JSON field.                                       |
| Fumadocs Core and UI  | Next.js production builds exercise 14.7.7, 15.8.5, and 16.19.4 with real generated pages. The compatibility job also selects the latest npm release.                                                         |
| Node.js               | The converter requires Node 20.19+ on 20.x or Node 22.12+. CI covers the 20, 22, 24, and 26 release lines. A consuming Next.js or Fumadocs toolchain can require a newer Node release.                       |

The Rust matrix generates fresh JSON on each toolchain and checks the rendered signatures, public aliases, internal links, and MDX in all three layouts. The Fumadocs matrix checks generated routes with the framework's loader and prerenders pages using its components. The latest v16 build uses the native Fumadocs MDX adapter. [Compatibility workflow](.github/workflows/ci.yml)

## CLI

| Option                                          | Behavior                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <file>`                            | Read a rustdoc JSON file. A single positional path also works.                                                                                                              |
| `-c, --crate <name>`                            | Find the crate under the Cargo target directory. With no input option, read the current package manifest.                                                                   |
| `-w, --workspace [dir]`                         | Generate a workspace reference. Defaults to the current directory.                                                                                                          |
| `--target-dir <dir>`                            | Override `CARGO_TARGET_DIR` and the discovered Cargo target directory.                                                                                                      |
| `--exclude <names>`                             | Skip named workspace packages or crate targets. Accepts repeated flags or comma-separated names.                                                                            |
| `--include-unpublished`                         | Include workspace packages with publishing disabled.                                                                                                                        |
| `-o, --output <dir>`                            | Output directory. Defaults to `content/docs/api`.                                                                                                                           |
| `-b, --base-url <path>`                         | Public URL of the output directory. Defaults to `/docs/api`.                                                                                                                |
| `-g, --group-by <layout>`                       | `module` emits one page per item under its module. `kind` groups items and their implementations on shared pages. `flat` writes qualified names inside one crate directory. |
| `--no-index`                                    | Suppress module index pages. Links target available pages where possible.                                                                                                   |
| `--no-tabs`, `--no-cards`                       | Disable implementation tabs or related-item cards.                                                                                                                          |
| `--source-url-base <url>`, `--source-ref <ref>` | Link source spans and repository-relative documentation. A ref adds the GitHub-style `blob/<ref>` path.                                                                     |
| `-n, --dry-run`                                 | Print a proposed file list and byte counts.                                                                                                                                 |
| `--json`                                        | Print a machine-readable **preview**. The command leaves the output directory untouched.                                                                                    |
| `-v, --verbose`                                 | List files in human-readable output.                                                                                                                                        |
| `-h, --help`, `-V, --version`                   | Print CLI help or the installed package version.                                                                                                                            |

### Cargo workspaces

```sh
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --workspace --no-deps
rustdoc-to-fumadocs --workspace . --exclude xtask \
  --output ../my-site/content/docs/api --base-url /docs/api \
  --source-url-base https://github.com/example/project --source-ref v1.2.0
```

Cargo metadata supplies workspace membership, inherited publish settings, target names, and the target directory. A TOML fallback handles explicit members, globs, excludes, root packages, and renamed libraries on hosts with prebuilt JSON. The converter indexes member routes first, then reloads and renders one member at a time. The workspace landing page links to each documented crate. For packages with multiple binary targets, select a specific target with `--input` when needed.

Missing member inputs produce warnings. A preview reports `status: "partial"` and a `workspace.skipped` list when some members were skipped. A run with zero usable members exits with an error. To require complete coverage in CI, check the preview before writing.

```sh
rustdoc-to-fumadocs --workspace --json > api-preview.json
jq -e '.success and .status == "complete"' api-preview.json
rustdoc-to-fumadocs --workspace --output content/docs/api
```

### Regeneration

The CLI stages generated files, checks their destinations, and records their hashes in `.rustdoc-to-fumadocs.manifest` in the output directory. Keep that manifest with the generated tree. A complete run removes obsolete pages it previously generated when their contents still match the manifest. Edited obsolete pages and unrelated guides are preserved. Partial workspace runs defer cleanup until a complete run. Files created before 0.5.0 have no ownership record. Start in a fresh output directory when migrating a generated-only tree.

Use the CLI for managed disk writes. Normal write errors roll back changes during publication. A lock serializes publication to an output directory. If the process was forcibly terminated, inspect the output and any stage directory before removing an abandoned lock and retrying.

## Fumadocs integration

In a Fumadocs Next.js app, register the generated components in the component map passed to your MDX body. A generated page can use `Callout`, `Tabs`, `Tab`, `Cards`, and `Card`. The default MDX components and tab exports are available in the tested v14–v16 installations.

```tsx
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { MDXComponents } from "mdx/types";

export function getMDXComponents(extra: MDXComponents = {}): MDXComponents {
  return { ...defaultMdxComponents, Tab, Tabs, ...extra };
}
```

For the v16 native adapter, include the generated directory in `defineDocs` and feed its source into the loader. Register `createMDX()` from `fumadocs-mdx/next` in the site's Next.js configuration.

```ts
// source.config.ts
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({ dir: "content/docs" });
export default defineConfig();
```

```ts
// lib/source.ts
import { docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
```

Pass an icon resolver to `loader` to map frontmatter and sidebar icon names to React elements. Keep Fumadocs' heading plugin enabled to resolve generated member IDs such as `#method.new`. Fumadocs v14 and v15 expose their Next.js root provider under `fumadocs-ui/provider`. In v16 the Next.js provider is `fumadocs-ui/provider/next`. [Runnable consumer test](scripts/test-fumadocs.sh)

## What gets documented

- Public modules, named and glob re-exports, procedural macros, type aliases, constants, statics, unions, structs, enums, traits, and their documented members.
- Tuple fields, enum variants, associated types and constants, inherent methods, trait implementations, conditional auto traits, and separate entries for implementors that share a short name.
- Rust signatures including FFI safety and ABI, variadics, lifetimes, dynamic callables, associated bindings, and generic constraints.
- Rustdoc Markdown, links, doctests, deprecation, safety requirements, errors, feature availability, and stability metadata where supplied by rustdoc. Inline Rust and doctest fences remain code. Source prose is treated as Markdown data.
- Intra-doc references use rustdoc's link table. Targets with enough metadata link to an emitted page or member anchor, a sibling crate, or external rustdoc. External member references without a resolvable path can reduce to their label. Blanket impl listings are intentionally limited.

## Library API

The package exports ESM and TypeScript declarations. The generator returns relative paths and file contents. Validation also returns warnings when a producer uses a newer format.

```ts
import { readFile } from "node:fs/promises";
import { RustdocGenerator, validateRustdocJson } from "rustdoc-to-fumadocs";

const input = JSON.parse(await readFile("target/doc/my_crate.json", "utf8"));
const { crate, warnings } = validateRustdocJson(input);
const generator = new RustdocGenerator(crate, {
  output: "content/docs/api",
  baseUrl: "/docs/api",
  onWarning: (message) => console.warn(message),
});
const files = generator.generate();
```

Use `pageIndex()` and `setExternalPages()` to connect independently generated crates. `landingUrl()` returns an emitted destination or `null` for an empty indexless crate.

## Development

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run test:rust
npm run test:fumadocs -- 16
npm run test:crates -- itoa serde_core
```

The Rust test builds a small local crate. The Fumadocs test installs the selected major in a temporary Next.js project and verifies prerendered HTML. The real-crate test accepts prebuilt JSON via `RUSTDOC_JSON_DIR` or downloads the requested Cargo packages. [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
