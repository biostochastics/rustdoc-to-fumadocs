/**
 * Unit tests for signatures.ts - function signature formatting.
 */

import { describe, it, expect } from "vitest";
import { formatFunctionSignature, formatWherePredicate } from "../../src/renderer/signatures.js";
import type {
  Function as RustFunction,
  WherePredicate,
  Generics,
  FunctionHeader,
  FunctionSignature,
} from "../../src/types.js";

// Helper to create a minimal function with defaults
function createFunction(overrides: {
  header?: Partial<FunctionHeader>;
  generics?: Partial<Generics>;
  sig?: Partial<FunctionSignature>;
}): RustFunction {
  return {
    sig: {
      inputs: [],
      output: undefined,
      ...overrides.sig,
    },
    generics: {
      params: [],
      where_predicates: [],
      ...overrides.generics,
    },
    header: {
      is_const: false,
      is_unsafe: false,
      is_async: false,
      abi: "Rust",
      ...overrides.header,
    },
    has_body: true,
  };
}

describe("formatFunctionSignature", () => {
  describe("basic signatures", () => {
    it("formats a simple function without parameters", () => {
      const fn = createFunction({});
      expect(formatFunctionSignature("my_func", fn)).toBe("fn my_func ()");
    });

    it("formats a function with parameters", () => {
      const fn = createFunction({
        sig: {
          inputs: [
            ["x", { primitive: "i32" }],
            ["y", { primitive: "i32" }],
          ],
        },
      });
      expect(formatFunctionSignature("add", fn)).toBe("fn add (x: i32, y: i32)");
    });

    it("formats a function with return type", () => {
      const fn = createFunction({
        sig: {
          inputs: [["x", { primitive: "i32" }]],
          output: { primitive: "i32" },
        },
      });
      expect(formatFunctionSignature("square", fn)).toBe("fn square (x: i32) -> i32");
    });
  });

  describe("function modifiers", () => {
    it("formats a const function", () => {
      const fn = createFunction({
        header: { is_const: true },
      });
      expect(formatFunctionSignature("const_fn", fn)).toBe("const fn const_fn ()");
    });

    it("formats an async function", () => {
      const fn = createFunction({
        header: { is_async: true },
      });
      expect(formatFunctionSignature("async_fn", fn)).toBe("async fn async_fn ()");
    });

    it("formats an unsafe function", () => {
      const fn = createFunction({
        header: { is_unsafe: true },
      });
      expect(formatFunctionSignature("unsafe_fn", fn)).toBe("unsafe fn unsafe_fn ()");
    });

    it("formats a function with multiple modifiers", () => {
      const fn = createFunction({
        header: { is_const: true, is_unsafe: true },
      });
      expect(formatFunctionSignature("special", fn)).toBe("const unsafe fn special ()");
    });
  });

  describe("ABI rendering", () => {
    it('formats extern "C" function', () => {
      const fn = createFunction({
        header: { abi: { C: { unwind: false } } },
      });
      expect(formatFunctionSignature("c_func", fn)).toBe('extern "C" fn c_func ()');
    });

    it('formats extern "C" unwind function', () => {
      const fn = createFunction({
        header: { abi: { C: { unwind: true } } },
      });
      expect(formatFunctionSignature("c_unwind", fn)).toBe('extern "C" fn c_unwind ()');
    });

    it('formats extern "system" function', () => {
      const fn = createFunction({
        header: { abi: { System: { unwind: false } } },
      });
      expect(formatFunctionSignature("system_func", fn)).toBe('extern "system" fn system_func ()');
    });

    it('formats extern "system" unwind function', () => {
      const fn = createFunction({
        header: { abi: { System: { unwind: true } } },
      });
      expect(formatFunctionSignature("sys_unwind", fn)).toBe('extern "system" fn sys_unwind ()');
    });

    it("formats function with custom ABI", () => {
      const fn = createFunction({
        header: { abi: { Other: "aapcs" } },
      });
      expect(formatFunctionSignature("arm_func", fn)).toBe('extern "aapcs" fn arm_func ()');
    });

    it('formats unsafe extern "C" function', () => {
      const fn = createFunction({
        header: { is_unsafe: true, abi: { C: { unwind: false } } },
      });
      expect(formatFunctionSignature("unsafe_c", fn)).toBe('unsafe extern "C" fn unsafe_c ()');
    });

    it("does not add extern for Rust ABI", () => {
      const fn = createFunction({
        header: { abi: "Rust" },
      });
      expect(formatFunctionSignature("rust_fn", fn)).toBe("fn rust_fn ()");
    });
  });

  describe("where clause rendering", () => {
    it("formats function with bound predicate", () => {
      const fn = createFunction({
        generics: {
          params: [{ name: "T", kind: { type: { bounds: [], is_synthetic: false } } }],
          where_predicates: [
            {
              bound_predicate: {
                type: { generic: "T" },
                bounds: [
                  {
                    trait_bound: {
                      trait: { name: "Clone", id: "1", args: undefined },
                      generic_params: [],
                      modifier: "none",
                    },
                  },
                ],
                generic_params: [],
              },
            },
          ],
        },
      });
      expect(formatFunctionSignature("cloneable", fn)).toBe("fn cloneable<T> () where T: Clone");
    });

    it("formats function with multiple bounds", () => {
      const fn = createFunction({
        generics: {
          params: [{ name: "T", kind: { type: { bounds: [], is_synthetic: false } } }],
          where_predicates: [
            {
              bound_predicate: {
                type: { generic: "T" },
                bounds: [
                  {
                    trait_bound: {
                      trait: { name: "Clone", id: "1", args: undefined },
                      generic_params: [],
                      modifier: "none",
                    },
                  },
                  {
                    trait_bound: {
                      trait: { name: "Debug", id: "2", args: undefined },
                      generic_params: [],
                      modifier: "none",
                    },
                  },
                ],
                generic_params: [],
              },
            },
          ],
        },
      });
      expect(formatFunctionSignature("multi_bound", fn)).toBe(
        "fn multi_bound<T> () where T: Clone + Debug"
      );
    });

    it("formats function with lifetime predicate", () => {
      const fn = createFunction({
        generics: {
          params: [
            { name: "a", kind: { lifetime: { outlives: [] } } },
            { name: "b", kind: { lifetime: { outlives: [] } } },
          ],
          where_predicates: [
            {
              lifetime_predicate: {
                lifetime: "a",
                outlives: ["b"],
              },
            },
          ],
        },
      });
      expect(formatFunctionSignature("lifetime_fn", fn)).toBe(
        "fn lifetime_fn<'a, 'b> () where 'a: 'b"
      );
    });

    it("formats function with multiple where predicates", () => {
      const fn = createFunction({
        generics: {
          params: [
            { name: "T", kind: { type: { bounds: [], is_synthetic: false } } },
            { name: "U", kind: { type: { bounds: [], is_synthetic: false } } },
          ],
          where_predicates: [
            {
              bound_predicate: {
                type: { generic: "T" },
                bounds: [
                  {
                    trait_bound: {
                      trait: { name: "Clone", id: "1", args: undefined },
                      generic_params: [],
                      modifier: "none",
                    },
                  },
                ],
                generic_params: [],
              },
            },
            {
              bound_predicate: {
                type: { generic: "U" },
                bounds: [
                  {
                    trait_bound: {
                      trait: { name: "Debug", id: "2", args: undefined },
                      generic_params: [],
                      modifier: "none",
                    },
                  },
                ],
                generic_params: [],
              },
            },
          ],
        },
      });
      expect(formatFunctionSignature("multi_where", fn)).toBe(
        "fn multi_where<T, U> () where T: Clone, U: Debug"
      );
    });

    it("formats function with complete signature including where clause", () => {
      const fn = createFunction({
        header: { is_async: true },
        sig: {
          inputs: [["item", { generic: "T" }]],
          output: { generic: "T" },
        },
        generics: {
          params: [{ name: "T", kind: { type: { bounds: [], is_synthetic: false } } }],
          where_predicates: [
            {
              bound_predicate: {
                type: { generic: "T" },
                bounds: [
                  {
                    trait_bound: {
                      trait: { name: "Send", id: "1", args: undefined },
                      generic_params: [],
                      modifier: "none",
                    },
                  },
                ],
                generic_params: [],
              },
            },
          ],
        },
      });
      expect(formatFunctionSignature("process", fn)).toBe(
        "async fn process<T> (item: T) -> T where T: Send"
      );
    });
  });
});

