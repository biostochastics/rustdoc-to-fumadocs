/**
 * Unit tests for renderer/components.ts - FumaDocs component generators.
 */

import { describe, it, expect } from "vitest";
import {
  renderCallout,
  renderTabs,
  renderCards,
  renderCodeBlock,
  renderDeprecation,
  renderInfoNotice,
  renderDangerNotice,
  renderSafetyCallout,
  renderFeatureGateCallout,
  renderPanicsCallout,
  renderErrorsCallout,
  extractDocSection,
  indent,
  type CardData,
} from "../../src/renderer/components.js";

describe("indent", () => {
  it("indents a single line by specified spaces", () => {
    expect(indent("hello", 2)).toBe("  hello");
  });

  it("indents multiple lines", () => {
    expect(indent("line1\nline2\nline3", 4)).toBe("    line1\n    line2\n    line3");
  });

  it("preserves empty lines without adding spaces", () => {
    expect(indent("line1\n\nline3", 2)).toBe("  line1\n\n  line3");
  });

  it("handles zero spaces", () => {
    expect(indent("hello\nworld", 0)).toBe("hello\nworld");
  });

  it("handles empty string", () => {
    expect(indent("", 4)).toBe("");
  });
});

describe("renderCallout", () => {
  it("renders a basic info callout", () => {
    const result = renderCallout("info", "Note", "This is a note.");
    expect(result).toBe(
      `<Callout type="info" title={"Note"}>
This is a note.
</Callout>`
    );
  });

  it("renders a warning callout", () => {
    const result = renderCallout("warn", "Warning", "Be careful!");
    expect(result).toBe(
      `<Callout type="warn" title={"Warning"}>
Be careful!
</Callout>`
    );
  });

  it("renders an error callout", () => {
    const result = renderCallout("error", "Error", "Something went wrong.");
    expect(result).toBe(
      `<Callout type="error" title={"Error"}>
Something went wrong.
</Callout>`
    );
  });

  it("properly escapes quotes in title using JSON.stringify", () => {
    const result = renderCallout("warn", 'Use "new_api" instead', "Details");
    // JSON.stringify escapes the quotes properly
    expect(result).toContain('title={"Use \\"new_api\\" instead"}');
  });

  it("properly escapes special characters in title", () => {
    const result = renderCallout("info", "Title with <html> & stuff", "Content");
    // JSON.stringify handles angle brackets and ampersands
    expect(result).toContain('title={"Title with <html> & stuff"}');
  });

  it("preserves markdown in content", () => {
    const result = renderCallout("info", "Code Example", "Use `my_function()` instead.");
    expect(result).toContain("Use `my_function()` instead.");
  });

  it("handles multiline content", () => {
    const result = renderCallout("info", "Multi", "Line 1\nLine 2\nLine 3");
    expect(result).toContain("Line 1\nLine 2\nLine 3");
  });

  it("handles newlines in title (escaped by JSON.stringify)", () => {
    const result = renderCallout("warn", "Line1\nLine2", "Content");
    // JSON.stringify converts newlines to \n
    expect(result).toContain('title={"Line1\\nLine2"}');
  });
});

