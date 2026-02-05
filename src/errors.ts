/**
 * Custom error types for rustdoc-to-fumadocs.
 *
 * @module errors
 * @description Provides structured error types with codes, hints, and context
 * for better error reporting and recovery suggestions.
 */

/**
 * Error codes for categorizing errors in the rustdoc-to-fumadocs tool.
 * Each code represents a specific failure scenario.
 */
export enum ErrorCode {
  /** JSON parsing failed - malformed JSON syntax */
  INVALID_JSON = "INVALID_JSON",

  /** Rustdoc format version is outside supported range (35-57) */
  UNSUPPORTED_FORMAT_VERSION = "UNSUPPORTED_FORMAT_VERSION",

  /** Root module ID specified in crate.root doesn't exist in the index */
  MISSING_ROOT_MODULE = "MISSING_ROOT_MODULE",

  /** An item in the index has invalid structure (missing required fields) */
  INVALID_ITEM_STRUCTURE = "INVALID_ITEM_STRUCTURE",

  /** Encountered an item kind not recognized by the generator */
  UNKNOWN_ITEM_KIND = "UNKNOWN_ITEM_KIND",

  /** Type reference could not be resolved (external crate or missing item) */
  UNRESOLVED_TYPE = "UNRESOLVED_TYPE",

  /** Referenced item ID not found in the index */
  MISSING_ITEM_REFERENCE = "MISSING_ITEM_REFERENCE",

  /** Failed to write output files to disk */
  OUTPUT_WRITE_FAILED = "OUTPUT_WRITE_FAILED",

  /** Failed to read input file from disk */
  INPUT_READ_FAILED = "INPUT_READ_FAILED",
}

/**
 * Custom error class for rustdoc-to-fumadocs with structured error information.
 *
 * Includes an error code for categorization, optional recovery hints,
 * and additional context for debugging.
 *
 * @example
 * ```typescript
 * throw new RustdocError(
 *   ErrorCode.UNSUPPORTED_FORMAT_VERSION,
 *   `Format version 99 is not supported`,
 *   {
 *     hint: "This tool supports format versions 35-57 (Rust 1.76+). Update rustdoc or use an older tool version.",
 *     context: { version: 99, minSupported: 35, maxSupported: 57 }
 *   }
 * );
 * ```
 */
export class RustdocError extends Error {
  /** Categorization code for the error */
  public readonly code: ErrorCode;

  /** Optional recovery suggestion for the user */
  public readonly hint?: string;

  /** Additional context for debugging (item IDs, paths, etc.) */
  public readonly context?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { hint?: string; context?: Record<string, unknown> }
  ) {
    super(message);
    this.name = "RustdocError";
    this.code = code;
    this.hint = options?.hint;
    this.context = options?.context;

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RustdocError);
    }
  }

  /**
   * Formats the error for display with code, message, and optional hint.
   *
   * @returns Formatted error string
   *
   * @example
   * ```
   * [UNSUPPORTED_FORMAT_VERSION] Format version 99 is not supported
   * Hint: This tool supports format versions 35-57 (Rust 1.76+).
   * ```
   */
  override toString(): string {
    let result = `[${this.code}] ${this.message}`;
    if (this.hint) {
      result += `\nHint: ${this.hint}`;
    }
    if (this.context && Object.keys(this.context).length > 0) {
      result += `\nContext: ${JSON.stringify(this.context, null, 2)}`;
    }
    return result;
  }

  /**
   * Creates a JSON representation of the error for programmatic use.
   *
   * @returns Object with code, message, hint, and context
   */
  toJSON(): {
    code: ErrorCode;
    message: string;
    hint?: string;
    context?: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      context: this.context,
    };
  }
}

/**
 * Severity level for generation warnings.
 */
export type WarningSeverity = "info" | "warning" | "error";

/**
 * Represents a non-fatal warning during generation.
 *
 * Warnings are collected during generation and can be displayed
 * to the user without stopping the process.
 *
 * @example
 * ```typescript
 * const warning: GenerationWarning = {
 *   code: ErrorCode.UNKNOWN_ITEM_KIND,
 *   message: 'Unknown item kind "new_feature" - skipping',
 *   itemId: "0:123:456",
 *   itemName: "some_item",
 *   suggestion: "Update rustdoc-to-fumadocs to support this item kind",
 *   severity: "warning",
 * };
 * ```
 */
export interface GenerationWarning {
  /** Warning code for categorization */
  code: ErrorCode;

  /** Human-readable warning message */
  message: string;

  /** Item ID where the warning occurred (if applicable) */
  itemId?: string;

  /** Item name for easier identification (if available) */
  itemName?: string;

  /** Suggested action to resolve or work around the issue */
  suggestion?: string;

  /** Severity level of the warning (default: "warning") */
  severity?: WarningSeverity;
}

/**
 * Type guard to check if an error is a RustdocError.
 *
 * @param error - Error to check
 * @returns true if error is a RustdocError
 *
 * @example
 * ```typescript
 * try {
 *   validateRustdocJson(data);
 * } catch (err) {
 *   if (isRustdocError(err)) {
 *     console.error(err.toString()); // Formatted error with hint
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export function isRustdocError(error: unknown): error is RustdocError {
  return error instanceof RustdocError;
}

/**
 * Creates a RustdocError for input file read failures.
 *
 * @param path - Path to the file that couldn't be read
 * @param cause - Original error (ENOENT, EACCES, etc.)
 * @returns Configured RustdocError
 */
export function inputReadError(path: string, cause?: Error): RustdocError {
  const message = cause
    ? `Failed to read input file: ${path} (${cause.message})`
    : `Failed to read input file: ${path}`;

  return new RustdocError(ErrorCode.INPUT_READ_FAILED, message, {
    hint: "Check that the file exists and you have read permissions.",
    context: { path, originalError: cause?.message },
  });
}

/**
 * Creates a RustdocError for output write failures.
 *
 * @param path - Path where writing failed
 * @param cause - Original error
 * @returns Configured RustdocError
 */
export function outputWriteError(path: string, cause?: Error): RustdocError {
  const message = cause
    ? `Failed to write output file: ${path} (${cause.message})`
    : `Failed to write output file: ${path}`;

  return new RustdocError(ErrorCode.OUTPUT_WRITE_FAILED, message, {
    hint: "Check that the output directory exists and you have write permissions.",
    context: { path, originalError: cause?.message },
  });
}
