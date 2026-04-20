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
import type { Type, GenericArg, GenericBound, GenericParamDef } from "../types.js";

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
export function formatType(type: Type): string {
  // rustdoc occasionally emits `null` where a Type is expected (e.g. for a
  // missing const generic default). Guard rather than crash.
  if (type === null || type === undefined) return "_";
  if ("resolved_path" in type) {
    const path = type.resolved_path;
    let result = getPathName(path);
    // Render generic arguments
    if (path.args) {
      if ("angle_bracketed" in path.args) {
        const angleBracketed = path.args.angle_bracketed;
        const args = angleBracketed.args;
        const constraints = angleBracketed.constraints ?? [];

        // Format type arguments (e.g., Vec<String>, Result<T, E>)
        const formattedArgs = args.map((arg) => formatGenericArg(arg));

        // Format associated type constraints (e.g., Iterator<Item = T>)
        const formattedConstraints = constraints.map((c) => {
          if ("equality" in c.binding) {
            const term = c.binding.equality;
            if ("type" in term) {
              return `${c.name} = ${formatType(term.type)}`;
            }
            if ("constant" in term) {
              const constVal = term.constant;
              return `${c.name} = ${constVal.const?.expr ?? "..."}`;
            }
          }
          return c.name;
        });

        const allArgs = [...formattedArgs, ...formattedConstraints];
        if (allArgs.length > 0) {
          result += `<${allArgs.join(", ")}>`;
        }
      } else if ("parenthesized" in path.args) {
        // Handle Fn traits: Fn(A, B) -> C
        const paren = path.args.parenthesized;
        const inputs = paren.inputs.map((t) => formatType(t)).join(", ");
        result += `(${inputs})`;
        if (paren.output) {
          result += ` -> ${formatType(paren.output)}`;
        }
      }
    }
    return result;
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
    s += formatType(ref.type);
    return s;
  }
  if ("raw_pointer" in type) {
    const ptr = type.raw_pointer;
    return `*${ptr.is_mutable ? "mut" : "const"} ${formatType(ptr.type)}`;
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
      const traits = dyn.traits.map((t) => {
        let name = formatHrtb(t.generic_params) + getPathName(t.trait);
        if (t.trait.args && "angle_bracketed" in t.trait.args) {
          const args = t.trait.args.angle_bracketed.args;
          if (args.length > 0) {
            name += `<${args.map((a) => formatGenericArg(a)).join(", ")}>`;
          }
        }
        return name;
      });
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
    const params = fp.sig.inputs.map(([, t]) => formatType(t)).join(", ");
    // Preserve `for<'a>` binders on higher-ranked fn pointers like
    // `for<'a> fn(&'a T) -> &'a U`.
    let result = `${formatHrtb(fp.generic_params)}fn(${params})`;
    if (fp.sig.output) {
      result += ` -> ${formatType(fp.sig.output)}`;
    }
    return result;
  }
  if ("qualified_path" in type) {
    const qp = type.qualified_path;
    const traitName = qp.trait ? getPathName(qp.trait) : "?";
    return `<${formatType(qp.self_type)} as ${traitName}>::${qp.name}`;
  }
  if ("infer" in type) {
    return "_";
  }
  return "...";
}

/**
 * Format a generic argument (lifetime, type, or const).
 *
 * @param arg - The GenericArg to format
 * @returns Formatted argument string
 */
export function formatGenericArg(arg: GenericArg): string {
  if ("lifetime" in arg) {
    // Lifetimes in rustdoc JSON already include the leading '
    return arg.lifetime.startsWith("'") ? arg.lifetime : `'${arg.lifetime}`;
  }
  if ("type" in arg) {
    return formatType(arg.type);
  }
  if ("const" in arg) {
    // Constant in generic args uses the nested const.expr structure
    const constVal = arg.const;
    if ("const" in constVal && constVal.const.expr) {
      return constVal.const.expr;
    }
    // Fallback: try direct expr access for older format versions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    if ((constVal as any).expr) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
      return (constVal as any).expr;
    }
    return "...";
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
    let name = getPathName(tb.trait);
    // Preserve angle-bracketed generic args on the trait, e.g.
    // `AsRef<str>` or `Iterator<Item = u32>`.
    if (tb.trait.args && "angle_bracketed" in tb.trait.args) {
      const args = tb.trait.args.angle_bracketed.args;
      const constraints = tb.trait.args.angle_bracketed.constraints ?? [];
      const formatted = [
        ...args.map((a) => formatGenericArg(a)),
        ...constraints.map((c) => c.name),
      ];
      if (formatted.length > 0) name += `<${formatted.join(", ")}>`;
    }
    return `${hrtb}${modifierPrefix}${name}`;
  }
  if ("outlives" in bound) {
    // Lifetimes in rustdoc JSON already include the leading '
    return bound.outlives.startsWith("'") ? bound.outlives : `'${bound.outlives}`;
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
