import assert from "node:assert/strict";
import { checkOutput, readTree } from "./check-output.js";
import { compileAll } from "./mdx.js";

const files = readTree(process.argv[2]).filter((f) => f.path.endsWith(".mdx"));
assert.ok(files.length, "No generated pages");
assert.deepEqual(await compileAll(files), []);
const result = checkOutput(files);
assert.deepEqual(
  result.broken.filter((b) => b.url.startsWith("/docs/api/")),
  []
);
console.log(`Compiled ${files.length} pages and checked their internal links.`);
