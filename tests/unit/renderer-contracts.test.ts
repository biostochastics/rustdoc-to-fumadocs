import { describe, expect, it } from "vitest";
import {
  formatType,
  formatFunctionSignature,
  formatStructSignature,
} from "../../src/renderer/index.js";
import type { FunctionHeader, GenericBound, Generics, Type } from "../../src/types.js";

const gen: Generics = { params: [], where_predicates: [] };
const i32: Type = { primitive: "i32" };
const header: FunctionHeader = {
  abi: { C: { unwind: true } },
  is_const: false,
  is_async: false,
  is_unsafe: true,
};
const sig = { inputs: [["n", i32]] as [string, Type][], output: i32, is_c_variadic: true };
const clone: GenericBound = {
  trait_bound: { trait: { path: "Clone", id: 1 }, modifier: "none", generic_params: [] },
};

describe("rustdoc signature contracts", () => {
  it("preserves ABI, unwinding, safety and variadics on functions and pointers", () => {
    expect(formatType({ function_pointer: { sig, header, generic_params: [] } })).toBe(
      'unsafe extern "C-unwind" fn(i32, ...) -> i32'
    );
    expect(formatFunctionSignature("read", { sig, header, generics: gen, has_body: false })).toBe(
      'unsafe extern "C-unwind" fn read(n: i32, ...) -> i32'
    );
  });
  it("preserves Fn argument syntax, associated bindings, and trait-object precedence", () => {
    const dyn: Type = {
      dyn_trait: {
        traits: [
          {
            generic_params: [],
            trait: { path: "Fn", id: 1, args: { parenthesized: { inputs: [i32], output: i32 } } },
          },
          { generic_params: [], trait: { path: "Send", id: 2 } },
        ],
      },
    };
    expect(formatType({ borrowed_ref: { is_mutable: false, type: dyn } })).toBe(
      "&(dyn Fn(i32) -> i32 + Send)"
    );
    expect(
      formatType({
        dyn_trait: {
          traits: [
            {
              generic_params: [],
              trait: {
                path: "Iterator",
                id: 1,
                args: {
                  angle_bracketed: {
                    args: [],
                    constraints: [{ name: "Item", binding: { equality: { type: i32 } } }],
                  },
                },
              },
            },
          ],
        },
      })
    ).toBe("dyn Iterator<Item = i32>");
  });
  it("prints precise captures, return-type notation, tuple fields and where clauses", () => {
    expect(formatType({ impl_trait: [clone, { use: [] }] })).toBe("impl Clone + use<>");
    expect(
      formatType({
        qualified_path: {
          name: "lend",
          args: { return_type_notation: true },
          self_type: { generic: "F" },
        },
      })
    ).toBe("F::lend(..)");
    const generics: Generics = {
      params: [{ name: "T", kind: { type: { bounds: [], is_synthetic: false } } }],
      where_predicates: [
        { bound_predicate: { type: { generic: "T" }, bounds: [clone], generic_params: [] } },
      ],
    };
    expect(
      formatStructSignature("Wrapper", { generics, kind: { tuple: [0] }, impls: [] }, ["pub T"])
    ).toBe("struct Wrapper<T>(pub T) where T: Clone;");
  });
});
