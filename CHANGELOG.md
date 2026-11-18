# Changelog

All notable changes to rustdoc-to-fumadocs will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases use [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Ship a concise `llms.txt` documentation index in the repository and npm package.
- List planned output paths with `--list-files` or `RustdocGenerator.filePaths()`. Add `--json` for an ordered `paths` array and workspace status.
- Require complete workspace coverage before writing with `--require-complete`. Set `--workspace-cache-mib N` to control how much input can be reused between passes. The default is 4 MiB.
- Consume rendered files in publication order using the synchronous `generateFiles()` iterator. The existing `generate()` method returns the full array.

### Changed

- Run the full compatibility suite on tag pushes and manual dispatches, including the minimum supported Node.js versions. Pull requests and ordinary main-branch pushes retain a single Ubicloud check.

- Bundle the CLI with lazy-loaded dependencies, stage output in bounded batches, and streamline default frontmatter, member lookups and Markdown processing. Fresh single-crate publication can install a verified staging directory with one rename.
- Speed up rustdoc validation and short Markdown summaries. Preserve custom frontmatter, output ordering and the full byte-count preview.

### Fixed

- Enforce the 100 MiB input limit on the opened file, including files that grow while being read.
- Find explicitly renamed binaries and report invalid glob-matched members when using the manifest fallback. Strict publication stops before writing when a selected manifest is invalid.
- Preserve pages and detect conflicting local edits when a filename changes capitalization. Retain independent additions during rollback after a publication error.

## 0.5.1 - 2026-11-17

### Changed

- Cache Markdown syntax trees during each render and share item descriptions across frontmatter and related-item cards. Filename and heading allocation now skips previously tested suffixes.
- Reuse small workspace members between indexing and rendering under a shared input-size budget. Each member's digest is checked again before rendering.
- Verify output files in batches. Reruns preserve matching pages and manifests, repair edited or missing current pages, and report the numbers written, unchanged, and removed.
- CLI help opens with a preview and a write example. Help and version commands load independently of the conversion engine. Argument errors link to usage, and partial workspace runs report skipped members.
- Expand the authoring guide with item examples, README-backed crate overviews, hand-written Fumadocs pages, and the library workflow for private documentation.

### Fixed

- Preserve the Rust visibility of tuple fields when a custom filter includes internal items.

## 0.5.0 - 2026-11-17

### Changed

- This pre-1.0 minor release changes public types, generated routes, and CLI behavior. Nullable TypeScript fields now reflect actual rustdoc output. The exported validation schema uses Zod 4. Source comments are interpreted as Markdown, and literal JSX in a crate comment is rendered as documentation.
- Flat and grouped layouts now allocate distinct canonical routes and member anchors. Regenerate published trees and update hand-authored links to old flat or grouped paths. Node.js 20.19+ on the 20.x line, or 22.12+ is required.
- Regeneration stages changes and records ownership in a manifest. Keep the manifest to prune obsolete generated pages on subsequent complete runs. JSON output remains a preview.
- Workspace generation retains a compact shared route index and renders one member at a time. The machine-readable report includes partial status, member outcomes, warnings, and UTF-8 byte counts.

### Added

- Rustdoc compatibility for legacy formats beginning at 27 (Rust 1.76) and format 61, including current stable Rust 1.100 and the November 17 nightly.
- Consumer production-build checks for Fumadocs 14, 15, 16, and the latest release, including navigation, anchored headings, MDX components, and a native v16 MDX build.
- Cargo metadata discovery for root packages, custom library targets, implicit members, and configured target directories. A manifest-based fallback supports offline conversion without Cargo.
- CLI version output, a programmatic warning callback and a lookup for each crate's reachable landing page.

### Fixed

- Markdown conversion preserves code, multiline summaries, ordinary HTML, literal braces, and reference links. Safety, panic, and error callouts share fence-aware section extraction.
- FFI signatures preserve safety, ABI and variadics. Trait-object arguments, generic constraints, tuple fields, feature gates, and conditional implementations survive rendering.
- Public output filters private members, respects custom filters on re-exports, preserves alias metadata and enum-variant links, and distinguishes similarly named trait implementors.
- Glob traversal terminates on repeated edges. Grouped pages include implementations, collision handling respects filesystem limits and reserved Windows names, and indexless links target emitted pages.
- File publication rejects symlinked descendant destinations. Repeated conversions clean up obsolete owned pages while preserving independent and edited obsolete files.
- Updated runtime Markdown, TOML, YAML, and schema dependencies and refreshed the development lockfile.
- Piped JSON output drains before process exit. Unknown options and malformed input return structured errors. Test fixtures are typechecked, coverage includes the CLI, and real-crate smoke tests now compile generated output.

## 0.4.0 - 2026-11-17

API completeness release: the generated reference now covers the whole public
API of a crate, links resolve, and every page compiles as MDX without
post-processing. Verified on the fluxid workspace (rustdoc JSON formats 57 and 60).

### Fixed

- **Re-exports were dropped.** `pub use` items (nameless in rustdoc JSON) were
  skipped, so items defined in private modules had no page. A reachability plan
  now places directly reachable items at their path, inlines items and modules
  re-exported from private modules (and `#[doc(inline)]` re-exports) at the
  re-export path under the `use` name, applies glob re-exports per child, and
  lists re-exports of documented or external items in a **Re-exports** section.
- **Field types broke MDX.** Struct, union and variant field types are inline
  code (`Option<String>`, `Vec<[u8; 32]>` parsed as JSX before).
- **Links.** `baseUrl` was unused: module indexes linked `./Item`, cards linked
  the defining path with a doubled module segment, the workspace page linked
  `./crate`. All links are now absolute. Intra-doc links (shortcut, reference,
  inline, definitions) resolve through `item.links` to pages, member anchors,
  sibling workspace crates or external rustdoc; unresolvable ones keep their text.
- **Sync path.** `--target-dir` / `$CARGO_TARGET_DIR` are honoured (the target
  was hard-coded); the CLI no longer silently does nothing when started through
  an npm bin symlink; format-version warnings are printed in workspace mode.
- **Signatures.** Synthetic `impl Trait` generic params are hidden;
  `<Self as ?>::Output` renders as `Self::Output`; supertraits and trait where
  clauses are printed; `crate::` is stripped like `$crate::`; trait bounds keep
  associated-type constraints (`Iterator<Item = u8>`).
- **Feature gates.** `not(feature = ...)` was reported as a requirement and the
  `Cargo.toml` snippet said `crate_name`.
- **Sidebar.** Private modules (bin crates document them) no longer reach
  `meta.json`; derive and attribute macros are listed and rendered.
- **Callouts.** `# Panics` / `# Errors` / `# Safety` sections shown as callouts
  are no longer repeated in the body; deprecation titles and notes are escaped.

### Added

- **Feature-gate badges** from `#[doc(cfg(...))]` (with `--cfg docsrs`),
  `#[cfg(...)]` and rustc's `CfgTrace` attributes, with `all` / `any` / `not`,
  inherited from enclosing modules and re-exporting `use` items; impl blocks
  gated beyond their type say so. The snippet names the real package and version.
- **Trait pages**: associated types and constants, required vs provided methods,
  implementors. **Type pages**: every non-blanket trait impl (marker impls such
  as `Copy` included), trait-impl associated items, an auto-trait line.
- **Anchored member headings** (`#method.new`, `#variant.Name`, ...) so methods
  appear in the table of contents and links can target them; docstring headings
  are demoted to nest under the item.
- **Attribute badges** (`#[non_exhaustive]`, `#[must_use]`, `#[repr]`) in
  signatures, stability badges (format 58+), deprecation on members.
- **Source links**: `--source-url-base <url>` and `--source-ref <ref>` link items,
  members and modules to their source lines, and resolve repository-relative
  links in docstrings (dropped to text otherwise, since they would 404).
- **Workspace options**: `--exclude <crates>`; members with `publish = false`
  are skipped unless `--include-unpublished`; each crate is a folder in the
  top-level `meta.json`; cross-crate links between members stay on the site
  (`RustdocGenerator#pageIndex()` / `setExternalPages()`).
- **Doctests**: hidden `# ` lines are dropped (`##` unescapes); bare and
  `rust,ignore`-style fences are tagged `rust`.
- **Rustdoc JSON format 58-60** (Rust 1.98) supported; unknown item fields are
  passed through instead of stripped.
- **Test fixtures** generated from real crates in formats 57 and 60
  (`scripts/gen-fixtures.sh`), a link checker (`tests/helpers/check-output.ts`)
  and an MDX compile test over every generated page.

### Changed

- **Node.js 20+** (`engines.node`); CI tests Node 20, 22 and 24.
- New module `src/docs.ts` (link rewriting, heading demotion, section
  extraction) and `src/cfg.ts` (cfg parsing); `renderCfgCallout` and
  `formatGenericArgs` are exported.

### Added before 0.4.0 work (previously unreleased)

- **MDX-safe docstring sanitization**: new `sanitizeDocstring()` export runs at generator construction time against every `item.docs`, struct/union field `docs`, and enum variant `docs`. Two passes, code-fence aware:
  1. Outside fenced code blocks, escapes patterns MDX would mistake for JSX: URL autolinks (`<https://…>`, `<mailto:…>`), Rust generic placeholders in prose (`Opaque<T>`, `Sealed<K, V>`), metasyntactic `<word>` (e.g. `<encoding>`), and `<` before a digit. Inline `` ` … ` `` spans and a conservative whitelist of safe inline HTML tags (`<kbd>`, `<sub>`, `<br>`, …) are preserved. JSX tags with attributes (`<Tab value="…">`) pass through untouched.
  2. Rewrites rustdoc doctest-directive fence langs (`compile_fail`, `ignore`, `no_run`, `should_panic`, `edition20{15,18,21,24}`) to `rust` with the directive preserved as a `title="…"` attribute so the intent stays visible and Shiki can resolve the lang.
     Idempotent. Ported from a downstream sync pipeline so every consumer benefits without reimplementing the filters.

- 14 unit tests for `sanitizeDocstring` covering plain prose, autolinks, generics, fenced blocks, doctest-directive rewrites, safe-tag preservation, JSX pass-through, and idempotency.

## 0.3.1 - 2026-04-20

### Added

- **Cargo workspace mode** (`--workspace [dir]`, alias `-w`): generate docs for every member of a workspace in one run. Each member's output lives in `<output>/<crate_name>/`; a top-level `index.mdx` and `meta.json` link them. Supports the `crates/*` glob form and the `exclude` list.
- **Async CLI I/O**: `src/cli.ts` uses `fs/promises` with bounded parallelism (16 concurrent writes) to avoid blocking the event loop and EMFILE on large crates.
- **Testable `run()` entrypoint**: `parseArgs(argv)`, `run(argv, streams)`, and a `CliStreams` interface let the CLI be unit-tested without spawning a subprocess.

### Changed

- **Error handling**: `generate()` throws structured `RustdocError` with codes, hints, and context.
- **Warnings**: Missing item references include module context and summary counts; warning volume capped at `MAX_WARNINGS=100`.
- **Implementation filtering**: `getImplementations()` split into focused helpers.
- **Path sanitization**: Empty segments become `"unnamed"`; Unicode normalization applied; truncated to 255 bytes preserving the extension.
- **Tab content indentation**: Reduced from 4 spaces to 0 so MDX doesn't render tab bodies as code blocks.
- **Feature-gate extraction**: Also matches `cfg_attr(feature = "…")` and the negated form.

### Fixed

- **Rustdoc format v57 rendering**: The `Path.name` → `Path.path` rename made every resolved type render as the literal string `undefined`. A new `getPathName()` helper reads either field.
- **Idiomatic `&self`**: Function signatures render `&self` / `&'a self` / `&mut self` instead of `self: &Self`.
- **No space before `(`**: `fn encode(x: T)` instead of `fn encode (x: T)`.
- **Trait generic args on impl headers**: `impl From<T> for U` is now preserved instead of being truncated to `impl From for U`.
- **Negative trait impls**: `impl !Send for T` was silently dropping the `!`.
- **`?Sized` / `~const` modifiers** are preserved in trait bounds.
- **Const generics and default generic parameters** render with their types and defaults (`<const N: usize>`, `<T: Clone = String>`).
- **Higher-ranked trait bounds (`for<'a>`)** are preserved on function pointers, `dyn Trait`, and where-clause predicates.
- **Never primitive** renders as `!` instead of the literal string `never`.
- **`$crate::` prefixes** from derive-macro expansions are stripped (e.g. `$crate::fmt::Formatter` → `fmt::Formatter`).
- **Lifetime outlives bounds** inside `<…>` are preserved (`<'a: 'b>`).
- **Cross-reference completeness**: `collectTypeReferences()` now recurses into `qualified_path.args`, `qualified_path.trait.args`, `impl Trait` / `dyn Trait` generic args, and associated-type equality constraints. Previously a type that appeared only inside `<T as Trait<U>>::Assoc` would drop `U` and `Trait`.
- **`mkdir` errors** in `writeFilesParallel` are wrapped as `OUTPUT_WRITE_FAILED` instead of surfacing as uncaught EACCES.
- **Silent skipping in `processModule()`**: now warns when encountering non-module items with meaningful content.
- **Root module validation**: string conversion for format v56+ numeric IDs.
- **Field type fallback**: returns `"unknown"` with warning instead of `"..."` for unexpected structures.
- **`VisibilitySchema`**: accepts both string and numeric IDs for `restricted.parent`.
- **Windows path handling**: `validateOutputPath()` uses `path.sep` for the prefix-attack guard.
- **`Cargo.toml` crate-name regex**: supports both single and double quotes.
- **Type reference depth**: `collectTypeReferences()` caps at `MAX_TYPE_DEPTH=50` to prevent stack overflow.
- **Circular modules**: `processModule()` tracks visited modules and warns.
- **Empty `sanitizePath` result**: returns `"unnamed"` when sanitization yields an empty string (e.g. `"../../"`).

### Security

- **Log-injection guard**: `RustdocGenerator.warn()` strips ANSI escape sequences and ASCII control bytes from messages, so crate or item names from rustdoc JSON can't manipulate the user's terminal or forge log lines.
- **Workspace member escape**: `expandMemberPattern()` refuses absolute paths so a malformed manifest can't escape the workspace root.
- **Per-member size cap**: Workspace mode enforces the same `MAX_INPUT_SIZE_BYTES` (100 MB) cap per member as the single-crate path.
- **Frontmatter safety**: Top-level workspace `index.mdx` frontmatter uses the `yaml` package; markdown inline-code spans escape backticks; member link hrefs are URI-encoded.

## 0.2.0 - 2026-02-04

### Added

- **FumaDocs v14+ compatibility**: Full support for modern FumaDocs features
  - Icon fields in frontmatter (maps item kinds to lucide-react icons)
  - Separators in meta.json (`---Structs---`, `---Functions---`, etc.)
  - `defaultOpen: true` for expandable navigation sections
- **Callout components**: Deprecation warnings now use `<Callout type="warn">` instead of blockquotes
- **JSDoc documentation**: Comprehensive documentation on all public APIs
- **Graceful unknown type handling**: `getItemKind()` returns `"unknown"` instead of throwing, enabling forward compatibility with new rustdoc versions

### Fixed

- **Broken links in kind mode**: Module index links now correctly point to `./structs#itemname` instead of `./itemname` when using `--group-by kind`
- **YAML frontmatter escaping**: Now uses the `yaml` npm package for proper escaping of special characters (colons, newlines, quotes, etc.)
- **1-tuple formatting**: Single-element tuples now render as `(T,)` instead of `(T)`
- **dyn_trait rendering**: Now includes lifetime bounds (`dyn Trait + 'a`) and generic arguments
- **Associated type constraints**: Types like `Iterator<Item = T>` now render correctly
- **Parenthesized generics**: Fn traits now render as `Fn(A, B) -> C` instead of `Fn`
- **Pattern types**: `pat` type variant now renders (unstable Rust feature)

### Changed

- meta.json now includes `icon: "Folder"` and `defaultOpen: true` by default
- Frontmatter uses double-quoted YAML strings for safety
- Default frontmatter now includes `icon` field based on item kind

## 0.1.0 - 2026-02-04

### Added

- Initial release with full rustdoc JSON to Fumadocs MDX conversion
- Support for structs, unions, enums, traits, functions, type aliases, constants, statics, and macros
- Three grouping modes: `module` (default), `kind`, and `flat`
- Module index pages with table of contents by item kind
- `meta.json` generation for Fumadocs navigation
- CLI with argument parsing and validation
- Programmatic API via `RustdocGenerator` class
- Auto-detection of crate name from `Cargo.toml`

### Fixed

- Generic argument rendering now properly displays type parameters (e.g., `Option<T>` instead of `Option`)
- Proc macro type detection now correctly identifies `attr`, `derive`, and `bang` macros
- Constants and statics now display actual types instead of `_` placeholder
- Constants now display actual values (e.g., `"→"` instead of `undefined`)
- CLI arguments with missing values now produce helpful error messages instead of undefined behavior
- `--group-by` flag validates input values and provides clear error for invalid modes
- JSON parsing errors now have proper try-catch handling with validation
- Blanket and synthetic implementations are filtered out to avoid `undefined` noise
- Empty impl blocks are filtered to reduce clutter
- `impl_trait` bounds now render with `impl Trait` syntax
- `dyn_trait` now renders with `dyn Trait` syntax
- Qualified paths now properly format as `<Type as Trait>::Name`
- Union implementations are now properly retrieved

### Implementation Notes

- Targets rustdoc JSON format version 56-57 (Rust 1.85+)
- TypeScript types mirror the `rustdoc_json_types` crate
- Discriminated unions used for `ItemInner` and `Type` representations
- Defensive handling for const generic arguments with version compatibility
