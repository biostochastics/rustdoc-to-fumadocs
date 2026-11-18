#!/usr/bin/env bash
# Regenerate the committed rustdoc JSON fixtures from tests/fixtures/crates/*.
#
# Usage: scripts/gen-fixtures.sh <format-tag> [cargo]
#   format-tag  suffix for the output file, e.g. v57 or v60
#   cargo       cargo binary to use (default: cargo on PATH)
# Env: CARGO_TOOLCHAIN=1.94 selects a rustup toolchain (`cargo +1.94`).
#
# The toolchain decides the rustdoc JSON format_version: Rust 1.94 emits 57,
# Rust 1.98 emits 60. RUSTC_BOOTSTRAP=1 lets a stable toolchain emit JSON.
# Output: tests/fixtures/<crate>.<format-tag>.json, with the `paths` table
# pruned to the ids the index actually references (keeps fixtures small).
set -euo pipefail
tag="${1:?format tag, e.g. v57}"
cargo_bin="${2:-cargo}"
root="$(cd "$(dirname "$0")/.." && pwd)"
target="$(mktemp -d)"
trap 'rm -rf "$target"' EXIT
gen() {
  local dir="$1" name="$2"
  shift 2
  (cd "$root/tests/fixtures/crates/$dir" &&
    CARGO_TARGET_DIR="$target" RUSTC_BOOTSTRAP=1 \
    RUSTDOCFLAGS="-Z unstable-options --output-format json --cfg docsrs" \
    "$cargo_bin" ${CARGO_TOOLCHAIN:+"+$CARGO_TOOLCHAIN"} doc --no-deps --quiet "$@")
  python3 "$root/scripts/prune-fixture.py" "$target/doc/$name.json" \
    "$root/tests/fixtures/$name.$tag.json"
}
gen reexport reexport
gen kitchen_sink kitchen_sink --features extra,fancy
gen kitchen_derive kitchen_derive