describe("renderTabs", () => {
  it("renders tabs with content", () => {
    const items = ["Methods", "Traits"];
    const contents = new Map([
      ["Methods", "## Methods\n\nMethod content here."],
      ["Traits", "## Traits\n\nTrait content here."],
    ]);

    const result = renderTabs(items, contents);

    expect(result).toContain('<Tabs items={["Methods","Traits"]}>');
    expect(result).toContain('<Tab value={"Methods"}>');
    expect(result).toContain('<Tab value={"Traits"}>');
    expect(result).toContain("Method content here.");
    expect(result).toContain("Trait content here.");
    expect(result).toContain("</Tab>");
    expect(result).toContain("</Tabs>");
  });

  it("escapes special characters in tab names", () => {
    const items = ['Tab with "quotes"', "Tab & ampersand"];
    const contents = new Map([
      ['Tab with "quotes"', "Content 1"],
      ["Tab & ampersand", "Content 2"],
    ]);

    const result = renderTabs(items, contents);

    expect(result).toContain('["Tab with \\"quotes\\"","Tab & ampersand"]');
    expect(result).toContain('<Tab value={"Tab with \\"quotes\\""}>');
  });

  it("handles empty content for a tab", () => {
    const items = ["Empty"];
    const contents = new Map<string, string>();

    const result = renderTabs(items, contents);

    expect(result).toContain('<Tab value={"Empty"}>');
    expect(result).toContain("</Tab>");
  });

  it("handles single tab", () => {
    const items = ["Only"];
    const contents = new Map([["Only", "Single tab content"]]);

    const result = renderTabs(items, contents);

    expect(result).toContain('<Tabs items={["Only"]}>');
    expect(result).toContain('<Tab value={"Only"}>');
  });

  it("indents tab content properly", () => {
    const items = ["Test"];
    const contents = new Map([["Test", "Line 1\nLine 2"]]);

    const result = renderTabs(items, contents);

    // Content should NOT be indented to avoid MDX rendering as code blocks
    // (4+ spaces in MDX triggers code block rendering)
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
    expect(result).not.toContain("    Line 1"); // No 4-space indentation
  });
});

describe("renderCards", () => {
  it("renders cards with required props only", () => {
    const cards: CardData[] = [
      { title: "MyStruct", href: "./MyStruct" },
      { title: "MyEnum", href: "./MyEnum" },
    ];

    const result = renderCards(cards);

    expect(result).toContain("<Cards>");
    expect(result).toContain('title={"MyStruct"}');
    expect(result).toContain('href={"./MyStruct"}');
    expect(result).toContain('title={"MyEnum"}');
    expect(result).toContain('href={"./MyEnum"}');
    expect(result).toContain("</Cards>");
  });

  it("renders cards with all props", () => {
    const cards: CardData[] = [
      {
        title: "MyStruct",
        href: "./MyStruct",
        description: "A data structure",
        icon: "Box",
      },
    ];

    const result = renderCards(cards);

    expect(result).toContain('title={"MyStruct"}');
    expect(result).toContain('href={"./MyStruct"}');
    expect(result).toContain('description={"A data structure"}');
    expect(result).toContain('icon={"Box"}');
  });

  it("escapes special characters in card props", () => {
    const cards: CardData[] = [
      {
        title: 'Struct "Name"',
        href: "./path?query=value&other=1",
        description: "Description with <html>",
      },
    ];

    const result = renderCards(cards);

    expect(result).toContain('title={"Struct \\"Name\\""}');
    expect(result).toContain('href={"./path?query=value&other=1"}');
    expect(result).toContain('description={"Description with <html>"}');
  });

  it("handles empty cards array", () => {
    const result = renderCards([]);

    expect(result).toBe("<Cards>\n</Cards>");
  });

  it("uses self-closing Card tags", () => {
    const cards: CardData[] = [{ title: "Test", href: "./test" }];

    const result = renderCards(cards);

    expect(result).toContain("<Card ");
    expect(result).toContain(" />");
  });
});

