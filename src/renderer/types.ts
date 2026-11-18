/**
 * Type formatting utilities for rendering Rust types as strings.
 *
 * @module renderer/types
 * @description Handles all rustdoc type representations including:
 * - resolved_path: Named types with optional generic arguments
 * - generic: Type parameters (T, U, etc.)
 * - primitive: Built-in types (i32, str, etc.)
 * - tuple: Tuple types
 * - slice/array: Slice and array types
 * - borrowed_ref: References (&T, &mut T)
 * - raw_pointer: Raw pointers (*const T, *mut T)
 * - impl_trait: Opaque impl Trait types
 * - dyn_trait: Trait objects (dyn Trait)
 * - function_pointer: Function pointer types
 * - qualified_path: Associated type paths (<T as Trait>::Type)
 */

import { getPathName } from "../types.js";
import type {
  Type,
  GenericArg,
  GenericArgs,
  GenericBound,
  GenericParamDef,
  Abi,
  ConstArgument,
} from "../types.js";

/**
 * Format a Type as a human-readable string.
 *
 * @param type - The rustdoc Type to format
 * @returns Formatted type string
 *
 * @example
 * ```typescript
 * const typeStr = formatType({ primitive: "i32" }); // "i32"
 * const typeStr = formatType({ tuple: [{ primitive: "i32" }, { primitive: "bool" }] }); // "(i32, bool)"
 * ```
 */
export function formatType(type: Type | "infer"): string {
  // rustdoc occasionally emits `null` where a Type is expected (e.g. for a
  // missing const generic default). Guard rather than crash.
  if (type === null || type === undefined || type === "infer") return "_";
  if ("resolved_path" in type) {
    const path = type.resolved_path;
    return getPathName(path) + formatGenericArgs(path.args);
  }
  if ("generic" in type) {
    return type.generic;
  }
  if ("primitive" in type) {
    // Rustdoc emits the never type as the primitive string "never"; render it
    // using the idiomatic Rust syntax `!`.
    return type.primitive === "never" ? "!" : type.primitive;
  }
  if ("tuple" in type) {
    if (type.tuple.length === 0) return "()";
    // Fix: 1-tuple requires trailing comma: (T,)
    if (type.tuple.length === 1) {
      return `(${formatType(type.tuple[0])},)`;
    }
    return `(${type.tuple.map((t) => formatType(t)).join(", ")})`;
  }
  if ("slice" in type) {
    return `[${formatType(type.slice)}]`;
  }
  if ("array" in type) {
    return `[${formatType(type.array.type)}; ${type.array.len}]`;
  }
  if ("borrowed_ref" in type) {
    const ref = type.borrowed_ref;
    let s = "&";
    // Lifetimes in rustdoc JSON already include the leading '
    if (ref.lifetime) s += `${ref.lifetime.startsWith("'") ? ref.lifetime : `'${ref.lifetime}`} `;
    if (ref.is_mutable) s += "mut ";
    s += formatPointee(ref.type);
    return s;
  }
  if ("raw_pointer" in type) {
    const ptr = type.raw_pointer;
    return `*${ptr.is_mutable ? "mut" : "const"} ${formatPointee(ptr.type)}`;
  }
  if ("impl_trait" in type) {
    // Render impl Trait bounds
    const bounds = type.impl_trait;
    if (bounds.length > 0) {
      const traits = bounds.map((b) => formatGenericBound(b)).filter(Boolean);
      if (traits.length > 0) {
        return `impl ${traits.join(" + ")}`;
      }
    }
    return "impl ...";
  }
  if ("dyn_trait" in type) {
    const dyn = type.dyn_trait;
    if (dyn.traits.length > 0) {
      // Format trait bounds with generic args, preserving any higher-ranked
      // trait bound binders (`for<'a>`).
      const traits = dyn.traits.map(
        (t) => formatHrtb(t.generic_params) + getPathName(t.trait) + formatGenericArgs(t.trait.args)
      );
      // Include lifetime if present
      let result = `dyn ${traits.join(" + ")}`;
      if (dyn.lifetime) {
        // Lifetimes in rustdoc JSON already include the leading '
        result += ` + ${dyn.lifetime.startsWith("'") ? dyn.lifetime : `'${dyn.lifetime}`}`;
      }
      return result;
    }
    return "dyn ...";
  }
  // Handle pattern types (unstable feature)
  if ("pat" in type) {
    const pat = type.pat;
    return `${formatType(pat.type)} is ${pat.__pat_unstable_do_not_use}`;
  }
  if ("function_pointer" in type) {
    const fp = type.function_pointer;
    const params = fp.sig.inputs.map(([, t]) => formatType(t));
    if (fp.sig.is_c_variadic) params.push("...");
    // Preserve `for<'a>` binders on higher-ranked fn pointers like
    // `for<'a> fn(&'a T) -> &'a U`.
    const abi = formatAbi(fp.header.abi);
    let result = `${formatHrtb(fp.generic_params)}${fp.header.is_unsafe ? "unsafe " : ""}${abi ? abi + " " : ""}fn(${params.join(", ")})`;
    if (fp.sig.output) {
      result += ` -> ${formatType(fp.sig.output)}`;
    }
    return result;
  }
  if ("qualified_path" in type) {
    const qp = type.qualified_path;
    const args = formatGenericArgs(qp.args);
    // `Self::Assoc` / `T::Assoc` written without a trait: rustdoc leaves
    // `trait` empty, or (format 57+) sets it to a path whose name is "".
    // Render it the way it was written.
    if (!qp.trait || getPathName(qp.trait) === "?") {
      return `${formatType(qp.self_type)}::${qp.name}${args}`;
    }
    const traitName = getPathName(qp.trait) + formatGenericArgs(qp.trait.args);
    return `<${formatType(qp.self_type)} as ${traitName}>::${qp.name}${args}`;
  }
  if ("infer" in type) {
    return "_";
  }
  return "...";
}

