/**
 * TypeScript types for rustdoc JSON output.
 * Based on rustdoc_json_types crate (format version ~57).
 * @see https://doc.rust-lang.org/nightly/nightly-rustc/rustdoc_json_types/
 */

export interface RustdocCrate {
  root: Id;
  crate_version?: string;
  includes_private: boolean;
  index: Record<Id, Item>;
  paths: Record<Id, ItemSummary>;
  external_crates: Record<string, ExternalCrate>;
  format_version: number;
}

/**
 * Item ID type. In format versions 35-55, IDs are strings like "0:123:456".
 * In format version 56+, IDs are numeric. We accept both for compatibility.
 * Note: JSON object keys are always strings, so index lookups use string keys.
 */
export type Id = string | number;

/**
 * Attribute format changed in format version 56+.
 * Old: "#[derive(Debug)]"
 * New: { "other": "#[derive(Debug)]" } or { "must_use": { "reason": null } }
 */
export type Attribute =
  | string
  | { other: string }
  | { must_use: { reason?: string | null } }
  | Record<string, unknown>;

export interface Item {
  id: Id;
  crate_id: number;
  name?: string;
  span?: Span;
  visibility: Visibility;
  docs?: string;
  links: Record<string, Id>;
  attrs: Attribute[];
  deprecation?: Deprecation;
  inner: ItemInner;
}

export interface ItemSummary {
  crate_id: number;
  path: string[];
  kind: ItemKind;
}

export interface ExternalCrate {
  name: string;
  html_root_url?: string;
}

export interface Span {
  filename: string;
  begin: [number, number];
  end: [number, number];
}

export type Visibility =
  | "public"
  | "default"
  | "crate"
  | { restricted: { parent: Id; path: string } };

export interface Deprecation {
  since?: string;
  note?: string;
}

export type ItemKind =
  | "module"
  | "extern_crate"
  | "use"
  | "struct"
  | "struct_field"
  | "union"
  | "enum"
  | "variant"
  | "function"
  | "type_alias"
  | "opaque_ty"
  | "constant"
  | "trait"
  | "trait_alias"
  | "impl"
  | "static"
  | "foreign_type"
  | "macro"
  | "proc_attribute"
  | "proc_derive"
  | "assoc_const"
  | "assoc_type"
  | "primitive"
  | "keyword";

// Discriminated union for item inner content
export type ItemInner =
  | { module: Module }
  | { extern_crate: ExternCrate }
  | { use: Use }
  | { struct: Struct }
  | { struct_field: Type }
  | { union: Union }
  | { enum: Enum }
  | { variant: Variant }
  | { function: Function }
  | { trait: Trait }
  | { trait_alias: TraitAlias }
  | { impl: Impl }
  | { type_alias: TypeAlias }
  | { constant: Constant }
  | { static: Static }
  | { macro: string }
  | { proc_macro: ProcMacro }
  | { primitive: Primitive }
  | { assoc_const: AssocConst }
  | { assoc_type: AssocType };

export interface Module {
  is_crate: boolean;
  items: Id[];
  is_stripped: boolean;
}

export interface ExternCrate {
  name: string;
  rename?: string;
}

export interface Use {
  source: string;
  name?: string;
  id?: Id;
  is_glob: boolean;
}

export interface Struct {
  kind: StructKind;
  generics: Generics;
  impls: Id[];
}

/**
 * Struct kind format changed in version 56+:
 * - Old: { "unit": true }
 * - New: "unit" (string literal)
 */
export type StructKind =
  | "unit" // Format 56+: string literal for unit structs
  | { unit: true } // Format 35-55: object for unit structs
  | { tuple: (Id | null)[] }
  | { plain: { fields: Id[]; has_stripped_fields: boolean } };

/**
 * Checks if a struct is a unit struct (no fields).
 *
 * Handles format version differences:
 * - Format 56+: Uses string literal `"unit"`
 * - Format 35-55: Uses object `{ unit: true }`
 *
 * @param kind - The struct kind to check
 * @returns true if this is a unit struct
 */
export function isUnitStruct(kind: StructKind): kind is "unit" | { unit: true } {
  return kind === "unit" || (typeof kind === "object" && "unit" in kind);
}

/**
 * Type guard for tuple structs.
 * Tuple structs contain an array of field IDs (null for stripped fields).
 *
 * @param kind - The struct kind to check
 * @returns true if this is a tuple struct
 */
