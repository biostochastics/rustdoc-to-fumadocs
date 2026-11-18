#!/usr/bin/env bash
# Exercise both public entry points from a clean installation of the packed tarball.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$repo"
mkdir "$tmp/consumer"
npm pack --pack-destination "$tmp"
npm install --prefix "$tmp/consumer" --no-audit --no-fund "$tmp"/*.tgz
cmp llms.txt "$tmp/consumer/node_modules/rustdoc-to-fumadocs/llms.txt"

fixture="$repo/tests/fixtures/minimal.json"
version="$(node -p "require('./package.json').version")"
cd "$tmp/consumer"
cli="node_modules/.bin/rustdoc-to-fumadocs"
test "$("$cli" --version)" = "$version"
"$cli" "$fixture" --list-files --json > paths.json
"$cli" "$fixture" --json > preview.json
node --input-type=module - "$fixture" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RustdocGenerator } from 'rustdoc-to-fumadocs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const { paths } = readJson('paths.json');
assert.ok(paths.length > 0);
assert.deepEqual(paths, readJson('preview.json').files.map(file => file.path));
const generator = new RustdocGenerator(readJson(process.argv[2]), { output: '', baseUrl: '/docs/api' });
assert.deepEqual([...generator.filePaths()], paths);
JS
