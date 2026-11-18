import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RustdocGenerator, validateRustdocJson } from "../../src/index.js";
import { checkOutput } from "./check-output.js";
import { compileAll } from "./mdx.js";

/** Exercise actual rustdoc input and all supported layouts with semantic checks. */
export async function verifyCompatibility(path: string): Promise<number> {
  const { crate } = validateRustdocJson(JSON.parse(readFileSync(path, "utf8")));
  for (const groupBy of ["module", "kind", "flat"] as const) {
    const generator = new RustdocGenerator(crate, { output: "", baseUrl: "/docs/api", groupBy });
    const files = generator.generate();
    const body = files
      .filter((f) => f.path.endsWith(".mdx"))
      .map((f) => f.content)
      .join("\n");
    const overview = files.find((file) => file.path === "compat/index.mdx")?.content ?? "";
    assert.ok(overview.includes("A literal"), "missing crate-level //! documentation");
    assert.ok(
      overview.includes("Use this crate to carry a value between calls."),
      "missing included README"
    );
    assert.ok(
      files.some((file) =>
        file.content.includes(
          "```rust\nuse compat::Carrier;\nassert_eq!(Carrier(7).value(), 7);\n```"
        )
      ),
      "missing item doctest"
    );
    for (const text of [
      'unsafe extern "C" fn(i32) -> i32',
      "dyn Fn(u32) -> bool",
      "fn value(&self) -> T",
      "PublicStatus",
      "VERSION",
      "LIMIT",
      "Iterator<Item = &'a str>",
      "where 'a: 'b",
    ]) {
      assert.ok(body.includes(text), `format ${crate.format_version} (${groupBy}) missing ${text}`);
    }
    assert.deepEqual(await compileAll(files), []);
    assert.deepEqual(checkOutput(files).broken, []);
  }
  return crate.format_version;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log("Verified rustdoc format", await verifyCompatibility(process.argv[2]));
}
