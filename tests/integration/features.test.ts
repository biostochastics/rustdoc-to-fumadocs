/**
 * Feature-gate callouts from `#[doc(cfg(..))]` (with `--cfg docsrs`) and
 * `#[cfg(..)]`, inherited from enclosing modules.
 */

import { describe, it, expect } from "vitest";
import { FORMATS, generateFixture, fileMap } from "../helpers/fixtures.js";

describe.each(FORMATS)("feature gates (%s)", (format) => {
  const files = fileMap(generateFixture("kitchen_sink", format, { packageName: "kitchen-sink" }));
  const page = (p: string): string => files.get(`kitchen_sink/${p}`) ?? "";

  it("reads #[doc(cfg)] on modules and uses the real package name", () => {
    expect(page("extra/index.mdx")).toContain("Available on crate feature `extra` only.");
    expect(page("extra/index.mdx")).toContain(
      'kitchen-sink = { version = "0.2.0", features = ["extra"] }'
    );
    expect(page("extra/index.mdx")).not.toContain("crate_name");
  });

  it("inherits a module's gate into its items", () => {
    expect(page("extra/ExtraThing.mdx")).toContain("Available on crate feature `extra` only.");
    expect(page("extra/fancy_extra.mdx")).toContain(
      "Available on crate features `extra` and `fancy` only."
    );
    expect(page("extra/fancy_extra.mdx")).toContain('features = ["extra", "fancy"]');
  });

  it("renders any() as alternatives and not() as an exclusion", () => {
    expect(page("either_feature.mdx")).toContain(
      "Available on crate feature `extra` or `fancy` only."
    );
    expect(page("plain_only.mdx")).toContain("Available on non-crate feature `nope` only.");
    expect(page("plain_only.mdx")).not.toContain('features = ["nope"]');
  });

  it("falls back to #[cfg] when there is no #[doc(cfg)]", () => {
    expect(page("FancyOnly.mdx")).toContain("Available on crate feature `fancy` only.");
  });

  it("notes the gate of an impl block that the type itself does not have", () => {
    const widget = page("Widget.mdx");
    const impl = widget.slice(widget.indexOf("extra_method") - 400, widget.indexOf("extra_method"));
    expect(impl).toContain("*Available on crate feature `extra` only.*");
  });

  it("adds no gate to ungated items", () => {
    expect(page("Widget.mdx").split("Available on").length).toBe(2); // only the gated impl
    expect(page("shapes/index.mdx")).not.toContain("Available on");
  });
});
