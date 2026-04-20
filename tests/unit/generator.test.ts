/**
 * Tests for generator.ts security and utility functions.
 */

import { describe, it, expect } from "vitest";
import { sanitizePath, sanitizeDocstring } from "../../src/generator.js";

describe("sanitizePath", () => {
  describe("path traversal prevention", () => {
    it("should replace parent directory traversal (../)", () => {
      // Each ".." becomes "_", "/" becomes "_"
      expect(sanitizePath("../../../etc/passwd")).toBe("______etc_passwd");
      expect(sanitizePath("foo/../bar")).toBe("foo___bar");
      // ".." becomes "_" (single replacement per pair)
      expect(sanitizePath("..")).toBe("_");
    });

    it("should replace forward slashes", () => {
      expect(sanitizePath("my/nested/path")).toBe("my_nested_path");
      expect(sanitizePath("/absolute/path")).toBe("_absolute_path");
    });

    it("should replace backslashes (Windows)", () => {
      expect(sanitizePath("my\\nested\\path")).toBe("my_nested_path");
      // Two ".." -> two "_", two "\\" -> two "_" = ____etc_passwd
      expect(sanitizePath("..\\..\\etc\\passwd")).toBe("____etc_passwd");
    });

    it("should replace leading dots", () => {
      // Single leading dot gets replaced
      expect(sanitizePath(".hidden")).toBe("_hidden");
      // "..." -> ".." replaced by "_", leaving "_.config", then leading dot replaced
      // Actually: "..." -> first ".." becomes "_", leaving "_.config"
      // The remaining "." is not at the start after the replacement
      expect(sanitizePath("...config")).toBe("_.config");
    });
  });

  describe("invalid filesystem characters", () => {
    it("should replace special characters", () => {
      expect(sanitizePath("file<name>")).toBe("file_name_");
      expect(sanitizePath('file"name')).toBe("file_name");
      expect(sanitizePath("file:name")).toBe("file_name");
      expect(sanitizePath("file|name")).toBe("file_name");
      expect(sanitizePath("file?name")).toBe("file_name");
      expect(sanitizePath("file*name")).toBe("file_name");
    });

    it("should replace control characters", () => {
      expect(sanitizePath("file\x00name")).toBe("file_name");
      expect(sanitizePath("file\x1fname")).toBe("file_name");
    });
  });

  describe("valid names", () => {
    it("should preserve valid module names", () => {
      expect(sanitizePath("my_module")).toBe("my_module");
      expect(sanitizePath("MyModule")).toBe("MyModule");
      expect(sanitizePath("module123")).toBe("module123");
      expect(sanitizePath("r#raw_ident")).toBe("r#raw_ident");
    });

    it("should preserve underscores and hyphens", () => {
      expect(sanitizePath("my-module")).toBe("my-module");
      expect(sanitizePath("my_module")).toBe("my_module");
      expect(sanitizePath("_private")).toBe("_private");
    });

    it("should handle empty string by returning 'unnamed'", () => {
      expect(sanitizePath("")).toBe("unnamed");
      expect(sanitizePath("   ")).toBe("unnamed"); // whitespace-only also returns "unnamed"
    });
  });

  describe("edge cases", () => {
    it("should handle complex attack patterns", () => {
      // Complex traversal attempt
      expect(sanitizePath("../../../../../../../etc/passwd")).not.toContain("..");
      expect(sanitizePath("../../../../../../../etc/passwd")).not.toContain("/");

      // Mixed separators
      expect(sanitizePath("../..\\..")).not.toContain("..");
      expect(sanitizePath("../..\\..")).not.toContain("\\");

      // Encoded-looking patterns (should be treated as literal)
      expect(sanitizePath("%2e%2e%2f")).toBe("%2e%2e%2f");
    });

    it("should produce filesystem-safe output", () => {
      const unsafe = "../../../etc/passwd<script>alert(1)</script>";
      const safe = sanitizePath(unsafe);

      // Should not contain path separators
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");

      // Should not contain parent directory reference
      expect(safe).not.toContain("..");

      // Should not contain dangerous characters
      expect(safe).not.toContain("<");
      expect(safe).not.toContain(">");
    });

    it("strips embedded null bytes", () => {
      const result = sanitizePath("file\x00name.mdx");
      expect(result).not.toContain("\x00");
      expect(result).toBe("file_name.mdx");
    });

    it("strips full C0 control range", () => {
      for (let code = 0; code <= 0x1f; code++) {
        const result = sanitizePath(`a${String.fromCharCode(code)}b`);
        expect(result).toBe("a_b");
      }
    });

    it("truncates extremely long names to the 255-byte filesystem limit", () => {
      const result = sanitizePath("a".repeat(1000));
      expect(result.length).toBeLessThanOrEqual(255);
      expect(result.length).toBe(255);
    });

    it("preserves a short file extension when truncating", () => {
      const base = "a".repeat(300);
      const result = sanitizePath(`${base}.mdx`);
      expect(result.endsWith(".mdx")).toBe(true);
      expect(result.length).toBeLessThanOrEqual(255);
    });

    it("normalizes decomposed Unicode to NFC", () => {
      // "café" expressed as 'e' + combining acute (decomposed form)
      const decomposed = "cafe\u0301";
      const composed = "caf\u00e9";
      expect(decomposed.normalize("NFC")).toBe(composed);
      expect(sanitizePath(decomposed)).toBe(composed);
    });

    it("handles Unicode input without stripping multi-byte characters", () => {
      expect(sanitizePath("モジュール")).toBe("モジュール");
      expect(sanitizePath("🚀launch")).toBe("🚀launch");
    });

    it("handles a mix of traversal + special + control chars together", () => {
      const input = "../foo:bar<baz>\x01.mdx";
      const result = sanitizePath(input);
      expect(result).not.toContain("..");
      expect(result).not.toContain("/");
      expect(result).not.toContain(":");
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
      expect(result).not.toContain("\x01");
    });
  });
});

