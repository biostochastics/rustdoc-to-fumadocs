/**
 * Signature formatting utilities for rendering Rust item signatures.
 *
 * @module renderer/signatures
 * @description Handles formatting of function, struct, union, enum, and trait signatures
 * with proper generic parameter handling.
 */

import type {
  Function as RustFunction,
  Struct,
  Union,
  Enum,
  Trait,
  Generics,
  GenericParamDef,
  WherePredicate,
} from "../types.js";
import { isUnitStruct, isTupleStruct, isPlainStruct } from "../types.js";
import { formatType, formatGenericBound } from "./types.js";

/**
 * Format a function signature.
 *
 * @param name - Function name
 * @param fn - Function definition from rustdoc
 * @returns Formatted function signature string
 *
 * @example
 * ```typescript
 * const sig = formatFunctionSignature("my_func", fn);
 * // "fn my_func<T>(arg: T) -> String"
 * ```
 */
export function formatFunctionSignature(name: string, fn: RustFunction): string {
  const parts: string[] = [];

  if (fn.header.is_const) parts.push("const");
  if (fn.header.is_async) parts.push("async");
  if (fn.header.is_unsafe) parts.push("unsafe");

  // Check for extern ABI
  if (fn.header.abi !== "Rust") {
    if (typeof fn.header.abi === "object") {
      if ("C" in fn.header.abi) {
        parts.push('extern "C"');
      } else if ("System" in fn.header.abi) {
        parts.push('extern "system"');
      } else if ("Other" in fn.header.abi) {
        parts.push(`extern "${fn.header.abi.Other}"`);
      }
    }
  }

  parts.push("fn");
  parts.push(name + formatGenerics(fn.generics));

  // Parameters
  const params = fn.sig.inputs.map(([paramName, type]) => `${paramName}: ${formatType(type)}`);
  parts.push(`(${params.join(", ")})`);

  // Return type
  if (fn.sig.output) {
    parts.push("->");
    parts.push(formatType(fn.sig.output));
  }

  // Where clause
  if (fn.generics.where_predicates.length > 0) {
    const whereClauses = fn.generics.where_predicates.map((p) => formatWherePredicate(p));
    parts.push("where");
    parts.push(whereClauses.join(", "));
  }

  return parts.join(" ");
}

/**
 * Format a struct signature.
 *
 * @param name - Struct name
 * @param struct - Struct definition from rustdoc
 * @returns Formatted struct signature string
 *
 * @example
 * ```typescript
 * const sig = formatStructSignature("MyStruct", struct);
 * // "struct MyStruct<T> { ... }"
 * ```
 */
export function formatStructSignature(name: string, struct: Struct): string {
  let sig = `struct ${name}${formatGenerics(struct.generics)}`;

  if (isUnitStruct(struct.kind)) {
    sig += ";";
  } else if (isTupleStruct(struct.kind)) {
    sig += "(...)";
  } else if (isPlainStruct(struct.kind)) {
    sig += " { ... }";
  }

  return sig;
}

/**
 * Format a union signature.
 *
 * @param name - Union name
 * @param union - Union definition from rustdoc
 * @returns Formatted union signature string
 *
 * @example
 * ```typescript
 * const sig = formatUnionSignature("MyUnion", union);
 * // "union MyUnion<T> { ... }"
 * ```
 */
export function formatUnionSignature(name: string, union: Union): string {
  return `union ${name}${formatGenerics(union.generics)} { ... }`;
}

/**
 * Format an enum signature.
 *
 * @param name - Enum name
 * @param enumDef - Enum definition from rustdoc
 * @returns Formatted enum signature string
 *
 * @example
 * ```typescript
 * const sig = formatEnumSignature("MyEnum", enumDef);
 * // "enum MyEnum<T> { ... }"
 * ```
 */
export function formatEnumSignature(name: string, enumDef: Enum): string {
  return `enum ${name}${formatGenerics(enumDef.generics)} { ... }`;
}

/**
 * Format a trait signature.
 *
 * @param name - Trait name
 * @param trait - Trait definition from rustdoc
 * @returns Formatted trait signature string
 *
 * @example
 * ```typescript
 * const sig = formatTraitSignature("MyTrait", trait);
 * // "trait MyTrait<T>: Clone { ... }"
 * ```
 */
export function formatTraitSignature(name: string, trait: Trait): string {
  let sig = "";
  if (trait.is_unsafe) sig += "unsafe ";
  sig += `trait ${name}${formatGenerics(trait.generics)}`;
  if (trait.bounds.length > 0) {
    sig += ": ...";
  }
  sig += " { ... }";
  return sig;
}

/**
 * Format generic parameters as a string (e.g., `<T, U, 'a>`).
 *
 * @param generics - Generics definition from rustdoc
 * @returns Formatted generics string, empty if no params
 *
 * @example
 * ```typescript
 * const genericsStr = formatGenerics(generics);
 * // "<T, U, 'a>"
 * ```
 */
export function formatGenerics(generics: Generics): string {
  if (generics.params.length === 0) return "";

  const params = generics.params.map((p) => formatGenericParam(p));
  return `<${params.join(", ")}>`;
}

/**
 * Format a single generic parameter (lifetime or type).
 *
 * @param param - Generic parameter definition
 * @returns Formatted parameter string
 */
export function formatGenericParam(param: GenericParamDef): string {
  if ("lifetime" in param.kind) {
    // Lifetime names in rustdoc JSON already include the leading '
    // e.g., { "name": "'de", "kind": { "lifetime": { "outlives": [] } } }
    // Don't add another ' if it's already there
    return param.name.startsWith("'") ? param.name : `'${param.name}`;
  }
  return param.name;
}

/**
 * Format a where predicate (bound, lifetime, or equality).
 *
 * @param pred - Where predicate from rustdoc
 * @returns Formatted predicate string
 *
 * @example
 * ```typescript
 * // Bound predicate: T: Clone + Debug
 * formatWherePredicate({ bound_predicate: { type: { generic: "T" }, bounds: [...], generic_params: [] } });
 *
 * // Lifetime predicate: 'a: 'b + 'c
 * formatWherePredicate({ lifetime_predicate: { lifetime: "a", outlives: ["b", "c"] } });
 *
 * // Equality predicate: <T as Iterator>::Item = U
 * formatWherePredicate({ eq_predicate: { lhs: ..., rhs: { type: ... } } });
 * ```
 */
export function formatWherePredicate(pred: WherePredicate): string {
  if ("bound_predicate" in pred) {
    const bp = pred.bound_predicate;
    const bounds = bp.bounds.map((b) => formatGenericBound(b)).filter(Boolean);
    if (bounds.length === 0) return "";
    return `${formatType(bp.type)}: ${bounds.join(" + ")}`;
  }
  if ("lifetime_predicate" in pred) {
    const lp = pred.lifetime_predicate;
    if (lp.outlives.length === 0) return "";
    // Lifetimes in rustdoc JSON already include the leading '
    const formatLifetime = (lt: string) => (lt.startsWith("'") ? lt : `'${lt}`);
    return `${formatLifetime(lp.lifetime)}: ${lp.outlives.map((o) => formatLifetime(o)).join(" + ")}`;
  }
  if ("eq_predicate" in pred) {
    const ep = pred.eq_predicate;
    if ("type" in ep.rhs) {
      return `${formatType(ep.lhs)} = ${formatType(ep.rhs.type)}`;
    }
    if ("constant" in ep.rhs) {
      const constVal = ep.rhs.constant;
      return `${formatType(ep.lhs)} = ${constVal.const?.expr ?? "..."}`;
    }
  }
  return "";
}
