/**
 * Unit tests for renderer/types.ts - Type formatting utilities.
 */

import { describe, it, expect } from "vitest";
import { formatType, formatGenericArg, formatGenericBound } from "../../src/renderer/types.js";
import type { Type, GenericArg, GenericBound } from "../../src/types.js";

describe("formatType", () => {
  describe("primitive types", () => {
    it("formats primitive i32", () => {
      const type: Type = { primitive: "i32" };
      expect(formatType(type)).toBe("i32");
    });

    it("formats primitive str", () => {
      const type: Type = { primitive: "str" };
      expect(formatType(type)).toBe("str");
    });

    it("formats primitive bool", () => {
      const type: Type = { primitive: "bool" };
      expect(formatType(type)).toBe("bool");
    });
  });

  describe("generic types", () => {
    it("formats generic T", () => {
      const type: Type = { generic: "T" };
      expect(formatType(type)).toBe("T");
    });

    it("formats generic with multi-char name", () => {
      const type: Type = { generic: "Item" };
      expect(formatType(type)).toBe("Item");
    });
  });

  describe("tuple types", () => {
    it("formats unit tuple ()", () => {
      const type: Type = { tuple: [] };
      expect(formatType(type)).toBe("()");
    });

    it("formats 1-tuple with trailing comma", () => {
      const type: Type = { tuple: [{ primitive: "i32" }] };
      expect(formatType(type)).toBe("(i32,)");
    });

    it("formats 2-tuple", () => {
      const type: Type = { tuple: [{ primitive: "i32" }, { primitive: "bool" }] };
      expect(formatType(type)).toBe("(i32, bool)");
    });

    it("formats 3-tuple", () => {
      const type: Type = {
        tuple: [{ primitive: "i32" }, { primitive: "bool" }, { primitive: "str" }],
      };
      expect(formatType(type)).toBe("(i32, bool, str)");
    });
  });

  describe("slice types", () => {
    it("formats slice of i32", () => {
      const type: Type = { slice: { primitive: "i32" } };
      expect(formatType(type)).toBe("[i32]");
    });

    it("formats slice of generic", () => {
      const type: Type = { slice: { generic: "T" } };
      expect(formatType(type)).toBe("[T]");
    });
  });

  describe("array types", () => {
    it("formats array with length", () => {
      const type: Type = { array: { type: { primitive: "u8" }, len: "16" } };
      expect(formatType(type)).toBe("[u8; 16]");
    });

    it("formats array with const generic length", () => {
      const type: Type = { array: { type: { primitive: "i32" }, len: "N" } };
      expect(formatType(type)).toBe("[i32; N]");
    });
  });

  describe("borrowed_ref types", () => {
    it("formats immutable reference", () => {
      const type: Type = {
        borrowed_ref: { is_mutable: false, type: { primitive: "str" } },
      };
      expect(formatType(type)).toBe("&str");
    });

    it("formats mutable reference", () => {
      const type: Type = {
        borrowed_ref: { is_mutable: true, type: { primitive: "i32" } },
      };
      expect(formatType(type)).toBe("&mut i32");
    });

    it("formats reference with lifetime", () => {
      const type: Type = {
        borrowed_ref: {
          lifetime: "a",
          is_mutable: false,
          type: { primitive: "str" },
        },
      };
      expect(formatType(type)).toBe("&'a str");
    });

    it("formats mutable reference with lifetime", () => {
      const type: Type = {
        borrowed_ref: {
          lifetime: "static",
          is_mutable: true,
          type: { primitive: "i32" },
        },
      };
      expect(formatType(type)).toBe("&'static mut i32");
    });
  });

  describe("raw_pointer types", () => {
    it("formats const pointer", () => {
      const type: Type = {
        raw_pointer: { is_mutable: false, type: { primitive: "u8" } },
      };
      expect(formatType(type)).toBe("*const u8");
    });

    it("formats mut pointer", () => {
      const type: Type = {
        raw_pointer: { is_mutable: true, type: { primitive: "u8" } },
      };
      expect(formatType(type)).toBe("*mut u8");
    });
  });

  describe("resolved_path types", () => {
    it("formats simple path", () => {
      const type: Type = {
        resolved_path: { name: "String", id: "0:1", args: undefined },
      };
      expect(formatType(type)).toBe("String");
    });

    it("formats path using v57 `path` field instead of `name`", () => {
      const type: Type = {
        resolved_path: { path: "String", id: 1, args: undefined },
      };
      expect(formatType(type)).toBe("String");
    });

    it("strips leading `$crate::` from derive-macro paths", () => {
      const type: Type = {
        resolved_path: { path: "$crate::fmt::Formatter", id: 1, args: undefined },
      };
      expect(formatType(type)).toBe("fmt::Formatter");
    });

    it("renders the never primitive `!` instead of the literal string", () => {
      const type: Type = { primitive: "never" };
      expect(formatType(type)).toBe("!");
    });

    it("renders for<'a> fn() binders on higher-ranked fn pointers", () => {
      const type: Type = {
        function_pointer: {
          sig: { inputs: [["x", { generic: "T" }]], output: undefined },
          generic_params: [{ name: "'a", kind: { lifetime: { outlives: [] } } }],
          header: { is_const: false, is_unsafe: false, is_async: false, abi: "Rust" },
        },
      };
      expect(formatType(type)).toBe("for<'a> fn(T)");
    });

    it("renders for<'a> on dyn Trait HRTBs", () => {
      const type: Type = {
        dyn_trait: {
          traits: [
            {
              trait: { path: "Fn", id: 1, args: undefined },
              generic_params: [{ name: "'a", kind: { lifetime: { outlives: [] } } }],
            },
          ],
          lifetime: undefined,
        },
      };
      expect(formatType(type)).toBe("dyn for<'a> Fn");
    });
  });

  describe("formatGenericBound", () => {
    it("renders the ?Sized modifier as ?", async () => {
      const { formatGenericBound } = await import("../../src/renderer/types.js");
      expect(
        formatGenericBound({
          trait_bound: {
            trait: { path: "Sized", id: 1, args: undefined },
            generic_params: [],
            modifier: "maybe",
          },
        })
      ).toBe("?Sized");
    });

    it("preserves angle-bracketed args on a trait bound", async () => {
      const { formatGenericBound } = await import("../../src/renderer/types.js");
      expect(
        formatGenericBound({
          trait_bound: {
            trait: {
              path: "AsRef",
              id: 1,
              args: {
                angle_bracketed: {
                  args: [{ type: { primitive: "str" } }],
                  constraints: [],
                },
              },
            },
            generic_params: [],
            modifier: "none",
          },
        })
      ).toBe("AsRef<str>");
    });

    it("formats path with angle-bracketed args", () => {
      const type: Type = {
        resolved_path: {
          name: "Vec",
          id: "0:2",
          args: {
            angle_bracketed: {
              args: [{ type: { primitive: "i32" } }],
              constraints: [],
            },
          },
        },
      };
      expect(formatType(type)).toBe("Vec<i32>");
    });

    it("formats path with multiple args", () => {
      const type: Type = {
        resolved_path: {
          name: "Result",
          id: "0:3",
          args: {
            angle_bracketed: {
              args: [{ type: { generic: "T" } }, { type: { generic: "E" } }],
              constraints: [],
            },
          },
        },
      };
      expect(formatType(type)).toBe("Result<T, E>");
    });

    it("formats path with associated type constraints", () => {
      const type: Type = {
        resolved_path: {
          name: "Iterator",
          id: "0:4",
          args: {
            angle_bracketed: {
              args: [],
              constraints: [
                {
                  name: "Item",
                  binding: { equality: { type: { primitive: "i32" } } },
                },
              ],
            },
          },
        },
      };
      expect(formatType(type)).toBe("Iterator<Item = i32>");
    });

    it("formats path with const constraint", () => {
      const type: Type = {
        resolved_path: {
          name: "Array",
          id: "0:5",
          args: {
            angle_bracketed: {
              args: [],
              constraints: [
                {
                  name: "N",
                  binding: {
                    equality: {
                      constant: { const: { expr: "16", value: undefined, is_literal: true } },
                    },
                  },
                },
              ],
            },
          },
        },
      };
      expect(formatType(type)).toBe("Array<N = 16>");
    });

    it("formats Fn trait with parenthesized args", () => {
      const type: Type = {
        resolved_path: {
          name: "Fn",
          id: "0:6",
          args: {
            parenthesized: {
              inputs: [{ primitive: "i32" }, { primitive: "bool" }],
              output: { primitive: "String" },
            },
          },
        },
      };
      expect(formatType(type)).toBe("Fn(i32, bool) -> String");
    });

    it("formats Fn trait without output", () => {
      const type: Type = {
        resolved_path: {
          name: "Fn",
          id: "0:7",
          args: {
            parenthesized: {
              inputs: [{ primitive: "i32" }],
              output: undefined,
            },
          },
        },
      };
      expect(formatType(type)).toBe("Fn(i32)");
    });
  });

  describe("impl_trait types", () => {
    it("formats impl Trait with bounds", () => {
      const type: Type = {
        impl_trait: [{ trait_bound: { trait: { name: "Display", id: "0:8", args: undefined } } }],
      };
      expect(formatType(type)).toBe("impl Display");
    });

    it("formats impl with multiple bounds", () => {
      const type: Type = {
        impl_trait: [
          { trait_bound: { trait: { name: "Debug", id: "0:9", args: undefined } } },
          { trait_bound: { trait: { name: "Clone", id: "0:10", args: undefined } } },
        ],
      };
      expect(formatType(type)).toBe("impl Debug + Clone");
    });

    it("formats empty impl trait as impl ...", () => {
      const type: Type = { impl_trait: [] };
      expect(formatType(type)).toBe("impl ...");
    });
  });

  describe("dyn_trait types", () => {
    it("formats dyn Trait", () => {
      const type: Type = {
        dyn_trait: {
          traits: [{ trait: { name: "Read", id: "0:11", args: undefined }, generic_params: [] }],
          lifetime: undefined,
        },
      };
      expect(formatType(type)).toBe("dyn Read");
    });

    it("formats dyn with multiple traits", () => {
      const type: Type = {
        dyn_trait: {
          traits: [
            { trait: { name: "Read", id: "0:12", args: undefined }, generic_params: [] },
            { trait: { name: "Write", id: "0:13", args: undefined }, generic_params: [] },
          ],
          lifetime: undefined,
        },
      };
      expect(formatType(type)).toBe("dyn Read + Write");
    });

    it("formats dyn with lifetime", () => {
      const type: Type = {
        dyn_trait: {
          traits: [{ trait: { name: "Error", id: "0:14", args: undefined }, generic_params: [] }],
          lifetime: "static",
        },
      };
      expect(formatType(type)).toBe("dyn Error + 'static");
    });

    it("formats dyn with generic args on trait", () => {
      const type: Type = {
        dyn_trait: {
          traits: [
            {
              trait: {
                name: "Iterator",
                id: "0:15",
                args: {
                  angle_bracketed: {
                    args: [{ type: { primitive: "i32" } }],
                    constraints: [],
                  },
                },
              },
              generic_params: [],
            },
          ],
          lifetime: undefined,
        },
      };
      expect(formatType(type)).toBe("dyn Iterator<i32>");
    });

    it("formats empty dyn as dyn ...", () => {
      const type: Type = { dyn_trait: { traits: [], lifetime: undefined } };
      expect(formatType(type)).toBe("dyn ...");
    });
  });

  describe("function_pointer types", () => {
    it("formats fn pointer with no args", () => {
      const type: Type = {
        function_pointer: {
          sig: { inputs: [], output: { primitive: "i32" } },
          header: { is_const: false, is_unsafe: false, is_async: false, abi: "Rust" },
          generic_params: [],
        },
      };
      expect(formatType(type)).toBe("fn() -> i32");
    });

    it("formats fn pointer with args", () => {
      const type: Type = {
        function_pointer: {
          sig: {
            inputs: [
              ["x", { primitive: "i32" }],
              ["y", { primitive: "bool" }],
            ],
            output: { primitive: "str" },
          },
          header: { is_const: false, is_unsafe: false, is_async: false, abi: "Rust" },
          generic_params: [],
        },
      };
      expect(formatType(type)).toBe("fn(i32, bool) -> str");
    });

    it("formats fn pointer without return type", () => {
      const type: Type = {
        function_pointer: {
          sig: { inputs: [["_", { primitive: "i32" }]], output: undefined },
          header: { is_const: false, is_unsafe: false, is_async: false, abi: "Rust" },
          generic_params: [],
        },
      };
      expect(formatType(type)).toBe("fn(i32)");
    });
  });

  describe("qualified_path types", () => {
    it("formats qualified path", () => {
      const type: Type = {
        qualified_path: {
          self_type: { generic: "T" },
          trait: { name: "Iterator", id: "0:16", args: undefined },
          name: "Item",
          args: undefined,
        },
      };
      expect(formatType(type)).toBe("<T as Iterator>::Item");
    });

    it("formats qualified path without trait", () => {
      const type: Type = {
        qualified_path: {
          self_type: { generic: "Self" },
          trait: undefined,
          name: "Output",
          args: undefined,
        },
      };
      expect(formatType(type)).toBe("<Self as ?>::Output");
    });
  });

  describe("pat types", () => {
    it("formats pattern type", () => {
      const type: Type = {
        pat: {
          type: { primitive: "u32" },
          __pat_unstable_do_not_use: "0..=255",
        },
      };
      expect(formatType(type)).toBe("u32 is 0..=255");
    });
  });

  describe("infer types", () => {
    it("formats infer as _", () => {
      const type: Type = { infer: true };
      expect(formatType(type)).toBe("_");
    });
  });

  describe("unknown types", () => {
    it("formats unknown type as ...", () => {
      const type = { unknown_future_type: {} } as unknown as Type;
      expect(formatType(type)).toBe("...");
    });
  });
});

