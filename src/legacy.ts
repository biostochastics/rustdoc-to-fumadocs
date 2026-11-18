/** Normalize rustdoc's pre-format-35 field names before applying the shared
 * schema. Only the item payload is walked, so IDs, link labels, source text
 * and arbitrary top-level keys retain their original values. */
type JsonObject = Record<string, unknown>;

const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const oldKeys: Record<string, string> = {
  import: "use",
  region_predicate: "lifetime_predicate",
  decl: "sig",
  c_variadic: "is_c_variadic",
  mutable: "is_mutable",
  negative: "is_negative",
  synthetic: "is_synthetic",
  bindings: "constraints",
  glob: "is_glob",
};

function normalizePayload(value: unknown, parent: string): unknown {
  if (Array.isArray(value)) return value.map((entry: unknown) => normalizePayload(entry, parent));
  if (!object(value)) return value;
  if (parent === "constant" && "type" in value && "expr" in value && !("const" in value)) {
    const { type, ...expression } = value;
    return { type: normalizePayload(type, "type"), const: expression };
  }
  if (parent === "region_predicate" && Array.isArray(value.bounds)) {
    return {
      lifetime: value.lifetime,
      outlives: value.bounds.map((bound: unknown) => (object(bound) ? bound.outlives : bound)),
    };
  }
  const entries = Object.entries(value).map(([key, entry]) => {
    let name = Object.hasOwn(oldKeys, key) ? oldKeys[key] : key;
    if (parent === "header" && ["const", "unsafe", "async"].includes(key)) name = "is_" + key;
    if (parent === "assoc_type" && key === "default") name = "type";
    if (parent === "assoc_const" && key === "default") name = "value";
    if (parent === "trait" && key === "is_object_safe") name = "is_dyn_compatible";
    return [name, normalizePayload(entry, key)];
  });
  return Object.fromEntries(entries);
}

export function normalizeLegacyCrate(crate: JsonObject): JsonObject {
  if (!object(crate.index)) return crate;
  return {
    ...crate,
    index: Object.fromEntries(
      Object.entries(crate.index).map(([id, item]) => [
        id,
        object(item) ? { ...item, inner: normalizePayload(item.inner, "inner") } : item,
      ])
    ),
  };
}
