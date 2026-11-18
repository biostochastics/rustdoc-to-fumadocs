# Rustdoc fixtures

- `minimal.json` is a small hand-authored input for unit tests.
- `crates/` contains the Rust sources for the re-export, kitchen-sink, and procedural-macro fixtures. From the repository root, run `bash scripts/gen-fixtures.sh v60` with Rust 1.98 or select Rust 1.94 with `CARGO_TOOLCHAIN=1.94 bash scripts/gen-fixtures.sh v57` and a rustup-managed Cargo. The pruning script checks the emitted format against the snapshot filename.
- `layout_cases.rs` exercises private members, re-exports, name collisions, conditional APIs, and external links. Its final comment gives the rustdoc and pruning commands. Regenerate both the format 57 and 60 snapshots when changing its API.
- `compat/lib.rs` is shared by the toolchain matrix. Its snapshots come from Rust 1.76 (format 27), 1.83 (35), and 1.100 (61). Run `npm run test:rust` to generate fresh JSON, compile all three layouts, and check signatures and links. Set `RUSTDOC=/path/to/rustdoc` to select a compiler. To refresh a snapshot, run the rustdoc command in `scripts/test-rust.sh` and pass the JSON through `scripts/prune-fixture.py`.

## Third-party crates

```sh
npm run test:crates -- itoa@1.0.18 serde_core syn
RUSTDOC_JSON_DIR=tests/fixtures/real-crates npm run test:crates -- itoa serde_core
```

The first command creates temporary Cargo projects, documents the named dependency, converts its JSON, compiles the generated pages, and checks internal links. An explicit release selects that exact version. The second command reads existing files such as `tests/fixtures/real-crates/itoa.json`. Cached inputs are ignored by Git.
