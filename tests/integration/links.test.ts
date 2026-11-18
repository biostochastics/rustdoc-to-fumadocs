/**
 * Link resolution: every link in the generated tree is absolute, points at a
 * generated page (and anchor), and rustdoc intra-doc links are resolved
 * through `item.links`.
 */

import { describe, it, expect } from "vitest";
import { FORMATS, generateFixture, fileMap, loadCrate } from "../helpers/fixtures.js";
import { RustdocGenerator } from "../../src/generator.js";
import { checkOutput } from "../helpers/check-output.js";

describe.each(FORMATS)("links (%s)", (format) => {
  const list = generateFixture("kitchen_sink", format);
  const files = fileMap(list);
  const root = files.get("kitchen_sink/index.mdx") ?? "";
  const widget = files.get("kitchen_sink/Widget.mdx") ?? "";

  it("has no broken, relative or unresolved links anywhere", () => {
    const result = checkOutput(list);
    expect(result.broken).toEqual([]);
    expect(result.relative).toEqual([]);
    expect(result.literalBrackets).toEqual([]);
    expect(result.links).toBeGreaterThan(20);
  });

  it("resolves intra-doc links in module docs", () => {
    expect(root).toContain("[`Widget`](/docs/api/kitchen_sink/Widget)");
    expect(root).toContain("[`shapes`](/docs/api/kitchen_sink/shapes)");
    expect(root).toContain("[`shapes::Circle`](/docs/api/kitchen_sink/shapes/Circle)");
    expect(root).toContain("[`Widget::new`](/docs/api/kitchen_sink/Widget#method.new)");
    expect(root).toMatch(/\[the inline square\]\(\/docs\/api\/kitchen_sink\/shapes\/Square\)/);
    expect(root).toMatch(
      /\[`Vec`\]\(https:\/\/doc\.rust-lang\.org\/[\d.]+\/alloc\/vec\/struct\.Vec\.html\)/
    );
  });

  it("resolves Self:: links and gives methods anchored headings", () => {
    expect(widget).toContain("[`Self::label`](/docs/api/kitchen_sink/Widget#method.label)");
    expect(widget).toMatch(/^#### `label` \[#method\.label\]$/m);
  });

  it("emits absolute card hrefs at the canonical page", () => {
    // leaf_fn returns Leaf; both live in a private module re-exported as `tree`.
    const leafFn = files.get("kitchen_sink/tree/leaf_fn.mdx") ?? "";
    expect(leafFn).toContain('href={"/docs/api/kitchen_sink/tree/Leaf"}');
  });
});

describe.each(FORMATS)("repository-relative and cross-crate links (%s)", (format) => {
  it("drops repository-relative doc links when no source URL is configured", () => {
    const page = fileMap(generateFixture("kitchen_sink", format)).get("kitchen_sink/apply.mdx");
    expect(page).toContain("Background: the spec and the\nusage notes.");
  });

  it("resolves repository-relative doc links against the source file", () => {
    const page = fileMap(
      generateFixture("kitchen_sink", format, {
        sourceUrlBase: "https://github.com/o/r",
        sourceRef: "v1",
      })
    ).get("kitchen_sink/apply.mdx");
    expect(page).toContain("[the spec](https://github.com/o/r/blob/v1/docs/spec.md)");
    expect(page).toContain("[usage notes](https://github.com/o/r/blob/v1/README.md#usage)");
  });

  it("links re-exports of sibling-crate items to the sibling's page", () => {
    const crate = loadCrate(`kitchen_sink.${format}.json`);
    const gen = new RustdocGenerator(crate, { output: "/tmp/x", baseUrl: "/docs/api" });
    expect(gen.pageIndex().get("kitchen_sink::shapes::Circle")).toBe(
      "/docs/api/kitchen_sink/shapes/Circle"
    );
    gen.setExternalPages(
      new Map([["alloc::collections::btree::map::BTreeMap", "/docs/api/alloc/BTreeMap"]])
    );
    const root = fileMap(gen.generate()).get("kitchen_sink/index.mdx") ?? "";
    expect(root).toContain("[`BTreeMap`](/docs/api/alloc/BTreeMap)");
  });
});
