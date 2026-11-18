/**
 * Zod validation schemas for rustdoc JSON.
 *
 * @module validation
 * @description Validates rustdoc JSON structure using Zod schemas with
 * support for format versions 27-61 (Rust 1.76+).
 *
 * Known payloads are validated with paths into the input. Unknown item variants
 * are retained so that newer producers can still document recognized items.
 */

import { z } from "zod";
import { normalizeLegacyCrate } from "./legacy.js";
import { RustdocError, ErrorCode } from "./errors.js";
import { idSchema as IdSchema, innerSchema } from "./rustdoc-schema.js";
import type { RustdocCrate } from "./types.js";

/**
 * Minimum supported rustdoc format version (Rust 1.76).
 */
export const MIN_FORMAT_VERSION = 27;

const validated = new WeakSet<RustdocCrate>();

/**
 * Maximum known rustdoc format version (61: Rust 1.99–1.100).
 * Versions higher than this will trigger a warning but not fail.
 *
 * 58-60 are additive over 57: `Item.stability`, `Item.const_stability` and
 * `default_unstable` on functions and associated items.
 */
export const MAX_FORMAT_VERSION = 61;

/**
 * Schema for ItemSummary in the paths index.
 */
const ItemSummarySchema = z.object({
  crate_id: z.number(),
  path: z.array(z.string()),
  kind: z.string(), // Don't strictly validate - allow new kinds
});

/**
 * Schema for ExternalCrate entries.
 */
const ExternalCrateSchema = z.object({
  name: z.string(),
  html_root_url: z.string().nullish(),
});

/**
 * Schema for Item visibility.
 * Can be a string or an object with restricted path.
 * The parent may be a numeric or string ID.
 */
const VisibilitySchema = z.union([
  z.literal("public"),
  z.literal("default"),
  z.literal("crate"),
  z.object({
    restricted: z.object({
      parent: IdSchema,
      path: z.string(),
    }),
  }),
]);

/**
 * Schema for deprecation information.
 * Rustdoc JSON uses null for non-deprecated items.
 */
const DeprecationSchema = z
  .object({
    since: z.string().nullish(),
    note: z.string().nullish(),
  })
  .nullish();

/**
 * Schema for source code span.
 * Rustdoc JSON uses null for missing spans, so we need nullish().
 */
const SpanSchema = z
  .object({
    filename: z.string(),
    begin: z.tuple([z.number(), z.number()]),
    end: z.tuple([z.number(), z.number()]),
  })
  .nullish();

/**
 * Schema for the stability attributes of format 58+ (`#[stable]` /
 * `#[unstable]`; only set for crates using staged_api, e.g. std).
 */
const StabilitySchema = z
  .looseObject({
    feature: z.string().nullish(),
    since: z.string().nullish(),
    level: z.union([
      z.string(),
      z.object({ stable: z.looseObject({ since: z.string().nullish() }) }),
    ]),
  })
  .transform((stability) =>
    typeof stability.level === "string"
      ? stability
      : { ...stability, level: "stable", since: stability.level.stable.since }
  )
  .nullish();

/** Validate the known payload of each item and retain new metadata. */
const ItemSchema = z.looseObject({
  id: IdSchema,
  crate_id: z.number(),
  name: z.string().nullish(), // name can be null for some items (impl blocks)
  span: SpanSchema,
  visibility: VisibilitySchema,
  docs: z.string().nullish(),
  links: z.record(z.string(), IdSchema).optional().default({}),
  // In format 56+, attrs can be objects like { "other": "#[...]" } or { "must_use": { "reason": null } }
  attrs: z
    .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
    .optional()
    .default([]),
  deprecation: DeprecationSchema,
  stability: StabilitySchema, // format 58+
  const_stability: StabilitySchema, // format 58+
  inner: innerSchema,
});
/**
 * Main schema for RustdocCrate.
 *
 * Validates the top-level structure of rustdoc JSON output.
 * Format version is checked separately with helpful error messages.
 */
