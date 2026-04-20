# Changelog

All notable changes to rustdoc-to-fumadocs will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **Improved error handling**: `generate()` now throws structured `RustdocError` with codes, hints, and context instead of raw `Error`
- **Better warning messages**: Missing item references now include module context and show summary counts
- **Refactored implementation filtering**: Split complex `getImplementations()` into focused helper methods for better maintainability
- **Enhanced path sanitization**: Empty strings return `"unnamed"`, handles Unicode normalization, and truncates to filesystem limits (255 chars)
- **Centralized kind ordering**: `KIND_ORDER` constant used consistently across module index and meta.json generation
- **Improved type predicates**: Added proper JSDoc and type predicate return types for `isPlainVariant()`, `isUnitStruct()`, etc.
- **Tab content indentation**: Reduced from 4 spaces to 0 to prevent MDX rendering as code blocks
- **Feature gate regex**: Now also matches `cfg_attr(feature = "...")` and `cfg_attr(not(feature = "..."), ...)` patterns

### Fixed

- **Silent skipping in processModule()**: Now warns when encountering non-module items with meaningful content
- **Root module validation**: Uses string conversion for format 56+ numeric ID compatibility
- **Field type fallback**: Returns `"unknown"` instead of `"..."` with warning for unexpected field structures
- **CLI logger in JSON mode**: Structured logger pattern replaces empty function anti-pattern
- **RenderContext ID handling**: `getItem()` and `getPath()` now convert numeric IDs to strings for format v56+ compatibility
- **VisibilitySchema numeric IDs**: Validation now accepts both string and number for `restricted.parent` field
- **Windows path handling**: `validateOutputPath()` now uses `path.sep` instead of hardcoded `/` for cross-platform compatibility
- **Crate name regex**: Auto-detection from `Cargo.toml` now supports both single and double quotes
- **Type reference stack overflow**: `collectTypeReferences()` now has depth limit (`MAX_TYPE_DEPTH=50`) to prevent stack overflow with deeply nested types
- **Circular module references**: `processModule()` now tracks visited modules to detect and warn about circular hierarchies
- **Empty sanitizePath result**: Returns `"unnamed"` if sanitization results in empty string (e.g., `"../../"`)
- **RenderContext warning limit**: Warnings capped at `MAX_WARNINGS=100` to prevent unbounded memory growth

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
