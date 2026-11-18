/**
 * Attribute badges (#[non_exhaustive], #[must_use], #[repr]), stability,
 * deprecation callouts and source links.
 */

import { describe, it, expect } from "vitest";
import { FORMATS, generateFixture, fileMap, loadCrate } from "../helpers/fixtures.js";
import { compileError } from "../helpers/mdx.js";
import { RustdocGenerator } from "../../src/generator.js";

describe.each(FORMATS)("badges, deprecation and source links (%s)", (format) => {
  const files = fileMap(generateFixture("kitchen_sink", format));
  const page = (p: string): string => files.get(`kitchen_sink/${p}`) ?? "";

  it("prints API-relevant attributes above the signature", () => {
    expect(page("Widget.mdx")).toContain("```rust\n#[non_exhaustive]\nstruct Widget");
    expect(page("RawBits.mdx")).toContain("```rust\n#[repr(C)]\nunion RawBits");
    expect(page("Widget.mdx")).toMatch(/```rust\n#\[must_use\]\nfn new\(/);
  });

  it("shows deprecation of methods with since and note", () => {
    const widget = page("Widget.mdx");
    const i = widget.indexOf("`old_label`");
    expect(widget.slice(i, i + 400)).toContain('title={"Deprecated since 0.2.0"}');
    expect(widget.slice(i, i + 400)).toContain('use "label" with `Vec<T>` instead');
  });

  it("escapes deprecation titles and notes", async () => {
    const crate = loadCrate(`kitchen_sink.${format}.json`);
    const widget = Object.values(crate.index).find(
      (i) => i.name === "Widget" && "struct" in i.inner
    )!;
    widget.deprecation = { since: 'v"1"', note: "Use <Gadget> or Vec<T> instead" };
    widget.stability = { level: "unstable", feature: "widget_api" };
    const out = fileMap(
      new RustdocGenerator(crate, { output: "/x", baseUrl: "/docs/api" }).generate()
    ).get("kitchen_sink/Widget.mdx")!;
    expect(out).toContain('title={"Deprecated since v\\"1\\""}');
    expect(out).toContain("**Unstable** (feature `widget_api`)");
    expect(await compileError(out)).toBeNull();
  });

  it("links items to their source when a repository URL is given", () => {
    const withSource = fileMap(
      generateFixture("kitchen_sink", format, {
        sourceUrlBase: "https://github.com/o/r",
        sourceRef: "v1",
      })
    );
    expect(withSource.get("kitchen_sink/Widget.mdx")).toMatch(
      /\[Source\]\(https:\/\/github\.com\/o\/r\/blob\/v1\/src\/lib\.rs#L\d+-L\d+\)/
    );
    expect(withSource.get("kitchen_sink/Widget.mdx")).toMatch(
      /#### `label` \[#method\.label\][\s\S]*?\[Source\]\(https:\/\/github\.com\/o\/r\/blob\/v1\/src\/lib\.rs#L\d+/
    );
    expect(page("Widget.mdx")).not.toContain("[Source]");
  });
});
