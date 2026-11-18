/** Schemas for the rustdoc payloads consumed by the renderer. Rustdoc serializes
 * Rust enums with a single tag. Dispatch on that tag so validating a large
 * index does not try every possible item or type for each entry. */
import { z } from "zod";

// Every item, reference and member list uses this union.
export const idSchema = z.compile(z.union([z.string(), z.number().int().nonnegative()]));
const ids = z.array(idSchema);
const str = z.string();
const bool = z.boolean();
const object = <T extends z.core.$ZodShape>(fields: T) => z.looseObject(fields);
type Schema = z.ZodType<unknown>;

function tagged(
  variants: Record<string, Schema>,
  units: Record<string, string> = {},
  allowUnknownUnit = false
): Schema {
  return z.unknown().transform((raw, ctx) => {
    if (typeof raw === "string" && Object.hasOwn(units, raw)) return { [units[raw]]: true };
    if (allowUnknownUnit && typeof raw === "string" && !Object.hasOwn(variants, raw))
      return { [raw]: true };
    const keys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
    if (keys.length !== 1) {
      ctx.addIssue({ code: "custom", message: "Expected a single rustdoc variant" });
      return z.NEVER;
    }
    const key = keys[0];
    if (!Object.hasOwn(variants, key)) return raw;
    const result = variants[key].safeParse((raw as Record<string, unknown>)[key]);
    if (result.success) return { [key]: result.data };
    for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: [key, ...issue.path] });
    return z.NEVER;
  });
}

// Laziness ties together Rust's recursive Type, GenericArgs, GenericBound and Generics.
const type: Schema = z.lazy(() => typeSchema);
const args: Schema = z.lazy(() => argsSchema);
const bound: Schema = z.lazy(() => boundSchema);
const param: Schema = z.lazy(() => paramSchema);
const path = object({
  name: str.nullish(),
  path: str.nullish(),
  id: idSchema,
  args: args.nullish(),
});
const expr = object({ expr: str, value: str.nullish(), is_literal: bool });
const constArg = z.union([expr, object({ const: expr })]);
const term = tagged({ type, constant: constArg });
const paramSchema = object({
  name: str,
  kind: tagged({
    lifetime: object({ outlives: z.array(str) }),
    type: object({
      bounds: z.array(bound),
      default: type.nullish(),
      is_synthetic: bool.optional(),
    }),
    const: object({ type, default: str.nullish() }),
  }),
});
const boundSchema = tagged({
  trait_bound: object({ trait: path, generic_params: z.array(param), modifier: str }),
  outlives: str,
  use: z.array(z.union([str, tagged({ lifetime: str, param: str })])),
});
const gen = object({
  params: z.array(param),
  where_predicates: z.array(
    tagged({
      bound_predicate: object({ type, bounds: z.array(bound), generic_params: z.array(param) }),
      lifetime_predicate: object({ lifetime: str, outlives: z.array(str) }),
      eq_predicate: object({ lhs: type, rhs: term }),
    })
  ),
});
const argsSchema = tagged(
  {
    angle_bracketed: object({
      args: z.array(
        tagged({ type, lifetime: str, const: constArg, infer: bool }, { infer: "infer" })
      ),
      constraints: z
        .array(
          object({
            name: str,
            args: args.nullish(),
            binding: tagged({
              equality: term,
              constraint: z.array(bound),
            }),
          })
        )
        .optional(),
    }),
    parenthesized: object({ inputs: z.array(type), output: type.nullish() }),
    return_type_notation: bool,
  },
  { return_type_notation: "return_type_notation" }
);
const sig = object({
  inputs: z.array(z.tuple([str, type])),
  output: type.nullish(),
  is_c_variadic: bool.optional(),
});
const header = object({
  is_const: bool,
  is_async: bool,
  is_unsafe: bool,
  abi: z.union([
    str,
    object({ Other: str }),
    z
      .record(z.string(), object({ unwind: bool }))
      .refine((v) => Object.keys(v).length === 1, "Expected one ABI variant"),
  ]),
});
const typeSchema = tagged(
  {
    resolved_path: path,
    generic: str,
    primitive: str,
    tuple: z.array(type),
    slice: type,
    array: object({ type, len: str }),
    borrowed_ref: object({ type, lifetime: str.nullish(), is_mutable: bool }),
    raw_pointer: object({ type, is_mutable: bool }),
    impl_trait: z.array(bound),
    dyn_trait: object({
      traits: z.array(object({ trait: path, generic_params: z.array(param) })),
      lifetime: str.nullish(),
    }),
    qualified_path: object({
      name: str,
      args: args.nullish(),
      self_type: type,
      trait: path.nullish(),
    }),
    function_pointer: object({ sig, header, generic_params: z.array(param) }),
    pat: object({ type, __pat_unstable_do_not_use: str }),
    infer: bool,
  },
  { infer: "infer" }
);

const tuple = z.array(idSchema.nullable());
const fields = object({ fields: ids, has_stripped_fields: bool.optional() });
const structKind = z.union([z.literal("unit"), tagged({ unit: bool, tuple, plain: fields })]);
const variantKind = z.union([z.literal("plain"), tagged({ plain: bool, tuple, struct: fields })]);

export const innerSchema = tagged(
  {
    module: object({ items: ids, is_crate: bool.optional(), is_stripped: bool.optional() }),
    use: object({ id: idSchema.nullish(), name: str.nullish(), source: str, is_glob: bool }),
    struct: object({ kind: structKind, generics: gen, impls: ids }),
    struct_field: type,
    union: object({ fields: ids, generics: gen, impls: ids }),
    enum: object({ variants: ids, generics: gen, impls: ids }),
    variant: object({
      kind: variantKind,
      discriminant: object({ expr: str, value: str }).nullish(),
    }),
    function: object({ sig, header, generics: gen, has_body: bool }),
    trait: object({
      generics: gen,
      items: ids,
      bounds: z.array(bound),
      implementations: ids,
      is_unsafe: bool,
      is_auto: bool,
    }),
    trait_alias: object({ generics: gen, params: z.array(bound) }),
    impl: object({
      trait: path.nullish(),
      for: type,
      generics: gen,
      items: ids,
      is_unsafe: bool,
      is_negative: bool,
      is_synthetic: bool,
      blanket_impl: type.nullish(),
    }),
    type_alias: object({ type, generics: gen }),
    constant: object({ type, const: expr }),
    static: object({ type, is_mutable: bool, expr: str, is_unsafe: bool.optional() }),
    macro: str,
    proc_macro: object({ kind: z.enum(["bang", "attr", "derive"]), helpers: z.array(str) }),
    assoc_const: object({ type, value: str.nullish() }),
    assoc_type: object({ generics: gen, bounds: z.array(bound), type: type.nullish() }),
  },
  { extern_type: "foreign_type", foreign_type: "foreign_type" },
  true
);
