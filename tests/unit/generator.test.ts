/**
 * Tests for generator.ts security and utility functions.
 */

import { describe, it, expect } from "vitest";
import { sanitizePath } from "../../src/generator.js";

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
  });
});
