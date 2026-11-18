/**
 * What appears in the sidebar: public modules only, and every kind of
 * public item including procedural macros.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FORMATS, generateFixture, fileMap, metaPages } from "../helpers/fixtures.js";
import { RustdocGenerator } from "../../src/generator.js";
import { validateRustdocJson } from "../../src/validation.js";

describe.each(FORMATS)("proc macros (%s)", (format) => {
  const files = fileMap(generateFixture("kitchen_derive", format));

  it("gives derive, attribute and function-like macros a page and a sidebar entry", () => {
    const meta = metaPages(files, "kitchen_derive/meta.json");
    expect(meta).toEqual(
      expect.arrayContaining([
        "---Macros---",
        "tap",
        "---Derive Macros---",
        "Kitchen",
        "---Attribute Macros---",
        "sink",
      ])
    );
    expect(files.get("kitchen_derive/Kitchen.mdx")).toContain("#[derive(Kitchen)]");
    expect(files.get("kitchen_derive/Kitchen.mdx")).toContain("#[kitchen]");
    expect(files.get("kitchen_derive/sink.mdx")).toContain("#[sink]");
    expect(files.get("kitchen_derive/tap.mdx")).toContain("tap!()");
    expect(files.get("kitchen_derive/index.mdx")).toContain(
      "[`Kitchen`](/docs/api/kitchen_derive/Kitchen)"
    );
  });
});

describe("private modules", () => {
  it("are neither rendered nor listed in meta.json", () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "minimal.json");
    const data = JSON.parse(readFileSync(fixture, "utf-8")) as {
      index: Record<string, Record<string, unknown>>;
    };
    // A bin crate documents private items: add a private module with a
    // public-looking child, as rustdoc does for `--document-private-items`.
    data.index["0:0:0"].inner = {
      module: { is_crate: true, items: ["0:1:0", "0:2:0", "0:3:0", "0:9:0"], is_stripped: false },
    };
    data.index["0:9:0"] = {
      id: "0:9:0",
      crate_id: 0,
      name: "internal",
      span: null,
      visibility: "default",
      docs: "Private.",
      links: {},
      attrs: [],
      deprecation: null,
      inner: { module: { is_crate: false, items: [], is_stripped: false } },
    };
    const { crate } = validateRustdocJson(data);
    const files = fileMap(new RustdocGenerator(crate, { output: "/x", baseUrl: "/d" }).generate());
    expect(metaPages(files, "test_crate/meta.json")).not.toContain("internal");
    expect([...files.keys()].some((p) => p.includes("internal"))).toBe(false);
  });
});
