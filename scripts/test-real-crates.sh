#!/usr/bin/env bash
# Use prebuilt <crate>.json files via RUSTDOC_JSON_DIR, or let Cargo fetch the named packages.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$repo"
npm run build --silent
if [[ "$#" -eq 0 ]]; then set -- itoa serde_core smallvec; fi
for spec in "$@"; do
  crate="${spec%%@*}"
  if [[ ! "$crate" =~ ^[A-Za-z0-9_-]+$ ]]; then echo "Invalid package name: $crate" >&2; exit 2; fi
  if [[ -n "${RUSTDOC_JSON_DIR:-}" ]]; then
    input="$RUSTDOC_JSON_DIR/${crate//-/_}.json"
  else
    project="$(mktemp -d "$tmp/member.XXXXXX")"
    cargo init --lib --name smoke_consumer --vcs none --quiet "$project"
    requirement="$spec"
    if [[ "$spec" == *@* && "${spec#*@}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
      requirement="$crate@=${spec#*@}"
    fi
    cargo add --manifest-path "$project/Cargo.toml" "$requirement"
    selection="$(cargo metadata --format-version 1 --manifest-path "$project/Cargo.toml" | python3 -c '
import json, sys
d=json.load(sys.stdin)
root=next(n for n in d["resolve"]["nodes"] if n["id"]==d["resolve"]["root"])
package=next(p for p in d["packages"] if p["id"]==root["deps"][0]["pkg"])
lib=next(t for t in package["targets"] if t["doc"] and any(k in ("lib","rlib","proc-macro") for k in t["kind"]))
print(package["name"]+"@"+package["version"],lib["name"])
')"
    read -r package lib <<< "$selection"
    RUSTC_BOOTSTRAP=1 RUSTDOCFLAGS="-Z unstable-options --output-format json" \
      cargo doc --manifest-path "$project/Cargo.toml" --target-dir "$tmp/target" --no-deps -p "$package"
    input="$tmp/target/doc/${lib//-/_}.json"
  fi
  output="$(mktemp -d "$tmp/pages.XXXXXX")"
  node dist/cli.js --input "$input" --output "$output"
  node --import tsx tests/helpers/verify-pages.ts "$output"
done
