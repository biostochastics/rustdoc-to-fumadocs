---
"rustdoc-to-fumadocs": minor
---

**Rustdoc format v57 compatibility, signature correctness, Cargo workspace mode.**

### Added

- `--workspace [dir]` (alias `-w`) processes every member of a Cargo workspace in one run, writing each member's docs into a subdirectory of `--output` and emitting a top-level `index.mdx` and `meta.json` that link them together. Supports the `crates/*` glob form used by `[workspace].members` and honors the `exclude` list.
- CLI flow extracted into a reusable `writeAndReport()` helper shared between single-crate and workspace paths (dry-run, JSON output, parallel writes, progress).

### Fixed

- **Rendering under rustdoc format v57.** The `Path.name` field was renamed to `Path.path` in v57, which made every resolved type render as the literal string `undefined` (e.g. `impl undefined for undefined`). A new `getPathName()` helper reads either field.
- **Signatures now use idiomatic Rust.** `self: &Self` renders as `&self` (and `&'a self` / `&mut self`), and the spurious space between function name and argument list (`fn encode (x: T)` → `fn encode(x: T)`) is gone.
- **Trait generic args in impl headers** are preserved: `impl From for uuid::Uuid` → `impl From<UuidV7Id<K, E>> for uuid::Uuid`.
- **Negative trait implementations**: `impl !Send for T` was rendering without the `!`, inverting its meaning.
- **`?Sized` and `~const` trait-bound modifiers** are now emitted; previously they were silently dropped.
- **Const generics and default generic parameters** render with their types and defaults (`<const N: usize>`, `<T: Clone = String>`).
- **Higher-ranked trait bounds** (`for<'a>`) are preserved on function pointers, `dyn Trait`, and where-clause predicates.
- **The never primitive** renders as `!`.
- **`$crate::` macro-expansion prefixes** are stripped from paths (e.g. `$crate::fmt::Formatter` → `fmt::Formatter`).
- **Lifetime parameter outlives bounds** inside `<…>` are preserved (`<'a: 'b>` instead of `<'a>`).
- **`mkdir` failures** during bulk writes are now wrapped as `OUTPUT_WRITE_FAILED` so the CLI exits cleanly on an unwritable output tree instead of panicking.
- **Validation** accepts both string and numeric IDs in `Visibility::restricted.parent` (needed for format v56+).
- **Tab content indentation** reduced from 4 spaces to 0 so MDX doesn't render tab bodies as code blocks.
- **Auto-detection** from `Cargo.toml` accepts both `name = "foo"` and `name = 'foo'`.
- **`sanitizePath()`** returns `"unnamed"` when sanitization leaves an empty segment.
- **`collectTypeReferences()`** has a `MAX_TYPE_DEPTH=50` depth guard.
- **`processModule()`** tracks visited modules to detect circular hierarchies.
- **Feature-gate extraction** also matches `cfg_attr(feature = "…")` and the negated form.
- **`RenderContext.warn()`** caps at `MAX_WARNINGS=100` to bound memory growth.

### Security

- **Log-injection guard.** Warning messages from rustdoc JSON may embed untrusted content (crate names, item paths, docstrings); `RustdocGenerator.warn()` now strips ASCII control bytes and ANSI escape sequences before writing to stderr.
- **Workspace member patterns** starting with `/` are refused in `expandMemberPattern()` so a malformed manifest can't escape the workspace root.
- **Per-member rustdoc JSONs** are size-guarded against `MAX_INPUT_SIZE_BYTES` in workspace mode, matching the single-crate path.
- **Top-level workspace `index.mdx` frontmatter** uses the `yaml` package instead of string interpolation, so crate or workspace names containing `"`, `:`, or newlines can't produce malformed MDX. Markdown inline-code spans escape backticks; link hrefs are URI-encoded.
