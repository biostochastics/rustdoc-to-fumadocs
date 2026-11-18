#!/usr/bin/env bash
# Set RUSTDOC to a specific toolchain's rustdoc binary to test it offline.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cd "$repo"
"${RUSTDOC:-rustdoc}" --version
RUSTC_BOOTSTRAP=1 "${RUSTDOC:-rustdoc}" --edition 2021 --crate-name compat --crate-type lib \
  -Z unstable-options --output-format json -o "$out" tests/fixtures/compat/lib.rs
node --import tsx tests/helpers/verify-compat.ts "$out/compat.json"