describe("renderCodeBlock", () => {
  it("renders a basic code block", () => {
    const result = renderCodeBlock("fn main() {}", "rust");

    expect(result).toBe("```rust\nfn main() {}\n```");
  });

  it("renders with title", () => {
    const result = renderCodeBlock("fn main() {}", "rust", { title: "main.rs" });

    expect(result).toBe('```rust title="main.rs"\nfn main() {}\n```');
  });

  it("renders with line numbers", () => {
    const result = renderCodeBlock("fn main() {}", "rust", {
      showLineNumbers: true,
    });

    expect(result).toBe("```rust showLineNumbers\nfn main() {}\n```");
  });

  it("renders with both title and line numbers", () => {
    const result = renderCodeBlock("fn main() {}", "rust", {
      title: "example.rs",
      showLineNumbers: true,
    });

    expect(result).toBe('```rust title="example.rs" showLineNumbers\nfn main() {}\n```');
  });

  it("handles multiline code", () => {
    const code = `fn main() {
    println!("Hello");
}`;

    const result = renderCodeBlock(code, "rust");

    expect(result).toContain("fn main() {");
    expect(result).toContain('    println!("Hello");');
    expect(result).toContain("}");
  });

  it("handles different languages", () => {
    expect(renderCodeBlock("const x = 1;", "typescript")).toContain("```typescript");
    expect(renderCodeBlock("def foo(): pass", "python")).toContain("```python");
    expect(renderCodeBlock("<div>test</div>", "html")).toContain("```html");
  });

  it("handles empty code", () => {
    const result = renderCodeBlock("", "rust");

    expect(result).toBe("```rust\n\n```");
  });

  it("handles no options", () => {
    const result = renderCodeBlock("code", "rust", undefined);

    expect(result).toBe("```rust\ncode\n```");
  });

  it("handles empty options object", () => {
    const result = renderCodeBlock("code", "rust", {});

    expect(result).toBe("```rust\ncode\n```");
  });
});

describe("renderDeprecation", () => {
  it("renders deprecation with since version", () => {
    const result = renderDeprecation("1.2.0", "Use `new_api` instead.");

    expect(result).toContain('type="warn"');
    expect(result).toContain('title={"Deprecated since 1.2.0"}');
    expect(result).toContain("Use `new_api` instead.");
  });

  it("renders deprecation without since version", () => {
    const result = renderDeprecation(undefined, "This is old.");

    expect(result).toContain('title={"Deprecated"}');
    expect(result).toContain("This is old.");
  });

  it("renders deprecation without note", () => {
    const result = renderDeprecation("2.0.0");

    expect(result).toContain('title={"Deprecated since 2.0.0"}');
    expect(result).toContain("This item is deprecated.");
  });

  it("renders deprecation with no arguments", () => {
    const result = renderDeprecation();

    expect(result).toContain('title={"Deprecated"}');
    expect(result).toContain("This item is deprecated.");
  });
});

describe("renderInfoNotice", () => {
  it("renders an info notice", () => {
    const result = renderInfoNotice("Unstable", "Requires `#![feature(my_feature)]`");

    expect(result).toContain('type="info"');
    expect(result).toContain('title={"Unstable"}');
    expect(result).toContain("Requires `#![feature(my_feature)]`");
  });
});

describe("renderDangerNotice", () => {
  it("renders a danger/error notice", () => {
    const result = renderDangerNotice("Unsafe", "This function requires unsafe usage.");

    expect(result).toContain('type="error"');
    expect(result).toContain('title={"Unsafe"}');
    expect(result).toContain("This function requires unsafe usage.");
  });
});

describe("JSX escaping correctness", () => {
  it("does NOT use HTML entities - uses JSON.stringify instead", () => {
    const result = renderCallout("info", "Test & <Test>", "Content");

    // HTML entities would be &amp; and &lt; - we should NOT see these
    expect(result).not.toContain("&amp;");
    expect(result).not.toContain("&lt;");
    expect(result).not.toContain("&gt;");
    expect(result).not.toContain("&quot;");

    // Instead, we should see the raw characters inside JSON string
    expect(result).toContain('title={"Test & <Test>"}');
  });

  it("properly escapes backslashes", () => {
    const result = renderCallout("info", "Path: C:\\Users\\test", "Content");

    // JSON.stringify escapes backslashes
    expect(result).toContain('title={"Path: C:\\\\Users\\\\test"}');
  });

  it("properly escapes unicode characters", () => {
    const result = renderCallout("info", "Arrow: \u2192", "Content");

    // Unicode should be preserved
    expect(result).toContain('title={"Arrow: \u2192"}');
  });
});

