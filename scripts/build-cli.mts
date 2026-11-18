import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

// Keep the CLI at its public bin path and its lazy chunks separate from the
// ESM library modules emitted by tsc. Drop stale chunks on incremental builds.
await rm("dist/cli-chunks", { recursive: true, force: true });
const { metafile } = await build({
  entryPoints: ["src/cli.ts"],
  outdir: "dist",
  chunkNames: "cli-chunks/[name]-[hash]",
  platform: "node",
  target: "node20.19",
  format: "esm",
  bundle: true,
  splitting: true,
  minify: true,
  sourcemap: true,
  sourcesContent: false,
  metafile: true,
  banner: {
    js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);',
  },
});

// Copy the license text for each dependency actually incorporated in the bundle.
const packages = new Set<string>();
for (const file of Object.keys(metafile.inputs)) {
  const directory = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1];
  if (directory) packages.add(directory);
}
const notices: string[] = [];
for (const directory of [...packages].sort()) {
  const files = (await readdir(directory))
    .filter((name) => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name))
    .sort();
  if (!files.length) throw new Error(`Missing bundled dependency notice in ${directory}`);
  for (const file of files) {
    notices.push(`${directory}/${file}\n\n${await readFile(join(directory, file), "utf8")}`);
  }
}
await writeFile("dist/cli-chunks/THIRD-PARTY-NOTICES.txt", notices.join("\n"));
