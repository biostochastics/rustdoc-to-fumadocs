/**
 * Tests for docs.ts — intra-doc link rewriting and docstring transforms.
 */

import { describe, it, expect } from "vitest";
import {
  createMarkdownParser,
  rewriteDocLinks,
  demoteHeadings,
  takeSection,
  summaryLine,
  splitFences,
  looksLikeRustPath,
  type LinkResolver,
} from "../../src/docs.js";

it("isolates mutating Markdown transforms and bounds each render's parser cache", () => {
  const parse = createMarkdownParser();
  const source = "# Original heading";
  const original = parse(source);
  expect(demoteHeadings(source, 2, parse)).toContain("### Original heading");
  expect(parse(source)).toBe(original);
  expect(original.children[0]).toMatchObject({ type: "heading", depth: 1 });
  expect(createMarkdownParser()(source)).not.toBe(original);

  const large = "x".repeat(65 * 1024);
  expect(parse(large)).not.toBe(parse(large));
  // Five individually cacheable documents exceed the aggregate source budget.
  for (let i = 0; i < 5; i++) parse("x".repeat(60 * 1024) + i);
  expect(parse(source)).not.toBe(original);
});

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
      "### A\n\ntext\n\n```\n# not a heading\n```\n\n#### B"
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
    expect(summaryLine("See [`Foo`](/a) and [b][c] and `D`.\nmore\n\n[c]: /c")).toBe(
      "See Foo and b and D. more"
    );
  });
});

describe("passive MDX", () => {
  it("renders prose, email autolinks and inline code inside Markdown containers", async () => {
    const { sanitizeDocstring } = await import("../../src/docs.js");
    const { compileError } = await import("../helpers/mdx.js");
    const source = [
      "A literal {field}, <br>, <dev@example.org> and ``Option<T> and `tick` ``.",
      "",
      "> A nested sample",
      ">",
      "> ```ignore",
      "> # use std::fmt;",
      "> let sample = 1;",
      "> ```",
      "",
      "export examples",
      "",
      '<Example title="Text">',
      "",
      "End.",
    ].join("\n");
    const mdx = sanitizeDocstring(source);
    expect(await compileError(mdx)).toBeNull();
    expect(mdx).toContain("[dev@example.org](mailto:dev@example.org)");
    expect(mdx).toContain('> ```rust title="ignore"');
    expect(mdx).not.toContain("use std::fmt");
    expect(mdx).not.toMatch(/^export |^<Example/m);
    expect(mdx).toContain("\\{field}");
  });

  it("keeps section bodies intact around code and closed ATX headings", () => {
    const original =
      "Intro.\n\n# Safety ###\n\nFull description.\n\n```text\n# Examples\n```\n\nStill applies.\n\n# Next\n\nok";
    const result = takeSection(original, "Safety");
    expect(result.section).toBe("Full description.\n\n```text\n# Examples\n```\n\nStill applies.");
    expect(result.rest).toBe("Intro.\n\n# Next\n\nok");
  });

  it("preserves section fragments and recognizes indented definitions on repeated runs", () => {
    const fn: LinkResolver = (key) => (key.startsWith("Widget") ? "/api/Widget" : undefined);
    const raw = "  [w]: Widget#examples\n\nRead [w] and [the docs](Widget#examples).";
    for (let i = 0; i < 2; i++)
      expect(rewriteDocLinks(raw, fn)).toBe(
        "  [w]: /api/Widget#examples\n\nRead [w] and [the docs](/api/Widget#examples)."
      );
    expect(rewriteDocLinks("> ```text\n> [w]: Widget\n> ```\n\n[Widget].", fn)).toContain(
      "[Widget](/api/Widget)"
    );
  });

  it("uses a complete prose paragraph for summaries and resolves its definitions", async () => {
    const { summaryMarkdown, sanitizeDocstring } = await import("../../src/docs.js");
    const { compileError } = await import("../helpers/mdx.js");
    const summary = summaryMarkdown(
      sanitizeDocstring(
        "# Overview\n\n[Read the\nmanual][ref] with {labels}.\n\n[ref]: https://example.org"
      )
    );
    expect(summary).toContain("[Read the manual](https://example.org)");
    expect(await compileError("- Item — " + summary)).toBeNull();
    expect(summaryMarkdown("```rust\nfn f() {}\n```")).toBe("");
  });
});

it("preserves HTML table contents, badge links and accessible image descriptions", async () => {
  const { sanitizeDocstring } = await import("../../src/docs.js");
  const { compileError } = await import("../helpers/mdx.js");
  const raw =
    '<table><tr><td><a href="https://example.org"><img src="./badge.svg" alt="Build status"></a><br>Latest</td></tr></table>';
  const mdx = sanitizeDocstring(raw);
  expect(mdx).toContain(
    '<a href="https://example.org"><img src="./badge.svg" alt="Build status" /></a>'
  );
  expect(mdx).toContain("<br />Latest");
  expect(await compileError(mdx)).toBeNull();
});

it("drops unavailable Rust reference definitions without leaving dead relative links", () => {
  const md = "Use [`Vec<Arm>`] or [a list][`Vec<Arm>`].\n\n[`Vec<Arm>`]: Arm";
  const out = rewriteDocLinks(md, () => undefined);
  expect(out.trim()).toBe("Use `Vec<Arm>` or a list.");
});

it("renders only supported URL schemes in HTML and Markdown", async () => {
  const { sanitizeDocstring } = await import("../../src/docs.js");
  const out = sanitizeDocstring(
    '[edit](editor:open). <a href="editor:open">Open</a>. [site](https://example.org)'
  );
  expect(out).not.toContain("editor:");
  expect(out).toContain("[site](https://example.org)");
});
