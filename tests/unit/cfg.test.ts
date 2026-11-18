/**
 * Tests for cfg.ts — parsing `#[doc(cfg(..))]`, `#[cfg(..)]` and rustc's
 * `#[attr = CfgTrace(..)]` debug form, and describing the result.
 */

import { describe, it, expect } from "vitest";
import { parseCfgAttr, describeCfgs, requiredFeatures, type Cfg } from "../../src/cfg.js";

const feature = (value: string): Cfg => ({ type: "flag", name: "feature", value });

describe("parseCfgAttr", () => {
  it("parses #[doc(cfg(...))] in Rust syntax", () => {
    expect(parseCfgAttr({ other: '#[doc(cfg(feature = "confidential"))]' })).toEqual({
      source: "doc",
      cfg: feature("confidential"),
    });
    expect(
      parseCfgAttr({ other: '#[doc(cfg(any(feature = "a", all(unix, not(feature = "b")))))]' })
    ).toEqual({
      source: "doc",
      cfg: {
        type: "any",
        items: [
          feature("a"),
          {
            type: "all",
            items: [
              { type: "flag", name: "unix" },
              { type: "not", item: feature("b") },
            ],
          },
        ],
      },
    });
  });

  it("parses legacy string #[cfg(...)] attributes", () => {
    expect(parseCfgAttr('#[cfg(feature = "std")]')).toEqual({ source: "cfg", cfg: feature("std") });
  });

  it("parses rustc's CfgTrace debug form, ignoring spans", () => {
    const attr = {
      other:
        '#[attr = CfgTrace([Any([NameValue { name: "feature", value: Some("extra"), span: src/lib.rs:201:11: 201:28 (#0) }, NameValue { name: "feature", value: Some("fancy"), span: src/lib.rs:201:30: 201:47 (#0) }], src/lib.rs:201:10: 201:48 (#0)), Not(NameValue { name: "unix", value: None, span: a.rs:1:1: 1:2 (#0) }, a.rs:1:1: 1:2 (#0))])]',
    };
    expect(parseCfgAttr(attr)).toEqual({
      source: "cfg",
      cfg: {
        type: "all",
        items: [
          { type: "any", items: [feature("extra"), feature("fancy")] },
          { type: "not", item: { type: "flag", name: "unix" } },
        ],
      },
    });
  });

  it("ignores unrelated attributes", () => {
    expect(parseCfgAttr({ other: "#[attr = Inline(Hint)]" })).toBeNull();
    expect(parseCfgAttr("#[must_use]")).toBeNull();
    expect(parseCfgAttr({ other: "#[attr = CfgAttrTrace]" })).toBeNull();
  });
});

describe("describeCfgs / requiredFeatures", () => {
  it("describes a single feature", () => {
    expect(describeCfgs([feature("x")])).toBe("Available on crate feature `x` only.");
    expect(requiredFeatures([feature("x")])).toEqual(["x"]);
  });

  it("joins conjunctions and keeps alternatives as alternatives", () => {
    expect(describeCfgs([feature("a"), feature("b")])).toBe(
      "Available on crate features `a` and `b` only."
    );
    const any: Cfg = { type: "any", items: [feature("a"), feature("b")] };
    expect(describeCfgs([any])).toBe("Available on crate feature `a` or `b` only.");
    expect(requiredFeatures([any])).toEqual(["a"]);
  });

  it("never treats not(feature) as a requirement", () => {
    const not: Cfg = { type: "not", item: feature("nope") };
    expect(describeCfgs([not])).toBe("Available on non-crate feature `nope` only.");
    expect(requiredFeatures([not])).toEqual([]);
  });

  it("describes non-feature cfgs", () => {
    expect(describeCfgs([{ type: "flag", name: "target_os", value: "linux" }])).toBe(
      'Available on `target_os = "linux"` only.'
    );
  });
});

it("collects nested alternatives once while preserving the selected branch's feature set", () => {
  const alternatives: Cfg = {
    type: "any",
    items: [
      { type: "flag", name: "unix" },
      { type: "all", items: [feature("a"), { type: "any", items: [feature("b"), feature("c")] }] },
    ],
  };
  expect(requiredFeatures([alternatives, feature("a")])).toEqual(["a", "b"]);
});
