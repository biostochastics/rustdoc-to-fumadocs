# Changelog

All notable changes to rustdoc-to-fumadocs will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **MDX-safe docstring sanitization**: new `sanitizeDocstring()` export runs at generator construction time against every `item.docs`, struct/union field `docs`, and enum variant `docs`. Two passes, code-fence aware:
  1. Outside fenced code blocks, escapes patterns MDX would mistake for JSX: URL autolinks (`<https://…>`, `<mailto:…>`), Rust generic placeholders in prose (`Opaque<T>`, `Sealed<K, V>`), metasyntactic `<word>` (e.g. `<encoding>`), and `<` before a digit. Inline `` ` … ` `` spans and a conservative whitelist of safe inline HTML tags (`<kbd>`, `<sub>`, `<br>`, …) are preserved. JSX tags with attributes (`<Tab value="…">`) pass through untouched.
  2. Rewrites rustdoc doctest-directive fence langs (`compile_fail`, `ignore`, `no_run`, `should_panic`, `edition20{15,18,21,24}`) to `rust` with the directive preserved as a `title="…"` attribute so the intent stays visible and Shiki can resolve the lang.
     Idempotent. Ported from a downstream sync pipeline so every consumer benefits without reimplementing the filters.

### Tests

- 14 new unit tests for `sanitizeDocstring` covering plain prose, autolinks, generics, fenced blocks, doctest-directive rewrites, safe-tag preservation, JSX pass-through, and idempotency. Total: 299 tests.

## [0.3.1] - 2026-04-20

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

## [0.2.0] - 2026-02-04

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

## [0.1.0] - 2026-02-04

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
