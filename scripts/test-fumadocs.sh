#!/usr/bin/env bash
# Build an isolated Next.js site containing actual generator output.
# FUMADOCS_TEST_DIR may point at a dedicated directory with the matrix dependencies installed.
set -euo pipefail
major="${1:-16}"
case "$major" in
  14|15) next=15 ;;
  16|latest) next=16 ;;
  *) echo "Expected 14, 15, 16, or latest" >&2; exit 2 ;;
esac
repo="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "${FUMADOCS_TEST_DIR:-}" ]]; then
  site="$FUMADOCS_TEST_DIR"
else
  site="$(mktemp -d)"
  trap 'rm -rf "$site"' EXIT
  echo '{"private":true,"type":"module"}' > "$site/package.json"
  deps=("fumadocs-core@$major" "fumadocs-ui@$major" "next@$next" react@19 react-dom@19 @mdx-js/mdx@3 remark-gfm@4)
  if [[ "$next" == 16 ]]; then deps+=(fumadocs-mdx@latest); fi
  npm install --prefix "$site" --no-audit --no-fund "${deps[@]}"
fi
mkdir -p "$site/content/guides"
cp "$repo/tests/compat/first-request.mdx" "$site/content/guides/first-request.mdx"
node "$repo/dist/cli.js" --input "$repo/tests/fixtures/kitchen_sink.v60.json" --output "$site/content/api"
cp "$repo/tests/compat/fumadocs.mjs" "$site/verify.mjs"
cd "$site"
node verify.mjs
if [[ "$next" == 16 ]]; then
  NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build --webpack
else
  NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build
fi
node verify.mjs --check
