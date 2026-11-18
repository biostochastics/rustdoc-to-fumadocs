/**
 * Signature rendering against real rustdoc JSON (formats 57 and 60), plus
 * unit cases for the forms the fixtures cannot express.
 */

import { describe, it, expect } from "vitest";
import { FORMATS, generateFixture, fileMap } from "../helpers/fixtures.js";
import { formatTraitSignature } from "../../src/renderer/signatures.js";
import { formatType, formatGenericBound } from "../../src/renderer/types.js";
import { getPathName, type Trait } from "../../src/types.js";

describe.each(FORMATS)("signatures (%s)", (format) => {
  const files = fileMap(generateFixture("kitchen_sink", format));

  it("hides synthetic generic params of `impl Trait` arguments", () => {
    const widget = files.get("kitchen_sink/Widget.mdx") ?? "";
    expect(widget).toContain("fn new(name: impl Into<String>) -> Self");
    expect(widget).not.toContain("<impl Into<String>");
    const apply = files.get("kitchen_sink/apply.mdx") ?? "";
    expect(apply).toContain(
      "fn apply<F>(f: F, value: impl AsRef<str>) -> usize where F: Fn(&str) -> usize"
    );
  });

  it("prints supertraits and renders Self::Assoc without a trait", () => {
    const shape = files.get("kitchen_sink/Shape.mdx") ?? "";
    expect(shape).toMatch(/trait Shape: (core::fmt::|fmt::)?Debug \+ Clone \{ \.\.\. \}/);
    expect(shape).toContain("fn area(&self) -> Self::Output");
    expect(shape).not.toContain("as ?>");
  });
});

describe("type rendering edge cases", () => {
  it("renders a trait-less qualified path as Self::Name with args", () => {
    expect(
      formatType({
        qualified_path: {
          name: "Item",
          args: { angle_bracketed: { args: [{ lifetime: "'a" }], constraints: [] } },
          self_type: { generic: "Self" },
          trait: undefined,
        },
      })
    ).toBe("Self::Item<'a>");
  });

  it("strips crate:: as well as $crate:: from paths", () => {
    expect(getPathName({ path: "crate::error::ParseError", id: 1 })).toBe("error::ParseError");
    expect(getPathName({ path: "$crate::fmt::Formatter", id: 1 })).toBe("fmt::Formatter");
  });

  it("keeps associated-type constraints in trait bounds", () => {
    expect(
      formatGenericBound({
        trait_bound: {
          trait: {
            path: "Iterator",
            id: 1,
            args: {
              angle_bracketed: {
                args: [],
                constraints: [
                  {
                    name: "Item",
                    args: { angle_bracketed: { args: [], constraints: [] } },
                    binding: { equality: { type: { primitive: "u8" } } },
                  },
                ],
              },
            },
          },
          generic_params: [],
          modifier: "none",
        },
      })
    ).toBe("Iterator<Item = u8>");
  });

  it("prints supertraits in trait signatures", () => {
    const trait: Trait = {
      is_auto: false,
      is_unsafe: false,
      is_dyn_compatible: true,
      items: [],
      generics: { params: [], where_predicates: [] },
      bounds: [
        {
          trait_bound: {
            trait: { path: "Clone", id: 1 },
            generic_params: [],
            modifier: "none",
          },
        },
        { outlives: "'static" },
      ],
      implementations: [],
    };
    expect(formatTraitSignature("Shape", trait)).toBe("trait Shape: Clone + 'static { ... }");
  });
});