const crateSchema = z.compile(
  z.object({
    root: IdSchema,
    crate_version: z.string().nullish(),
    includes_private: z.boolean(),
    index: z.record(z.string(), ItemSchema),
    paths: z.record(z.string(), ItemSummarySchema),
    external_crates: z.record(z.string(), ExternalCrateSchema),
    format_version: z.number().int().nonnegative(),
  })
);

/** Normalize older wire formats before applying the current payload checks. */
export const RustdocCrateSchema = z.preprocess((data) => {
  if (
    data &&
    typeof data === "object" &&
    "format_version" in data &&
    typeof data.format_version === "number" &&
    data.format_version < 35
  ) {
    return normalizeLegacyCrate(data);
  }
  return data;
}, crateSchema);

/**
 * Type for validated rustdoc crate (matches RustdocCrate interface).
 */
export type ValidatedRustdocCrate = z.infer<typeof RustdocCrateSchema>;

/**
 * Result of format version validation.
 */
export interface FormatVersionResult {
  /** Whether the version is supported */
  supported: boolean;
  /** Warning message if version is newer than known */
  warning?: string;
}

/**
 * Validates the format version of rustdoc JSON.
 *
 * @param version - Format version from the JSON
 * @returns Result indicating support status and any warnings
 * @throws RustdocError if version is below minimum supported
 */
export function validateFormatVersion(version: number): FormatVersionResult {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RustdocError(ErrorCode.INVALID_JSON, "format_version must be a non-negative integer");
  }
  if (version < MIN_FORMAT_VERSION) {
    throw new RustdocError(
      ErrorCode.UNSUPPORTED_FORMAT_VERSION,
      `Rustdoc format version ${version} is too old (minimum: ${MIN_FORMAT_VERSION})`,
      {
        hint:
          `This tool requires rustdoc format version ${MIN_FORMAT_VERSION}+ (Rust 1.76+). ` +
          `Regenerate your documentation with a newer Rust version:\n` +
          `  RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps`,
        context: {
          version,
          minSupported: MIN_FORMAT_VERSION,
          maxSupported: MAX_FORMAT_VERSION,
        },
      }
    );
  }

  if (version > MAX_FORMAT_VERSION) {
    return {
      supported: true,
      warning:
        `Rustdoc format version ${version} is newer than the latest known version (${MAX_FORMAT_VERSION}). ` +
        `Some features may not be fully supported. Consider updating rustdoc-to-fumadocs.`,
    };
  }

  return { supported: true };
}

/**
 * Validates rustdoc JSON data and returns a typed RustdocCrate.
 *
 * Performs validation in order:
 * 1. Check format version with helpful error messages
 * 2. Validate schema structure with Zod
 * 3. Verify root module exists in the index
 *
 * @param data - Raw JSON data (unknown type)
 * @returns Validated RustdocCrate
 * @throws RustdocError with appropriate code and hint
 *
 * @example
 * ```typescript
 * const content = readFileSync("crate.json", "utf-8");
 * const data = JSON.parse(content);
 * const { crate, warnings } = validateRustdocJson(data);
 * // crate is now typed as RustdocCrate
 * ```
 */