export function isTupleStruct(kind: StructKind): kind is { tuple: (Id | null)[] } {
  return typeof kind === "object" && "tuple" in kind;
}

/**
 * Type guard for plain structs (structs with named fields).
 *
 * @param kind - The struct kind to check
 * @returns true if this is a plain struct with named fields
 */
export function isPlainStruct(
  kind: StructKind
): kind is { plain: { fields: Id[]; has_stripped_fields: boolean } } {
  return typeof kind === "object" && "plain" in kind;
}

export interface Union {
  generics: Generics;
  fields: Id[];
  has_stripped_fields: boolean;
  impls: Id[];
}

export interface Enum {
  generics: Generics;
  variants: Id[];
  has_stripped_variants: boolean;
  impls: Id[];
}

export interface Variant {
  kind: VariantKind;
  discriminant?: Discriminant;
}

/**
 * Variant kind format changed in version 56+:
 * - Old: { "plain": true }
 * - New: "plain" (string literal)
 */
export type VariantKind =
  | "plain" // Format 56+: string literal for unit variants
  | { plain: true } // Format 35-55: object for unit variants
  | { tuple: (Id | null)[] }
  | { struct: { fields: Id[]; has_stripped_fields: boolean } };

export interface Discriminant {
  expr: string;
  value: string;
}

export interface Function {
  sig: FunctionSignature;
  generics: Generics;
  header: FunctionHeader;
  has_body: boolean;
}

export interface FunctionSignature {
  inputs: [string, Type][];
  output?: Type;
}

export interface FunctionHeader {
  is_const: boolean;
  is_unsafe: boolean;
  is_async: boolean;
  abi: Abi;
}

export type Abi =
  | "Rust"
  | { C: { unwind: boolean } }
  | { System: { unwind: boolean } }
  | { Other: string };

export interface Trait {
  is_auto: boolean;
  is_unsafe: boolean;
  is_dyn_compatible: boolean;
  items: Id[];
  generics: Generics;
  bounds: GenericBound[];
  implementations: Id[];
}

export interface TraitAlias {
  generics: Generics;
  params: GenericBound[];
}

export interface Impl {
  is_unsafe: boolean;
  generics: Generics;
  provided_trait_methods: string[];
  trait?: Path;
  for: Type;
  items: Id[];
  is_negative: boolean;
  is_synthetic: boolean;
  blanket_impl?: Type;
}

export interface TypeAlias {
  type: Type;
  generics: Generics;
}

export interface Constant {
  type: Type;
  const: ConstExpr;
}

export interface ConstExpr {
  expr: string;
  value?: string | null;
  is_literal: boolean;
}

export interface Static {
  type: Type;
  is_mutable: boolean;
  expr: string;
}

export interface ProcMacro {
  kind: "bang" | "attr" | "derive";
  helpers: string[];
}

export interface Primitive {
  name: string;
  impls: Id[];
}

export interface AssocConst {
  type: Type;
  value?: string;
}

export interface AssocType {
  generics: Generics;
  bounds: GenericBound[];
  type?: Type;
}

// Generics
export interface Generics {
  params: GenericParamDef[];
  where_predicates: WherePredicate[];
}

export interface GenericParamDef {
  name: string;
  kind: GenericParamDefKind;
}

export type GenericParamDefKind =
  | { lifetime: { outlives: string[] } }
  | { type: { bounds: GenericBound[]; default?: Type; is_synthetic: boolean } }
  | { const: { type: Type; default?: string } };

export type WherePredicate =
  | { bound_predicate: { type: Type; bounds: GenericBound[]; generic_params: GenericParamDef[] } }
  | { lifetime_predicate: { lifetime: string; outlives: string[] } }
  | { eq_predicate: { lhs: Type; rhs: Term } };

export type GenericBound =
  | {
      trait_bound: { trait: Path; generic_params: GenericParamDef[]; modifier: TraitBoundModifier };
    }
  | { outlives: string }
  | { use: string[] };

export type TraitBoundModifier = "none" | "maybe" | "maybe_const";

