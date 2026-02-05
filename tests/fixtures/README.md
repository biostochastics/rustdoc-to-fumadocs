# Test Fixtures

This directory contains rustdoc JSON files for testing.

## Files

- `minimal.json` - Minimal valid rustdoc JSON (format v57) for basic unit tests
- `real-crates/` - Directory for rustdoc JSON from real public crates (gitignored)

## Generating Test Fixtures

### From resume-factory itself

```bash
cd /path/to/resume-factory
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps
cp target/doc/resume_factory.json tools/rustdoc-to-fumadocs/tests/fixtures/real-crates/
```

### From popular crates

Use the test script:

```bash
./scripts/test-real-crates.sh serde anyhow thiserror
```

This will:

1. Create temporary Cargo projects
2. Add each crate as a dependency
3. Generate rustdoc JSON
4. Cache the JSON in `tests/fixtures/real-crates/`
5. Run the converter and report results

### Manual generation

```bash
# Create a temp project
cargo new test-fixture --lib
cd test-fixture
cargo add serde

# Generate rustdoc JSON
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps

# Copy to fixtures
cp target/doc/serde.json /path/to/fixtures/real-crates/
```

## Real Crate Testing

The `real-crates/` directory is gitignored because:

1. These files can be large (1-50MB)
2. They should be regenerated locally for testing
3. Different Rust versions produce different format versions

Recommended crates for comprehensive testing:

| Crate       | Size  | Complexity | Good For Testing                |
| ----------- | ----- | ---------- | ------------------------------- |
| `serde`     | Large | High       | Traits, generics, derive macros |
| `anyhow`    | Small | Medium     | Error types, traits             |
| `thiserror` | Small | Low        | Derive macros, enums            |
| `tokio`     | Huge  | Very High  | Async, modules, features        |
| `clap`      | Large | High       | Derive, builders                |