describe("formatGenericArg", () => {
  it("formats lifetime arg", () => {
    const arg: GenericArg = { lifetime: "a" };
    expect(formatGenericArg(arg)).toBe("'a");
  });

  it("formats type arg", () => {
    const arg: GenericArg = { type: { primitive: "i32" } };
    expect(formatGenericArg(arg)).toBe("i32");
  });

  it("formats const arg with nested const.expr", () => {
    const arg: GenericArg = {
      const: {
        type: { primitive: "usize" },
        const: { expr: "42", value: "42", is_literal: true },
      },
    };
    expect(formatGenericArg(arg)).toBe("42");
  });

  it("formats const arg with direct expr (fallback for older formats)", () => {
    // Simulate older format with direct expr
    const arg = {
      const: { expr: "100" },
    } as unknown as GenericArg;
    expect(formatGenericArg(arg)).toBe("100");
  });

  it("formats const arg without expr as ...", () => {
    const arg = {
      const: { type: { primitive: "usize" } },
    } as unknown as GenericArg;
    expect(formatGenericArg(arg)).toBe("...");
  });

  it("formats infer arg as _", () => {
    const arg: GenericArg = { infer: true };
    expect(formatGenericArg(arg)).toBe("_");
  });

  it("formats unknown arg as ?", () => {
    const arg = { unknown: true } as unknown as GenericArg;
    expect(formatGenericArg(arg)).toBe("?");
  });
});

describe("formatGenericBound", () => {
  it("formats trait bound", () => {
    const bound: GenericBound = {
      trait_bound: { trait: { name: "Clone", id: "0:17", args: undefined } },
    };
    expect(formatGenericBound(bound)).toBe("Clone");
  });

  it("formats outlives bound", () => {
    const bound: GenericBound = { outlives: "static" };
    expect(formatGenericBound(bound)).toBe("'static");
  });

  it("formats unknown bound as empty string", () => {
    const bound = { unknown: true } as unknown as GenericBound;
    expect(formatGenericBound(bound)).toBe("");
  });
});