// Types
export type Type =
  | { resolved_path: Path }
  | { dyn_trait: DynTrait }
  | { generic: string }
  | { primitive: string }
  | { function_pointer: FunctionPointer }
  | { tuple: Type[] }
  | { slice: Type }
  | { array: { type: Type; len: string } }
  | { pat: { type: Type; __pat_unstable_do_not_use: string } }
  | { impl_trait: GenericBound[] }
  | { infer: true }
  | { raw_pointer: { is_mutable: boolean; type: Type } }
  | { borrowed_ref: { lifetime?: string; is_mutable: boolean; type: Type } }
  | { qualified_path: { name: string; args: GenericArgs; self_type: Type; trait?: Path } };

export interface Path {
  name: string;
  id: Id;
  args?: GenericArgs;
}

export interface DynTrait {
  traits: PolyTrait[];
  lifetime?: string;
}

export interface PolyTrait {
  trait: Path;
  generic_params: GenericParamDef[];
}

export interface FunctionPointer {
  sig: FunctionSignature;
  generic_params: GenericParamDef[];
  header: FunctionHeader;
}

export type GenericArgs =
  | { angle_bracketed: { args: GenericArg[]; constraints: AssocItemConstraint[] } }
  | { parenthesized: { inputs: Type[]; output?: Type } };

export type GenericArg =
  | { lifetime: string }
  | { type: Type }
  | { const: Constant }
  | { infer: true };

export interface AssocItemConstraint {
  name: string;
  args: GenericArgs;
  binding: AssocItemConstraintKind;
}

export type AssocItemConstraintKind = { equality: Term } | { constraint: GenericBound[] };

export type Term = { type: Type } | { constant: Constant };

/**
 * Result type for getItemKind that allows graceful handling of unknown types.
 * Returns the ItemKind or "unknown" for forward compatibility with new rustdoc versions.
 */
export type ItemKindResult = ItemKind | "unknown";

/**
 * Extract the ItemKind from an ItemInner discriminated union.
 * This handles the mapping from the JSON structure to the string-based ItemKind.
 *
 * Special handling for proc_macro: the ItemKind distinguishes between
 * proc_attribute, proc_derive, and regular (bang) macros based on ProcMacro.kind.
 *
 * @param inner - The item's inner content from rustdoc JSON
 * @returns The ItemKind string, or "unknown" for unrecognized item types
 *
 * @example
 * ```typescript
 * const kind = getItemKind(item.inner);
 * if (kind === "unknown") {
 *   console.warn(`Unknown item kind: ${Object.keys(item.inner)}`);
 *   return; // Skip unknown items gracefully
 * }
 * ```
 */
export function getItemKind(inner: ItemInner): ItemKindResult {
  if ("module" in inner) return "module";
  if ("extern_crate" in inner) return "extern_crate";
  if ("use" in inner) return "use";
  if ("struct" in inner) return "struct";
  if ("struct_field" in inner) return "struct_field";
  if ("union" in inner) return "union";
  if ("enum" in inner) return "enum";
  if ("variant" in inner) return "variant";
  if ("function" in inner) return "function";
  if ("trait" in inner) return "trait";
  if ("trait_alias" in inner) return "trait_alias";
  if ("impl" in inner) return "impl";
  if ("type_alias" in inner) return "type_alias";
  if ("constant" in inner) return "constant";
  if ("static" in inner) return "static";
  if ("macro" in inner) return "macro";
  if ("proc_macro" in inner) {
    // Distinguish between proc_attribute, proc_derive, and bang macros
    const pm = inner.proc_macro;
    if (pm.kind === "attr") return "proc_attribute";
    if (pm.kind === "derive") return "proc_derive";
    return "macro"; // bang macro
  }
  if ("primitive" in inner) return "primitive";
  if ("assoc_const" in inner) return "assoc_const";
  if ("assoc_type" in inner) return "assoc_type";

  // Handle additional ItemKind variants that may appear in rustdoc JSON
  // These are less common but should be recognized to avoid warnings

  // Note: opaque_ty, foreign_type, and keyword don't have corresponding
  // ItemInner variants in the TypeScript types, but we check for them
  // to provide better forward compatibility warnings
  const innerKeys = Object.keys(inner as Record<string, unknown>);
  if (innerKeys.length === 1) {
    const key = innerKeys[0];
    // Map any recognized keys that don't have explicit ItemInner types
    if (key === "opaque_ty") return "opaque_ty";
    if (key === "foreign_type") return "foreign_type";
    if (key === "keyword") return "keyword";
  }

  // Return "unknown" for forward compatibility with new rustdoc versions
  // This allows the generator to gracefully skip unknown items instead of crashing
  return "unknown";
}
