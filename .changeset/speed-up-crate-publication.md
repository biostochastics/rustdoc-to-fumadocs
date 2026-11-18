---
"rustdoc-to-fumadocs": patch
---

Speed up Markdown summaries, rustdoc validation, and first publication of a crate. Preserve pages across filename capitalization changes and clean up newly created directories when publication fails. Detect conflicting edits during case-only renames, enforce input size limits during reads, and handle renamed binaries and invalid glob-matched members when Cargo metadata is unavailable.
