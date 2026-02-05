/**
 * Unit tests for types.ts - getItemKind function and type utilities.
 */

import { describe, it, expect } from "vitest";
import { getItemKind, type ItemInner } from "../../src/types.js";

describe("getItemKind", () => {
  it("returns 'module' for module items", () => {
    const inner: ItemInner = {
      module: {
        is_crate: false,
        items: [],
        is_stripped: false,
      },
    };
    expect(getItemKind(inner)).toBe("module");
  });

  it("returns 'struct' for struct items", () => {
    const inner: ItemInner = {
      struct: {
        kind: { unit: true },
        generics: { params: [], where_predicates: [] },
        impls: [],
      },
    };
    expect(getItemKind(inner)).toBe("struct");
  });

  it("returns 'enum' for enum items", () => {
    const inner: ItemInner = {
      enum: {
        generics: { params: [], where_predicates: [] },
        variants: [],
        has_stripped_variants: false,
        impls: [],
      },
    };
    expect(getItemKind(inner)).toBe("enum");
  });

  it("returns 'function' for function items", () => {
    const inner: ItemInner = {
      function: {
        sig: { inputs: [], output: undefined },
        generics: { params: [], where_predicates: [] },
        header: {
          is_const: false,
          is_unsafe: false,
          is_async: false,
          abi: "Rust",
        },
        has_body: true,
      },
    };
    expect(getItemKind(inner)).toBe("function");
  });

  it("returns 'trait' for trait items", () => {
    const inner: ItemInner = {
      trait: {
        is_auto: false,
        is_unsafe: false,
        is_dyn_compatible: true,
        items: [],
        generics: { params: [], where_predicates: [] },
        bounds: [],
        implementations: [],
      },
    };
    expect(getItemKind(inner)).toBe("trait");
  });

  it("returns 'constant' for constant items", () => {
    const inner: ItemInner = {
      constant: {
        type: { primitive: "i32" },
        const: {
          expr: "42",
          value: "42",
          is_literal: true,
        },
      },
    };
    expect(getItemKind(inner)).toBe("constant");
  });

  it("returns 'type_alias' for type alias items", () => {
    const inner: ItemInner = {
      type_alias: {
        type: { primitive: "i32" },
        generics: { params: [], where_predicates: [] },
      },
    };
    expect(getItemKind(inner)).toBe("type_alias");
  });

  it("returns 'macro' for macro items", () => {
    const inner: ItemInner = {
      macro: "macro_rules! my_macro { ... }",
    };
    expect(getItemKind(inner)).toBe("macro");
  });

  it("returns 'proc_attribute' for proc_macro with attr kind", () => {
    const inner: ItemInner = {
      proc_macro: {
        kind: "attr",
        helpers: [],
      },
    };
    expect(getItemKind(inner)).toBe("proc_attribute");
  });

  it("returns 'proc_derive' for proc_macro with derive kind", () => {
    const inner: ItemInner = {
      proc_macro: {
        kind: "derive",
        helpers: ["helper1", "helper2"],
      },
    };
    expect(getItemKind(inner)).toBe("proc_derive");
  });

  it("returns 'macro' for proc_macro with bang kind", () => {
    const inner: ItemInner = {
      proc_macro: {
        kind: "bang",
        helpers: [],
      },
    };
    expect(getItemKind(inner)).toBe("macro");
  });

  it("returns 'impl' for impl items", () => {
    const inner: ItemInner = {
      impl: {
        is_unsafe: false,
        generics: { params: [], where_predicates: [] },
        provided_trait_methods: [],
        trait: undefined,
        for: { primitive: "i32" },
        items: [],
        is_negative: false,
        is_synthetic: false,
        blanket_impl: undefined,
      },
    };
    expect(getItemKind(inner)).toBe("impl");
  });

  it("returns 'union' for union items", () => {
    const inner: ItemInner = {
      union: {
        generics: { params: [], where_predicates: [] },
        fields: [],
        has_stripped_fields: false,
        impls: [],
      },
    };
    expect(getItemKind(inner)).toBe("union");
  });

  it("returns 'struct_field' for struct field items", () => {
    const inner: ItemInner = {
      struct_field: { primitive: "i32" },
    };
    expect(getItemKind(inner)).toBe("struct_field");
  });

  it("returns 'unknown' for unrecognized item kinds (forward compatibility)", () => {
    // Simulate a future rustdoc version with a new item kind
    const inner = { future_item_kind: { some: "data" } } as unknown as ItemInner;
    expect(getItemKind(inner)).toBe("unknown");
  });

  it("returns 'unknown' for empty inner object", () => {
    const inner = {} as unknown as ItemInner;
    expect(getItemKind(inner)).toBe("unknown");
  });
});
