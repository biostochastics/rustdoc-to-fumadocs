/**
 * Every generated page must compile as MDX without any post-processing by
 * the consuming site.
 */

import { describe, it, expect } from "vitest";
import { FORMATS, generateFixture, fileMap } from "../helpers/fixtures.js";
import { compileAll, compileError } from "../helpers/mdx.js";

describe.each(FORMATS)("generated MDX compiles (%s)", (format) => {
  it.each(["reexport", "kitchen_sink", "kitchen_derive"])("%s: every page", async (name) => {
    const errors = await compileAll(generateFixture(name, format));
    expect(errors).toEqual([]);
  });

  it("escapes struct and union field types", async () => {
    const files = fileMap(generateFixture("kitchen_sink", format));
    const widget = files.get("kitchen_sink/Widget.mdx") ?? "";
    // Undocumented fields with generic / array types.
    expect(widget).toContain("- `name`: `Option<String>`");
    expect(widget).toContain("- `keys`: `Vec<[u8; 32]>`");
    expect(await compileError(widget)).toBeNull();
    const union = files.get("kitchen_sink/RawBits.mdx") ?? "";
    expect(union).toContain("- `bytes`: `[u8; 8]`");
    expect(await compileError(union)).toBeNull();
  });
});