describe("sanitizeDocstring", () => {
  it("leaves plain prose untouched", () => {
    expect(sanitizeDocstring("Hello world.")).toBe("Hello world.");
  });

  it("passes through already-safe markdown", () => {
    const src = "# Heading\n\nA paragraph with **bold** and `inline code`.";
    expect(sanitizeDocstring(src)).toBe(src);
  });

  it("escapes `<` before a digit (<40 LOC)", () => {
    expect(sanitizeDocstring("(<40 LOC each)")).toBe("(&lt;40 LOC each)");
  });

  it("escapes URL autolinks", () => {
    expect(sanitizeDocstring("Spec: <https://example.com/a/b>.")).toBe(
      "Spec: &lt;https://example.com/a/b&gt;."
    );
  });

  it("escapes mailto autolinks", () => {
    expect(sanitizeDocstring("Write <mailto:x@y.z>.")).toBe("Write &lt;mailto:x@y.z&gt;.");
  });

  it("escapes metasyntactic `<word>` placeholders", () => {
    expect(sanitizeDocstring("path `testvectors/<encoding>/basic.json`")).toBe(
      "path `testvectors/<encoding>/basic.json`"
    );
    expect(sanitizeDocstring("Accepts <encoding> names.")).toBe("Accepts &lt;encoding&gt; names.");
  });

  it("preserves safe inline HTML tags", () => {
    expect(sanitizeDocstring("use <kbd>Ctrl</kbd>")).toBe("use <kbd>Ctrl</kbd>");
    expect(sanitizeDocstring("<br>line break")).toBe("<br>line break");
  });

  it("escapes Rust-style generics", () => {
    expect(sanitizeDocstring("See `Opaque<T>` and `Sealed<T>`")).toBe(
      "See `Opaque<T>` and `Sealed<T>`"
    );
    expect(sanitizeDocstring("The Opaque<T> primitive wraps keys.")).toBe(
      "The Opaque&lt;T&gt; primitive wraps keys."
    );
  });

  it("preserves JSX-like components with attributes", () => {
    // Tab/Tabs are emitted by rustdoc-to-fumadocs; don't corrupt them.
    const src = '<Tab value="API"><code>foo</code></Tab>';
    expect(sanitizeDocstring(src)).toBe(src);
  });

  it("does not escape content inside fenced code blocks", () => {
    const src = "```rust\nlet x: Opaque<T> = ...;\n```";
    expect(sanitizeDocstring(src)).toBe(src);
  });

  it("rewrites compile_fail fence langs to rust + title", () => {
    const src = "```compile_fail\nfn x() { bad_code }\n```";
    const out = sanitizeDocstring(src);
    expect(out).toContain('```rust title="compile_fail"');
    expect(out).toContain("fn x() { bad_code }");
  });

  it("rewrites ignore/no_run/should_panic fence langs", () => {
    for (const directive of ["ignore", "no_run", "should_panic"]) {
      const src = `\`\`\`${directive}\nfn main() {}\n\`\`\``;
      const out = sanitizeDocstring(src);
      expect(out).toContain(`\`\`\`rust title="${directive}"`);
    }
  });

  it("rewrites editionYYYY fence langs", () => {
    const src = "```edition2021\nfn main() {}\n```";
    const out = sanitizeDocstring(src);
    expect(out).toContain('```rust title="edition2021"');
  });

  it("is idempotent (applying twice yields the same output)", () => {
    const src = "Spec: <https://example.com>. Opaque<T> works.";
    const once = sanitizeDocstring(src);
    const twice = sanitizeDocstring(once);
    expect(twice).toBe(once);
  });

  it("handles empty and null inputs gracefully", () => {
    expect(sanitizeDocstring("")).toBe("");
    expect(sanitizeDocstring(undefined as unknown as string)).toBe(undefined as unknown as string);
  });
});