describe("formatWherePredicate", () => {
  it("formats bound predicate with single trait", () => {
    const pred: WherePredicate = {
      bound_predicate: {
        type: { generic: "T" },
        bounds: [
          {
            trait_bound: {
              trait: { name: "Clone", id: "1", args: undefined },
              generic_params: [],
              modifier: "none",
            },
          },
        ],
        generic_params: [],
      },
    };
    expect(formatWherePredicate(pred)).toBe("T: Clone");
  });

  it("formats bound predicate with multiple traits", () => {
    const pred: WherePredicate = {
      bound_predicate: {
        type: { generic: "T" },
        bounds: [
          {
            trait_bound: {
              trait: { name: "Clone", id: "1", args: undefined },
              generic_params: [],
              modifier: "none",
            },
          },
          {
            trait_bound: {
              trait: { name: "Debug", id: "2", args: undefined },
              generic_params: [],
              modifier: "none",
            },
          },
          {
            trait_bound: {
              trait: { name: "Send", id: "3", args: undefined },
              generic_params: [],
              modifier: "none",
            },
          },
        ],
        generic_params: [],
      },
    };
    expect(formatWherePredicate(pred)).toBe("T: Clone + Debug + Send");
  });

  it("formats bound predicate with lifetime bound", () => {
    const pred: WherePredicate = {
      bound_predicate: {
        type: { generic: "T" },
        bounds: [{ outlives: "static" }],
        generic_params: [],
      },
    };
    expect(formatWherePredicate(pred)).toBe("T: 'static");
  });

  it("formats lifetime predicate", () => {
    const pred: WherePredicate = {
      lifetime_predicate: {
        lifetime: "a",
        outlives: ["b"],
      },
    };
    expect(formatWherePredicate(pred)).toBe("'a: 'b");
  });

  it("formats lifetime predicate with multiple outlives", () => {
    const pred: WherePredicate = {
      lifetime_predicate: {
        lifetime: "a",
        outlives: ["b", "c"],
      },
    };
    expect(formatWherePredicate(pred)).toBe("'a: 'b + 'c");
  });

  it("formats equality predicate with type", () => {
    const pred: WherePredicate = {
      eq_predicate: {
        lhs: {
          qualified_path: {
            name: "Item",
            args: { angle_bracketed: { args: [], constraints: [] } },
            self_type: { generic: "T" },
            trait: { name: "Iterator", id: "1", args: undefined },
          },
        },
        rhs: { type: { primitive: "i32" } },
      },
    };
    expect(formatWherePredicate(pred)).toBe("<T as Iterator>::Item = i32");
  });

  it("formats equality predicate with constant", () => {
    const pred: WherePredicate = {
      eq_predicate: {
        lhs: { generic: "N" },
        rhs: {
          constant: {
            type: { primitive: "usize" },
            const: { expr: "42", value: "42", is_literal: true },
          },
        },
      },
    };
    expect(formatWherePredicate(pred)).toBe("N = 42");
  });

  it("returns empty string for bound predicate with no bounds", () => {
    const pred: WherePredicate = {
      bound_predicate: {
        type: { generic: "T" },
        bounds: [],
        generic_params: [],
      },
    };
    expect(formatWherePredicate(pred)).toBe("");
  });

  it("returns empty string for lifetime predicate with no outlives", () => {
    const pred: WherePredicate = {
      lifetime_predicate: {
        lifetime: "a",
        outlives: [],
      },
    };
    expect(formatWherePredicate(pred)).toBe("");
  });
});
