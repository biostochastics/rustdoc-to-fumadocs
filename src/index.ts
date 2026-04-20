/**
 * rustdoc-to-fumadocs
 *
 * Convert rustdoc JSON output to Fumadocs-compatible MDX files.
 *
 * @example
 * ```typescript
 * import { RustdocGenerator } from 'rustdoc-to-fumadocs';
 * import { readFileSync } from 'fs';
 *
 * const crate = JSON.parse(readFileSync('target/doc/my_crate.json', 'utf-8'));
 * const generator = new RustdocGenerator(crate, {
 *   output: 'content/docs/api',
 *   baseUrl: '/docs/api',
 * });
 *
 * const files = generator.generate();
 * // Write files to disk...
 * ```
 */

export {
  RustdocGenerator,
  sanitizePath,
  type GeneratorOptions,
  type GeneratedFile,
} from "./generator.js";
export * from "./types.js";
export * from "./errors.js";
export {
  validateRustdocJson,
  parseJsonSafe,
  validateFormatVersion,
  RustdocCrateSchema,
  MIN_FORMAT_VERSION,
  MAX_FORMAT_VERSION,
  type ValidatedRustdocCrate,
  type FormatVersionResult,
} from "./validation.js";

// Renderer utilities for advanced usage
export {
  RenderContext,
  formatType,
  formatGenericArg,
  formatGenericBound,
  formatFunctionSignature,
  formatStructSignature,
  formatUnionSignature,
  formatEnumSignature,
  formatTraitSignature,
  formatGenerics,
  formatGenericParam,
  defaultRenderOptions,
  type RenderOptions,
  type FumaDocsComponent,
  type GenerationWarning,
  type WarningSeverity,
} from "./renderer/index.js";

// Cargo workspace helpers for programmatic multi-crate generation.
export {
  loadWorkspace,
  findMemberRustdocJson,
  renderWorkspaceMeta,
  renderWorkspaceIndex,
  type Workspace,
  type WorkspaceMember,
} from "./workspace.js";
