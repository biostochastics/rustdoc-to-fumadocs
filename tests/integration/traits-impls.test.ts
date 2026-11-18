/**
 * Trait pages (associated items, required vs provided methods,
 * implementors), implementation lists (marker and auto-trait impls),
 * doctest rendering and callout de-duplication.
 */

import { describe, it, expect } from "vitest";
import { FORMATS, generateFixture, fileMap } from "../helpers/fixtures.js";

describe.each(FORMATS)("traits and impls (%s)", (format) => {
  const files = fileMap(generateFixture("kitchen_sink", format));
  const page = (p: string): string => files.get(`kitchen_sink/${p}`) ?? "";

  it("renders associated types and constants of a trait", () => {
    const shape = page("Shape.mdx");
    expect(shape).toContain("### Associated Types");
    expect(shape).toMatch(/^#### `Output` \[#associatedtype\.Output\]$/m);
    expect(shape).toContain("type Output: Copy;");
    expect(shape).toContain("### Associated Constants");
    expect(shape).toContain("const SIDES: u32;");
    expect(shape).toContain("const SCALE: u32 = 1;");
  });

  it("splits required and provided methods", () => {
    const shape = page("Shape.mdx");
    const required = shape.indexOf("### Required Methods");
    const provided = shape.indexOf("### Provided Methods");
    expect(required).toBeGreaterThan(-1);
    expect(provided).toBeGreaterThan(required);
    expect(shape.indexOf("`area`")).toBeGreaterThan(required);
    expect(shape.indexOf("`area`")).toBeLessThan(provided);
    expect(shape.indexOf("`describe`")).toBeGreaterThan(provided);
  });

  it("lists implementors with links", () => {
    const shape = page("Shape.mdx");
    expect(shape).toContain("### Implementors");
    expect(shape).toContain("[`Circle`](/docs/api/kitchen_sink/shapes/Circle)");
  });

  it("shows marker impls, associated types of trait impls and auto traits", () => {
    const circle = page("shapes/Circle.mdx");
    expect(circle).toMatch(/### `impl (core::marker::)?Copy for Circle`/);
    expect(circle).toMatch(/### `impl (core::cmp::)?Eq for Circle`/);
    expect(circle).toContain("type Output = u64;");
    expect(circle).toContain("### Auto Trait Implementations");
    expect(circle).toMatch(/`Send`.*`Sync`/s);
  });

  it("hides doctest setup lines and tags rust fences", () => {
    const widget = page("Widget.mdx");
    expect(widget).toContain('let w = Widget::new("hello");');
    expect(widget).not.toContain("# use kitchen_sink::Widget;");
    expect(widget).not.toContain("# fn main() {");
    expect(widget).toContain('```rust title="ignore"');
    expect(widget).not.toMatch(/^```$\n(?!\s*$)let/m);
  });

  it("does not repeat Panics / Errors sections that became callouts", () => {
    const divide = page("divide.mdx");
    expect(divide).toContain('title={"Panics"}');
    expect(divide).toContain('title={"Errors"}');
    expect(divide.split("Panics when `b` is zero").length).toBe(2);
    expect(divide.split("when the division is inexact").length).toBe(2);
    expect(divide).toContain("### Examples");
    expect(divide).toContain("```rust\nassert_eq!");
  });
});