describe("extractDocSection", () => {
  it("extracts # Safety section", () => {
    const docs = `Some intro.

# Safety

Caller must ensure pointer is valid.

# Examples

Some examples.`;

    const result = extractDocSection(docs, "Safety");

    expect(result).toBe("Caller must ensure pointer is valid.");
  });

  it("extracts ## Panics section", () => {
    const docs = `## Description

This function does something.

## Panics

Panics if index is out of bounds.

## Returns

Something.`;

    const result = extractDocSection(docs, "Panics");

    expect(result).toBe("Panics if index is out of bounds.");
  });

  it("returns undefined if section not found", () => {
    const docs = "Just some docs without sections.";

    const result = extractDocSection(docs, "Safety");

    expect(result).toBeUndefined();
  });

  it("handles null docs", () => {
    expect(extractDocSection(null, "Safety")).toBeUndefined();
  });

  it("handles undefined docs", () => {
    expect(extractDocSection(undefined, "Safety")).toBeUndefined();
  });

  it("handles empty string docs", () => {
    expect(extractDocSection("", "Safety")).toBeUndefined();
  });

  it("is case-insensitive for section names", () => {
    const docs = "# SAFETY\n\nImportant safety info.";

    const result = extractDocSection(docs, "Safety");

    expect(result).toBe("Important safety info.");
  });

  it("extracts section at end of document", () => {
    const docs = "Intro.\n\n# Errors\n\nReturns error on failure.";

    const result = extractDocSection(docs, "Errors");

    expect(result).toBe("Returns error on failure.");
  });
});

describe("renderSafetyCallout", () => {
  it("extracts Safety section from docs", () => {
    const docs = "Function docs.\n\n# Safety\n\nPointer must be valid.";

    const result = renderSafetyCallout(docs);

    expect(result).toContain('type="error"');
    expect(result).toContain('title={"Safety"}');
    expect(result).toContain("Pointer must be valid.");
  });

  it("shows generic message when no Safety section", () => {
    const docs = "Just some docs.";

    const result = renderSafetyCallout(docs);

    expect(result).toContain('type="error"');
    expect(result).toContain('title={"Unsafe"}');
    expect(result).toContain("safety invariants");
  });

  it("handles null docs", () => {
    const result = renderSafetyCallout(null);

    expect(result).toContain('title={"Unsafe"}');
  });
});

describe("renderFeatureGateCallout", () => {
  it("renders feature gate callout", () => {
    const result = renderFeatureGateCallout("async-std");

    expect(result).toContain('type="info"');
    expect(result).toContain('title={"Feature Gate"}');
    expect(result).toContain("`async-std`");
    expect(result).toContain("Cargo.toml");
    expect(result).toContain('features = ["async-std"]');
  });
});

describe("renderPanicsCallout", () => {
  it("extracts Panics section from docs", () => {
    const docs = "Intro.\n\n# Panics\n\nPanics if empty.";

    const result = renderPanicsCallout(docs);

    expect(result).toContain('type="error"');
    expect(result).toContain('title={"Panics"}');
    expect(result).toContain("Panics if empty.");
  });

  it("returns empty string when no Panics section", () => {
    const docs = "Just some docs.";

    const result = renderPanicsCallout(docs);

    expect(result).toBe("");
  });
});

describe("renderErrorsCallout", () => {
  it("extracts Errors section from docs", () => {
    const docs = "Intro.\n\n# Errors\n\nReturns `Err` on failure.";

    const result = renderErrorsCallout(docs);

    expect(result).toContain('type="warn"');
    expect(result).toContain('title={"Errors"}');
    expect(result).toContain("Returns `Err` on failure.");
  });

  it("returns empty string when no Errors section", () => {
    const docs = "Just some docs.";

    const result = renderErrorsCallout(docs);

    expect(result).toBe("");
  });
});