/**
 * Format the generic arguments of a path: `<T, Item = U>` for
 * angle-bracketed args (associated-type equality and bound constraints
 * included), `(A, B) -> C` for the parenthesized `Fn` sugar, "" for none.
 */
export function formatGenericArgs(
  args: GenericArgs | "return_type_notation" | undefined | null
): string {
  if (!args) return "";
  if (args === "return_type_notation" || "return_type_notation" in args) return "(..)";
  if ("angle_bracketed" in args) {
    const ab = args.angle_bracketed;
    const formatted = [
      ...ab.args.map((arg) => formatGenericArg(arg)),
      ...(ab.constraints ?? []).map((c) => {
        const name = c.name + formatGenericArgs(c.args);
        if ("equality" in c.binding) {
          const term = c.binding.equality;
          if ("type" in term) return `${name} = ${formatType(term.type)}`;
          if ("constant" in term) return `${name} = ${formatConstArg(term.constant)}`;
        }
        if ("constraint" in c.binding) {
          const bounds = c.binding.constraint.map((b) => formatGenericBound(b)).filter(Boolean);
          return bounds.length > 0 ? `${name}: ${bounds.join(" + ")}` : name;
        }
        return name;
      }),
    ];
    return formatted.length > 0 ? `<${formatted.join(", ")}>` : "";
  }
  if ("parenthesized" in args) {
    const paren = args.parenthesized;
    const inputs = paren.inputs.map((t) => formatType(t)).join(", ");
    return `(${inputs})${paren.output ? ` -> ${formatType(paren.output)}` : ""}`;
  }
  return "";
}

/**
 * Format a generic argument (lifetime, type, or const).
 *
 * @param arg - The GenericArg to format
 * @returns Formatted argument string
 */
export function formatGenericArg(arg: GenericArg | "infer"): string {
  if (arg === "infer") return "_";
  if ("lifetime" in arg) {
    // Lifetimes in rustdoc JSON already include the leading '
    return arg.lifetime.startsWith("'") ? arg.lifetime : `'${arg.lifetime}`;
  }
  if ("type" in arg) {
    return formatType(arg.type);
  }
  if ("const" in arg) {
    return formatConstArg(arg.const);
  }
  if ("infer" in arg) {
    return "_";
  }
  return "?";
}

/**
 * Format a generic bound (trait bound or lifetime).
 *
 * @param bound - The GenericBound to format
 * @returns Formatted bound string
 */
export function formatGenericBound(bound: GenericBound): string {
  if ("trait_bound" in bound) {
    const tb = bound.trait_bound;
    // Modifier prefix: `?Sized`, `~const Drop`, etc. Dropping this inverts
    // the meaning of the bound to a reader.
    const modifierPrefix =
      tb.modifier === "maybe" ? "?" : tb.modifier === "maybe_const" ? "~const " : "";
    const hrtb = formatHrtb(tb.generic_params);
    // Keep the trait's generic args, e.g. `AsRef<str>`, `Iterator<Item = u32>`
    // or the `Fn(&str) -> usize` sugar.
    const name = getPathName(tb.trait) + formatGenericArgs(tb.trait.args);
    return `${hrtb}${modifierPrefix}${name}`;
  }
  if ("outlives" in bound) {
    // Lifetimes in rustdoc JSON already include the leading '
    return bound.outlives.startsWith("'") ? bound.outlives : `'${bound.outlives}`;
  }
  if ("use" in bound) {
    const params = bound.use.map((p) =>
      typeof p === "string" ? p : "lifetime" in p ? p.lifetime : p.param
    );
    return `use<${params.join(", ")}>`;
  }
  return "";
}

/**
 * Format a list of HRTB generic params as a `for<...> ` prefix. Returns
 * `""` when the list is empty. Lifetime params are rendered with a leading
 * `'` (matching how rustdoc actually stores them); type and const params in
 * an HRTB are vanishingly rare but handled by falling back to the name.
 */
function formatHrtb(params: GenericParamDef[] | undefined): string {
  if (!params || params.length === 0) return "";
  const parts = params.map((p) => {
    if ("lifetime" in p.kind) {
      return p.name.startsWith("'") ? p.name : `'${p.name}`;
    }
    return p.name;
  });
  return `for<${parts.join(", ")}> `;
}

function formatPointee(t: Type): string {
  const value = formatType(t);
  const many =
    "dyn_trait" in t
      ? t.dyn_trait.traits.length + Number(Boolean(t.dyn_trait.lifetime)) > 1
      : "impl_trait" in t && t.impl_trait.length > 1;
  return many ? `(${value})` : value;
}

export function formatConstArg(value: ConstArgument): string {
  return ("const" in value ? value.const.expr : value.expr) || "...";
}

export function formatAbi(abi: Abi): string {
  if (abi === "Rust") return "";
  if (typeof abi === "string") return `extern "${abi}"`;
  const [variant, data] = Object.entries<string | { unwind: boolean }>(abi)[0];
  const name =
    variant === "Other" && typeof data === "string"
      ? data
      : variant === "C"
        ? "C"
        : variant.toLowerCase();
  const unwind = typeof data === "object" && data?.unwind ? "-unwind" : "";
  return `extern "${name}${unwind}"`;
}
