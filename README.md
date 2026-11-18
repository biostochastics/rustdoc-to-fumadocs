# rustdoc-to-fumadocs

Generate a browsable Rust API reference for a Fumadocs site. The CLI reads rustdoc JSON and writes MDX pages and sidebar metadata. It follows public re-exports, links types across Cargo workspace members, and renders Rust signatures, members, implementations, feature gates, and safety documentation.

[![CI](https://github.com/biostochastics/rustdoc-to-fumadocs/actions/workflows/ci.yml/badge.svg)](https://github.com/biostochastics/rustdoc-to-fumadocs/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Quick start

Use Node.js 20.19+ on the 20.x line, or 22.12+. Rust is needed to **produce** the input. A machine with Node alone can convert prebuilt JSON. From a checkout of this repository, build and install the CLI locally.

```sh
npm ci
archive=$(npm pack --silent)
npm install --global "./$archive"
rustdoc-to-fumadocs --version
```

From your Rust project's directory, generate JSON and point the converter at the docs content directory in your site.

```sh
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps
rustdoc-to-fumadocs --input target/doc/my_crate.json \
  --output ../my-site/content/docs/api --base-url /docs/api
```

The result includes `my_crate/index.mdx`, `my_crate/meta.json`, and public item pages. Mount the same path in your Fumadocs source loader that you pass as the base URL. For stable-toolchain testing, `RUSTC_BOOTSTRAP=1` permits the unstable rustdoc JSON option. [Installation guide](INSTALLATION.md)

## Write guides and API documentation

With the quick-start paths above and a crate named `my_crate`, you can publish all three kinds of content in one site.

| What you write                           | Where you write it                                                                                   | Where readers see it                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Item explanations and Rust examples      | `///` above a struct, function, or method                                                            | The item's generated page, such as `/docs/api/my_crate/Client`                             |
| Crate introduction                       | `//!` at the top of `src/lib.rs`, or a README included with `#![doc = include_str!("../README.md")]` | The crate overview at `/docs/api/my_crate` with the default layout                         |
| Tutorials with your own React components | A hand-written MDX file such as `content/docs/guides/first-request.mdx`                              | A separate page at `/docs/guides/first-request` when the docs loader is mounted at `/docs` |

For example, this `src/lib.rs` includes the crate's README in the overview and puts a runnable example on the `Client` page.

````rust
#![doc = include_str!("../README.md")]

/// A client for the request queue.
///
/// ```
/// use my_crate::Client;
/// let client = Client::default();
/// ```
#[derive(Default)]
pub struct Client;
````

Rustdoc expands `include_str!` when producing the JSON. Keep a hand-written guide alongside the generated `api/` directory. It can link directly to a generated page and use components registered in your site's MDX component map.

```mdx
---
title: Your first request
---

<RequestTip>Reuse the client across requests.</RequestTip>

See the [Client API](/docs/api/my_crate/Client).
```

Register `RequestTip` in the same component map as the Fumadocs components, or define it in the guide itself. Regenerating `content/docs/api` leaves `content/docs/guides` alone. [Fumadocs setup](#fumadocs-integration) · [Working guide with a custom component](tests/compat/first-request.mdx)

## Compatibility

| Producer or consumer  | Coverage                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust and rustdoc JSON | Accepts formats 27–61. Real inputs exercise Rust 1.76 (27), 1.80 (30), 1.83 (35), 1.86 (39), 1.89 (53), 1.92 (56), 1.94 (57), 1.98 (60), and 1.99–1.100 (61). The November 17, 2026 nightly also emitted 61.                       |
| Newer rustdoc formats | The generator warns, checks the shapes it consumes, and renders recognized items. A breaking change to a known shape produces a diagnostic identifying the JSON field.                                                             |
| Fumadocs Core and UI  | Next.js production builds exercise 14.7.7, 15.8.5, and 16.19.4 with real generated pages. The compatibility job also selects the latest npm release.                                                                               |
| Node.js               | The converter requires Node 20.19+ on 20.x or Node 22.12+. Every PR runs on Node 24. The manual compatibility workflow also covers Node 20, 22 and 26. A consuming Next.js or Fumadocs toolchain can require a newer Node release. |

The manual Rust matrix generates fresh JSON on each toolchain and checks the rendered signatures, public aliases, internal links, and MDX in all three layouts. The Fumadocs matrix checks generated routes with the framework's loader and prerenders pages using its components. The latest v16 build uses the native Fumadocs MDX adapter. [Compatibility workflow](.github/workflows/ci.yml)

## CLI

| Option                                          | Behavior                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <file>`                            | Read a rustdoc JSON file. A single positional path also works.                                                                                                              |
| `-c, --crate <name>`                            | Find the crate under the Cargo target directory. With no input option, read the current package manifest.                                                                   |
| `-w, --workspace [dir]`                         | Generate a workspace reference. Defaults to the current directory.                                                                                                          |
| `--target-dir <dir>`                            | Override `CARGO_TARGET_DIR` and the discovered Cargo target directory.                                                                                                      |
| `--exclude <names>`                             | Skip named workspace packages or crate targets. Accepts repeated flags or comma-separated names.                                                                            |
| `--require-complete`                            | In workspace mode, fail before publication if any selected input is missing or invalid. Explicitly excluded and unpublished members follow the selection flags.             |
| `--workspace-cache-mib <N>`                     | Reuse workspace generators between passes within a budget of N MiB of raw input. Accepts nonnegative whole numbers. Defaults to 4. Set 0 to disable reuse.                  |
| `--include-unpublished`                         | Include workspace packages with publishing disabled.                                                                                                                        |
| `-o, --output <dir>`                            | Output directory. Defaults to `content/docs/api`.                                                                                                                           |
| `-b, --base-url <path>`                         | Public URL of the output directory. Defaults to `/docs/api`.                                                                                                                |
| `-g, --group-by <layout>`                       | `module` emits one page per item under its module. `kind` groups items and their implementations on shared pages. `flat` writes qualified names inside one crate directory. |
| `--no-index`                                    | Suppress module index pages. Links target available pages where possible.                                                                                                   |
| `--no-tabs`, `--no-cards`                       | Disable implementation tabs or related-item cards.                                                                                                                          |
| `--source-url-base <url>`, `--source-ref <ref>` | Link source spans and repository-relative documentation. A ref adds the GitHub-style `blob/<ref>` path.                                                                     |
| `--list-files`                                  | Print ordered relative paths, one per line. Combine with `--json` for a `paths` array, status, and input diagnostics. Page rendering and byte counts are skipped.           |
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

Cargo metadata supplies workspace membership, inherited publish settings, target names, and the target directory. A TOML fallback handles explicit members, globs, excludes, root packages, and renamed libraries on hosts with prebuilt JSON. The converter indexes member routes first, then verifies each input digest and renders one member at a time. Small validated members can be reused within the cache budget. The budget measures source bytes, so process memory can exceed it. The workspace landing page links to each documented crate. For packages with multiple binary targets, select a specific target with `--input` when needed.

Missing member inputs produce warnings. A preview reports `status: "partial"` and a `workspace.skipped` list when some members were skipped. A run with zero usable members exits with an error. Use `--require-complete` in CI to check coverage and publish in one invocation. A strict failure reports skipped members and preserves the previous output.

```sh
rustdoc-to-fumadocs --workspace --require-complete --output content/docs/api
```

For a route inventory, run `rustdoc-to-fumadocs --workspace --list-files --json` and read `.paths[]`. This includes sidebar metadata and workspace landing files. Use `--json` alone when you need UTF-8 byte counts or rendering diagnostics. All preview modes leave the output directory untouched.

### Regeneration

The CLI reports how many files it wrote, kept unchanged, and removed. It checks live destinations before publication and records generated file hashes in `.rustdoc-to-fumadocs.manifest` in the output directory. Keep that manifest with the generated tree. A complete run removes obsolete pages it previously generated when their contents still match the manifest. Edited obsolete pages and unrelated guides are preserved. Partial workspace runs defer cleanup until a complete run. Files created before 0.5.0 have no ownership record. Start in a fresh output directory when migrating a generated-only tree.

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

`generate()` returns the complete array. Iterate over `generateFiles()` to render and consume one complete file at a time, or over `filePaths()` to inspect paths without rendering. Both iterators follow publication order. With kind grouping, each shared kind page is one file.

Supply a `frontmatter(item, path)` callback to customize item and module page metadata such as titles, descriptions, and icons. Use `pageIndex()` and `setExternalPages()` to connect independently generated crates. `landingUrl()` returns an emitted destination or `null` for an empty indexless crate.

### Document private items

The CLI generates the public reference, even when the input contains private items. For internal documentation, first ask rustdoc to include those items.

```sh
RUSTDOCFLAGS="-Z unstable-options --output-format json --document-private-items" \
  cargo +nightly doc --no-deps
```

Then use the JavaScript or TypeScript library. This example reads the JSON, includes all supported items present in it, and writes the result to a dedicated directory. Run it from the Rust project with the package installed locally.

```js
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RustdocGenerator, validateRustdocJson } from "rustdoc-to-fumadocs";

const { crate } = validateRustdocJson(
  JSON.parse(await readFile("target/doc/my_crate.json", "utf8"))
);
const output = "../my-site/content/docs/internal-api";
const generator = new RustdocGenerator(crate, {
  output,
  baseUrl: "/docs/internal-api",
  filter: () => true,
});

for (const file of generator.generateFiles()) {
  const dest = join(output, file.path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, file.content);
}
```

A custom `filter(item)` replaces the default public filter. It applies to modules, fields, methods, and re-exports as well as top-level items. For example, `filter: (item) => item.name !== "debug_dump"` also admits private items and skips items with that name. A selected nested item needs a reachable containing module or re-export. The example writes the current files directly. Use a fresh output directory for a clean rebuild.

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
