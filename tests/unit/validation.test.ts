/**
 * Unit tests for validation.ts - Zod schema validation and format version checks.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRustdocJson,
  validateFormatVersion,
  parseJsonSafe,
  MIN_FORMAT_VERSION,
  MAX_FORMAT_VERSION,
} from "../../src/validation.js";
import { RustdocError, ErrorCode, isRustdocError } from "../../src/errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "..", "fixtures");

describe("validateFormatVersion", () => {
  it("accepts minimum supported version", () => {
    const result = validateFormatVersion(MIN_FORMAT_VERSION);
    expect(result.supported).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("accepts maximum known version", () => {
    const result = validateFormatVersion(MAX_FORMAT_VERSION);
    expect(result.supported).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("accepts versions between min and max", () => {
    const midVersion = Math.floor((MIN_FORMAT_VERSION + MAX_FORMAT_VERSION) / 2);
    const result = validateFormatVersion(midVersion);
    expect(result.supported).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("returns warning for version newer than max", () => {
    const result = validateFormatVersion(MAX_FORMAT_VERSION + 5);
    expect(result.supported).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("newer than the latest known version");
  });

  it("throws RustdocError for version below minimum", () => {
    expect(() => validateFormatVersion(MIN_FORMAT_VERSION - 1)).toThrow(RustdocError);

    try {
      validateFormatVersion(MIN_FORMAT_VERSION - 1);
    } catch (err) {
      expect(isRustdocError(err)).toBe(true);
      if (isRustdocError(err)) {
        expect(err.code).toBe(ErrorCode.UNSUPPORTED_FORMAT_VERSION);
        expect(err.hint).toBeDefined();
        expect(err.hint).toContain("Rust 1.76");
      }
    }
  });

  it("throws RustdocError for very old versions", () => {
    expect(() => validateFormatVersion(1)).toThrow(RustdocError);
  });
});

describe("validateRustdocJson", () => {
  it("validates minimal fixture successfully", () => {
    const content = readFileSync(join(fixturesDir, "minimal.json"), "utf-8");
    const data = JSON.parse(content);

    const { crate, warnings } = validateRustdocJson(data);

    expect(crate).toBeDefined();
    expect(crate.root).toBe("0:0:0");
    expect(crate.format_version).toBe(57);
    expect(crate.index["0:0:0"]).toBeDefined();
    expect(crate.index["0:0:0"].name).toBe("test_crate");
    expect(warnings).toEqual([]);
  });

  it("throws for non-object input", () => {
    expect(() => validateRustdocJson("not an object")).toThrow(RustdocError);
    expect(() => validateRustdocJson(null)).toThrow(RustdocError);
    expect(() => validateRustdocJson(123)).toThrow(RustdocError);
    expect(() => validateRustdocJson([])).toThrow(RustdocError);
  });

  it("throws with INVALID_JSON code for non-object input", () => {
    try {
      validateRustdocJson("string");
    } catch (err) {
      expect(isRustdocError(err)).toBe(true);
      if (isRustdocError(err)) {
        expect(err.code).toBe(ErrorCode.INVALID_JSON);
      }
    }
  });

  it("throws for missing format_version", () => {
    const data = {
      root: "0:0:0",
      includes_private: false,
      index: {},
      paths: {},
      external_crates: {},
    };

    expect(() => validateRustdocJson(data)).toThrow(RustdocError);

    try {
      validateRustdocJson(data);
    } catch (err) {
      expect(isRustdocError(err)).toBe(true);
      if (isRustdocError(err)) {
        expect(err.code).toBe(ErrorCode.INVALID_JSON);
        expect(err.message).toContain("format_version");
      }
    }
  });

  it("throws for old format version", () => {
    const data = {
      root: "0:0:0",
      includes_private: false,
      index: {},
      paths: {},
      external_crates: {},
      format_version: 20,
    };

    expect(() => validateRustdocJson(data)).toThrow(RustdocError);

    try {
      validateRustdocJson(data);
    } catch (err) {
      expect(isRustdocError(err)).toBe(true);
      if (isRustdocError(err)) {
        expect(err.code).toBe(ErrorCode.UNSUPPORTED_FORMAT_VERSION);
        expect(err.hint).toContain("Rust 1.76");
      }
    }
  });

  it("throws for missing root module in index", () => {
    const data = {
      root: "nonexistent:0:0",
      includes_private: false,
      index: {},
      paths: {},
      external_crates: {},
      format_version: 57,
    };

    expect(() => validateRustdocJson(data)).toThrow(RustdocError);

    try {
      validateRustdocJson(data);
    } catch (err) {
      expect(isRustdocError(err)).toBe(true);
      if (isRustdocError(err)) {
        expect(err.code).toBe(ErrorCode.MISSING_ROOT_MODULE);
      }
    }
  });

  it("throws for invalid item structure in index", () => {
    const data = {
      root: "0:0:0",
      includes_private: false,
      index: {
        "0:0:0": {
          // Missing required fields like id, crate_id, visibility, inner
          name: "broken",
        },
      },
      paths: {},
      external_crates: {},
      format_version: 57,
    };

    expect(() => validateRustdocJson(data)).toThrow(RustdocError);

    try {
      validateRustdocJson(data);
    } catch (err) {
      expect(isRustdocError(err)).toBe(true);
      if (isRustdocError(err)) {
        expect(err.code).toBe(ErrorCode.INVALID_ITEM_STRUCTURE);
      }
    }
  });

  it("returns warnings for newer format versions", () => {
    const content = readFileSync(join(fixturesDir, "minimal.json"), "utf-8");
    const data = JSON.parse(content);
    // Modify to use a future version
    data.format_version = MAX_FORMAT_VERSION + 10;

    const { crate, warnings } = validateRustdocJson(data);

    expect(crate).toBeDefined();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("newer than the latest known version");
  });
});

describe("parseJsonSafe", () => {
  it("parses valid JSON successfully", () => {
    const result = parseJsonSafe('{"key": "value"}', "test.json");
    expect(result).toEqual({ key: "value" });
  });

  it("throws RustdocError for invalid JSON syntax", () => {
    expect(() => parseJsonSafe("{invalid json}", "test.json")).toThrow(RustdocError);

    try {
      parseJsonSafe("{not: valid: json}", "bad.json");
    } catch (err) {
      expect(isRustdocError(err)).toBe(true);
      if (isRustdocError(err)) {
        expect(err.code).toBe(ErrorCode.INVALID_JSON);
        expect(err.message).toContain("bad.json");
        expect(err.hint).toContain("invalid JSON syntax");
      }
    }
  });

  it("throws RustdocError for truncated JSON", () => {
    expect(() => parseJsonSafe('{"incomplete": ', "truncated.json")).toThrow(RustdocError);
  });

  it("throws RustdocError for empty input", () => {
    expect(() => parseJsonSafe("", "empty.json")).toThrow(RustdocError);
  });
});

describe("isRustdocError", () => {
  it("returns true for RustdocError instances", () => {
    const error = new RustdocError(ErrorCode.INVALID_JSON, "test error");
    expect(isRustdocError(error)).toBe(true);
  });

  it("returns false for regular Error instances", () => {
    const error = new Error("regular error");
    expect(isRustdocError(error)).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isRustdocError("string")).toBe(false);
    expect(isRustdocError(null)).toBe(false);
    expect(isRustdocError(undefined)).toBe(false);
    expect(isRustdocError({})).toBe(false);
  });
});
