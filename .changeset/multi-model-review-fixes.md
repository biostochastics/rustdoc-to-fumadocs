---
"rustdoc-to-fumadocs": patch
---

Fix multiple issues identified by multi-model code review:

- **RenderContext ID handling**: `getItem()` and `getPath()` now convert numeric IDs to strings for format v56+ compatibility
- **VisibilitySchema numeric IDs**: Validation now accepts both string and number for `restricted.parent` field
- **Windows path handling**: `validateOutputPath()` uses `path.sep` for cross-platform compatibility
- **Tab content indentation**: Reduced from 4 spaces to 0 to prevent MDX rendering as code blocks
- **Crate name regex**: Auto-detection from `Cargo.toml` now supports both single and double quotes
- **Type reference depth limit**: `collectTypeReferences()` has `MAX_TYPE_DEPTH=50` to prevent stack overflow
- **Circular module detection**: `processModule()` tracks visited modules to detect circular hierarchies
- **Feature gate regex**: Now matches `cfg_attr(feature = "...")` patterns
- **Empty sanitizePath handling**: Returns `"unnamed"` if sanitization results in empty string
- **RenderContext warning limit**: Warnings capped at `MAX_WARNINGS=100` to prevent unbounded memory growth