export function validateRustdocJson(data: unknown): {
  crate: RustdocCrate;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Step 1: Basic type check
  if (typeof data !== "object" || data === null) {
    throw new RustdocError(ErrorCode.INVALID_JSON, "Rustdoc JSON must be an object", {
      hint: "Ensure you're providing valid rustdoc JSON output, not a string or other type.",
      context: { receivedType: typeof data },
    });
  }

  // Step 2: Check format version first for helpful error messages
  const obj = data as Record<string, unknown>;

  if (typeof obj.format_version !== "number") {
    throw new RustdocError(ErrorCode.INVALID_JSON, "Missing or invalid format_version field", {
      hint:
        "This doesn't appear to be valid rustdoc JSON. Make sure you generated it with:\n" +
        '  RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps',
      context: { format_version: obj.format_version },
    });
  }

  const versionResult = validateFormatVersion(obj.format_version);
  if (versionResult.warning) {
    warnings.push(versionResult.warning);
  }

  // Step 3: Validate schema with Zod
  let result: ReturnType<typeof RustdocCrateSchema.safeParse>;
  try {
    result = RustdocCrateSchema.safeParse(data);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new RustdocError(
      ErrorCode.INVALID_ITEM_STRUCTURE,
      "Rustdoc item payload exceeds the supported nesting depth",
      {
        hint: "Check for deeply nested types or circular values in programmatic input.",
      }
    );
  }

  if (!result.success) {
    const issues = result.error.issues;
    const firstIssue = issues[0];
    const path = firstIssue.path.join(".");

    throw new RustdocError(
      ErrorCode.INVALID_ITEM_STRUCTURE,
      `Invalid rustdoc JSON structure at "${path}": ${firstIssue.message}`,
      {
        hint:
          "The rustdoc JSON has an unexpected structure. This may indicate:\n" +
          "- Corrupted JSON file\n" +
          "- Incompatible rustdoc version\n" +
          "- Manual editing of the JSON file\n" +
          "Try regenerating the documentation.",
        context: {
          path,
          code: firstIssue.code,
          expected: "expected" in firstIssue ? firstIssue.expected : undefined,
          received: "received" in firstIssue ? firstIssue.received : undefined,
          allIssues: issues.length > 1 ? issues.slice(0, 5) : undefined,
        },
      }
    );
  }

  const crate = result.data;

  // Step 4: Verify root module exists in index
  // Convert root ID to string for consistent lookup (JSON keys are always strings,
  // and numeric item IDs are stored under their decimal key)
  const rootKey = String(crate.root);
  if (!Object.hasOwn(crate.index, rootKey)) {
    throw new RustdocError(
      ErrorCode.MISSING_ROOT_MODULE,
      `Root module "${crate.root}" not found in index`,
      {
        hint:
          "The rustdoc JSON specifies a root module ID that doesn't exist in the item index. " +
          "This usually indicates corrupted output. Try regenerating:\n" +
          '  RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps',
        context: {
          root: crate.root,
          rootKey,
          indexSize: Object.keys(crate.index).length,
          sampleKeys: Object.keys(crate.index).slice(0, 5),
        },
      }
    );
  }

  const root = crate.index[rootKey];
  if (!root.inner || typeof root.inner !== "object" || !("module" in root.inner)) {
    throw new RustdocError(
      ErrorCode.INVALID_ITEM_STRUCTURE,
      `Root item is not a module: ${rootKey}`
    );
  }
  const normalized = crate as RustdocCrate;
  validated.add(normalized);
  return { crate: normalized, warnings };
}

/**
 * Safely parses JSON string with proper error handling.
 *
 * @param content - JSON string to parse
 * @param filePath - File path for error messages
 * @returns Parsed JSON data
 * @throws RustdocError if JSON is invalid
 */
export function parseJsonSafe(content: string, filePath: string): unknown {
  try {
    return JSON.parse(content);
  } catch (err) {
    const syntaxError = err as SyntaxError;
    throw new RustdocError(
      ErrorCode.INVALID_JSON,
      `Invalid JSON in ${filePath}: ${syntaxError.message}`,
      {
        hint:
          "The file contains invalid JSON syntax. Common issues:\n" +
          "- Truncated file (incomplete download/write)\n" +
          "- Binary file instead of JSON\n" +
          "- Wrong file selected",
        context: {
          filePath,
          parseError: syntaxError.message,
        },
      }
    );
  }
}

/** Accept raw library inputs as well as already normalized validator results. */
export function ensureRustdocCrate(
  crate: RustdocCrate,
  onWarning: (message: string) => void
): RustdocCrate {
  if (validated.has(crate)) return crate;
  const result = validateRustdocJson(crate);
  result.warnings.forEach(onWarning);
  return result.crate;
}
