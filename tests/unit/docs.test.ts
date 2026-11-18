/**
 * Tests for docs.ts — intra-doc link rewriting and docstring transforms.
 */

import { describe, it, expect } from "vitest";
import {
  rewriteDocLinks,
  demoteHeadings,
  takeSection,
  summaryLine,
  splitFences,
  looksLikeRustPath,
  type LinkResolver,
} from "../../src/docs.js";

const links: Record<string, string | null> = {
  "`Foo`": "/api/c/Foo",
  "crate::Bar": "/api/c/Bar",
  "`Self::new`": "/api/c/Foo#method.new",
  "`Private`": null,
};
const resolve: LinkResolver = (key) => (key in links ? links[key] : undefined);

describe("rewriteDocLinks", () => {
  it("resolves shortcut links", () => {
    expect(rewriteDocLinks("See [`Foo`].", resolve)).toBe("See [`Foo`](/api/c/Foo).");
  });

  it("resolves inline links whose destination is a Rust path", () => {
    expect(rewriteDocLinks("A [bar](crate::Bar) here", resolve)).toBe("A [bar](/api/c/Bar) here");
  });

  it("resolves reference and collapsed reference links", () => {
    expect(rewriteDocLinks("[new one][`Self::new`]", resolve)).toBe(
      "[new one](/api/c/Foo#method.new)"
    );
    expect(rewriteDocLinks("[`Foo`][]", resolve)).toBe("[`Foo`](/api/c/Foo)");
  });

  it("rewrites reference definitions", () => {
    expect(rewriteDocLinks("Use [b].\n\n[b]: crate::Bar", resolve)).toBe(
      "Use [b].\n\n[b]: /api/c/Bar"
    );
  });

  it("drops brackets of intra-doc links without a public target", () => {
    expect(rewriteDocLinks("See [`Private`] and [x](crate::nope::Gone).", resolve)).toBe(
      "See `Private` and x."
    );
    expect(rewriteDocLinks("Unknown [`Mystery`] item", resolve)).toBe("Unknown `Mystery` item");
  });

  it("treats `[x]: prose` as a paragraph, not a reference definition", () => {
    expect(rewriteDocLinks("[`Self::new`]: builds one.", resolve)).toBe(
      "[`Self::new`](/api/c/Foo#method.new): builds one."
    );
  });

  it("drops the brackets around any unresolved single code span", () => {
    expect(rewriteDocLinks("See [`Err::Charset { at }`] and [`docs/a.md`].", resolve)).toBe(
      "See `Err::Charset { at }` and `docs/a.md`."
    );
  });

  it("leaves ordinary Markdown links and brackets alone", () => {
    const md = "[site](https://example.com), [rel](./a.md), [1], [ ] todo, ![img](x.png)";
    expect(rewriteDocLinks(md, resolve)).toBe(md);
  });

  it("does not touch fenced code or inline code", () => {
    const md = "```rust\nlet a = [`Foo`];\n```\n`[`Foo`]` and [`Foo`]";
    expect(rewriteDocLinks(md, resolve)).toBe(
      "```rust\nlet a = [`Foo`];\n```\n`[`Foo`]` and [`Foo`](/api/c/Foo)"
    );
  });

  it("handles link text that wraps onto the next line", () => {
    expect(rewriteDocLinks("[the\nbar](crate::Bar)", resolve)).toBe("[the\nbar](/api/c/Bar)");
  });
});

describe("looksLikeRustPath", () => {
  it("recognises intra-doc forms", () => {
    for (const s of ["`Foo`", "`a::B`", "crate::x::Y", "`Foo::bar()`", "`macro@m`", "`Vec<T>`"]) {
      expect(looksLikeRustPath(s)).toBe(true);
    }
    for (const s of ["1", " ", "see here", "https://x", "./a.md"]) {
      expect(looksLikeRustPath(s)).toBe(false);
    }
  });
});

describe("splitFences", () => {
  it("round-trips the input", () => {
    const md = "a\n```rust\nx\n```\nb\n~~~\ny\n~~~";
    expect(splitFences(md).join("")).toBe(md);
    expect(splitFences(md)).toHaveLength(5);
  });
});

describe("demoteHeadings", () => {
  it("pushes headings down and leaves code alone", () => {
    expect(demoteHeadings("# A\ntext\n```\n# not a heading\n```\n## B", 2)).toBe(
      "### A\ntext\n```\n# not a heading\n```\n#### B"
    );
  });

  it("turns headings beyond level 6 into bold text", () => {
    expect(demoteHeadings("#### Deep", 4)).toBe("**Deep**");
  });
});

describe("takeSection", () => {
  it("removes a section and returns its body", () => {
    const { section, rest } = takeSection(
      "Intro.\n\n# Panics\n\nIf x.\n\n# Examples\n\nok",
      "Panics"
    );
    expect(section).toBe("If x.");
    expect(rest).toBe("Intro.\n\n# Examples\n\nok");
  });

  it("ignores headings inside code fences", () => {
    const md = "```\n# Panics\n```\nbody";
    expect(takeSection(md, "Panics")).toEqual({ section: undefined, rest: md });
  });
});

describe("summaryLine", () => {
  it("reduces links to their text", () => {
    expect(summaryLine("See [`Foo`](/a) and [b][c] and [`D`].\nmore")).toBe(
      "See `Foo` and b and `D`."
    );
  });
});
