/**
 * Re-export handling (`use` items). rustdoc JSON represents
 * `pub use path::Item;` as a nameless item whose target lives in
 * `inner.use`; items defined in private modules are only reachable
 * through such re-exports and must get pages at the re-export path.
 */

import { describe, it, expect } from "vitest";
import { FORMATS, generateFixture, fileMap, metaPages } from "../helpers/fixtures.js";

describe.each(FORMATS)("re-exports (%s)", (format) => {
  it("emits a page for an item re-exported from a private module", () => {
    const files = fileMap(generateFixture("reexport", format));
    expect(files.has("reexport/Foo.mdx")).toBe(true);
    expect(files.get("reexport/Foo.mdx")).toContain("struct Foo");
    expect(metaPages(files, "reexport/meta.json")).toContain("Foo");
    expect(files.get("reexport/index.mdx")).toContain("[`Foo`](/docs/api/reexport/Foo)");
  });

  describe("kitchen_sink", () => {
    const files = fileMap(generateFixture("kitchen_sink", format));
    const root = files.get("kitchen_sink/index.mdx") ?? "";
    const rootMeta = metaPages(files, "kitchen_sink/meta.json");

    it("inlines items from private modules at the re-export path", () => {
      expect(files.has("kitchen_sink/Foo.mdx")).toBe(true);
      expect(rootMeta).toContain("Foo");
    });

    it("uses the re-export name for renamed re-exports", () => {
      const page = files.get("kitchen_sink/RenamedThing.mdx");
      expect(page).toBeDefined();
      expect(page).toContain("struct RenamedThing");
      expect(page).toContain('title: "RenamedThing"');
      expect(files.has("kitchen_sink/Original.mdx")).toBe(false);
    });

    it("inlines glob re-exports from private modules", () => {
      expect(files.has("kitchen_sink/glob_fn.mdx")).toBe(true);
      expect(files.has("kitchen_sink/GlobStruct.mdx")).toBe(true);
      expect(rootMeta).toEqual(expect.arrayContaining(["glob_fn", "GlobStruct"]));
    });

    it("inlines a private module re-exported under a public name", () => {
      expect(files.has("kitchen_sink/tree/index.mdx")).toBe(true);
      expect(files.has("kitchen_sink/tree/Leaf.mdx")).toBe(true);
      expect(files.has("kitchen_sink/tree/leaf_fn.mdx")).toBe(true);
      expect(rootMeta).toContain("tree");
    });

    it("lists re-exports of public items on the module page without duplicating them", () => {
      // `pub use shapes::Circle;` — Circle already has a page under shapes/.
      expect(files.has("kitchen_sink/shapes/Circle.mdx")).toBe(true);
      expect(files.has("kitchen_sink/Circle.mdx")).toBe(false);
      expect(root).toContain("## Re-exports");
      expect(root).toMatch(/\[`Circle`\]\(\/docs\/api\/kitchen_sink\/shapes\/Circle\)/);
    });

    it("inlines #[doc(inline)] re-exports even when the target is public", () => {
      expect(files.has("kitchen_sink/InlineSquare.mdx")).toBe(true);
      expect(files.has("kitchen_sink/shapes/Square.mdx")).toBe(true);
    });

    it("links external re-exports out to their documentation", () => {
      expect(root).toMatch(/\[`BTreeMap`\]\(https:\/\/doc\.rust-lang\.org\/[^)]*BTreeMap\.html\)/);
    });

    it("never emits private modules", () => {
      expect([...files.keys()].some((p) => p.startsWith("kitchen_sink/globbed/"))).toBe(false);
      expect([...files.keys()].some((p) => p.startsWith("kitchen_sink/m/"))).toBe(false);
      expect(rootMeta).not.toContain("globbed");
    });
  });
});
