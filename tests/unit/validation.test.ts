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
import { RustdocGenerator } from "../../src/generator.js";
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

  it("accepts format 60 (Rust 1.98) without a version warning", () => {
    const data: unknown = JSON.parse(
      readFileSync(join(fixturesDir, "kitchen_sink.v60.json"), "utf-8")
    );
    const { crate, warnings } = validateRustdocJson(data);
    expect(crate.format_version).toBe(60);
    expect(warnings).toEqual([]);
  });

  it("keeps the format 58-60 stability fields instead of stripping them", () => {
    const data = JSON.parse(readFileSync(join(fixturesDir, "minimal.json"), "utf-8")) as {
      format_version: number;
      index: Record<string, Record<string, unknown>>;
    };
    data.format_version = 60;
    const item = data.index["0:1:0"];
    item.stability = { level: "unstable", feature: "my_feature" };
    item.const_stability = null;
    const { crate } = validateRustdocJson(data);
    expect(crate.index["0:1:0"].stability).toEqual({ level: "unstable", feature: "my_feature" });
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

describe("normalizing real rustdoc representations", () => {
  const input = (): { index: Record<string, Record<string, unknown>>; format_version: number } =>
    JSON.parse(readFileSync(join(fixturesDir, "minimal.json"), "utf8")) as {
      index: Record<string, Record<string, unknown>>;
      format_version: number;
    };

  it("validates known nested payloads with the item and member path", () => {
    const data = input();
    data.index["0:0:0"].inner = { module: {} };
    expect(() => validateRustdocJson(data)).toThrow(/index\.0:0:0\.inner\.module\.items/);
  });

  it("normalizes unit variants, format-61 stability and return type notation", () => {
    const data = input();
    data.format_version = 61;
    data.index["0:1:0"].inner = "extern_type";
    data.index["0:1:0"].stability = { feature: "base", level: { stable: { since: "1.99.0" } } };
    data.index["0:2:0"].inner = {
      type_alias: {
        generics: { params: [], where_predicates: [] },
        type: {
          qualified_path: {
            name: "lend",
            args: "return_type_notation",
            self_type: "infer",
            trait: null,
          },
        },
      },
    };
    const { crate } = validateRustdocJson(data);
    expect(crate.index["0:1:0"].inner).toEqual({ foreign_type: true });
    expect(crate.index["0:1:0"].stability).toMatchObject({ level: "stable", since: "1.99.0" });
    expect(crate.index["0:2:0"].inner).toMatchObject({
      type_alias: {
        type: {
          qualified_path: {
            args: { return_type_notation: true },
            self_type: { infer: true },
          },
        },
      },
    });
  });
});

it("reports a future schema to raw library callers once per generator", () => {
  const input = JSON.parse(readFileSync(join(fixturesDir, "minimal.json"), "utf8"));
  input.format_version = MAX_FORMAT_VERSION + 1;
  const warnings: string[] = [];
  const generator = new RustdocGenerator(input, {
    output: "",
    baseUrl: "/api",
    onWarning: (warning) => warnings.push(warning),
  });
  generator.pageIndex();
  generator.generate();
  expect(warnings.filter((w) => w.includes("newer than the latest known version"))).toHaveLength(1);
});
