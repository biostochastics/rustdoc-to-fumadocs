/**
 * Integration tests for generator.ts - RustdocGenerator class.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RustdocGenerator, type GeneratorOptions } from "../../src/generator.js";
import { validateRustdocJson } from "../../src/validation.js";
import type { RustdocCrate } from "../../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "..", "fixtures");

function loadFixture(name: string): RustdocCrate {
  const content = readFileSync(join(fixturesDir, name), "utf-8");
  const data = JSON.parse(content);
  const { crate } = validateRustdocJson(data);
  return crate;
}

describe("RustdocGenerator", () => {
  const defaultOptions: GeneratorOptions = {
    output: "/tmp/test-output",
    baseUrl: "/docs/api",
  };

  describe("constructor", () => {
    it("creates generator with default options", () => {
      const crate = loadFixture("minimal.json");
      const generator = new RustdocGenerator(crate, defaultOptions);
      expect(generator).toBeDefined();
    });

    it("accepts custom options", () => {
      const crate = loadFixture("minimal.json");
      const options: GeneratorOptions = {
        ...defaultOptions,
        groupBy: "kind",
        generateIndex: false,
      };
      const generator = new RustdocGenerator(crate, options);
      expect(generator).toBeDefined();
    });
  });

  describe("generate", () => {
    it("generates files from minimal fixture", () => {
      const crate = loadFixture("minimal.json");
      const generator = new RustdocGenerator(crate, defaultOptions);

      const files = generator.generate();

      expect(files).toBeDefined();
      expect(files.length).toBeGreaterThan(0);
    });

    it("generates meta.json for root module", () => {
      const crate = loadFixture("minimal.json");
      const generator = new RustdocGenerator(crate, defaultOptions);

      const files = generator.generate();

      const metaFile = files.find(
        (f) => f.path === "test_crate/meta.json" || f.path === "meta.json"
      );
      expect(metaFile).toBeDefined();

      if (metaFile) {
        const meta = JSON.parse(metaFile.content);
        expect(meta.title).toBeDefined();
        expect(meta.pages).toBeDefined();
        expect(Array.isArray(meta.pages)).toBe(true);
      }
    });

    it("generates index.mdx for modules", () => {
      const crate = loadFixture("minimal.json");
      const generator = new RustdocGenerator(crate, defaultOptions);

      const files = generator.generate();

      const indexFile = files.find((f) => f.path.endsWith("index.mdx"));
      expect(indexFile).toBeDefined();

      if (indexFile) {
        expect(indexFile.content).toContain("---");
        expect(indexFile.content).toContain("title:");
      }
    });

    it("generates MDX files for struct items", () => {
      const crate = loadFixture("minimal.json");
      const generator = new RustdocGenerator(crate, defaultOptions);

      const files = generator.generate();

      const structFile = files.find((f) => f.path.includes("TestStruct"));
      expect(structFile).toBeDefined();

      if (structFile) {
        expect(structFile.path).toMatch(/\.mdx$/);
        expect(structFile.content).toContain("TestStruct");
        expect(structFile.content).toContain("struct");
      }
    });

    it("generates MDX files for function items", () => {
      const crate = loadFixture("minimal.json");
      const generator = new RustdocGenerator(crate, defaultOptions);

      const files = generator.generate();

      const fnFile = files.find((f) => f.path.includes("test_function"));
      expect(fnFile).toBeDefined();

      if (fnFile) {
        expect(fnFile.path).toMatch(/\.mdx$/);
        expect(fnFile.content).toContain("test_function");
        expect(fnFile.content).toContain("fn");
      }
    });

    it("includes deprecation callouts for deprecated items", () => {
      const crate = loadFixture("minimal.json");
      const generator = new RustdocGenerator(crate, defaultOptions);

      const files = generator.generate();

      const deprecatedFile = files.find((f) => f.path.includes("DeprecatedItem"));
      expect(deprecatedFile).toBeDefined();

      if (deprecatedFile) {
        expect(deprecatedFile.content).toContain("Callout");
        expect(deprecatedFile.content).toContain("Deprecated");
        expect(deprecatedFile.content).toContain("Use NewItem instead");
      }
    });

    it("respects generateIndex: false option", () => {
      const crate = loadFixture("minimal.json");
      const options: GeneratorOptions = {
        ...defaultOptions,
        generateIndex: false,
      };
      const generator = new RustdocGenerator(crate, options);

      const files = generator.generate();

      const indexFile = files.find((f) => f.path.endsWith("index.mdx"));
      expect(indexFile).toBeUndefined();
    });

    it("groups items by kind when groupBy is 'kind'", () => {
      const crate = loadFixture("minimal.json");
      const options: GeneratorOptions = {
        ...defaultOptions,
        groupBy: "kind",
      };
      const generator = new RustdocGenerator(crate, options);

      const files = generator.generate();

      // Should have files like structs.mdx, functions.mdx instead of individual files
      const structsFile = files.find((f) => f.path.includes("structs.mdx"));
      const functionsFile = files.find((f) => f.path.includes("functions.mdx"));

      expect(structsFile ?? functionsFile).toBeDefined();
    });

    it("includes YAML frontmatter with proper escaping", () => {
      const crate = loadFixture("minimal.json");
      const generator = new RustdocGenerator(crate, defaultOptions);

      const files = generator.generate();

      for (const file of files.filter((f) => f.path.endsWith(".mdx"))) {
        expect(file.content).toMatch(/^---\n/);
        expect(file.content).toMatch(/\n---\n/);
        // Should have title in frontmatter
        expect(file.content).toMatch(/title:/);
      }
    });

    it("includes FumaDocs v14+ features in meta.json", () => {
      const crate = loadFixture("minimal.json");
      const generator = new RustdocGenerator(crate, defaultOptions);

      const files = generator.generate();

      const metaFile = files.find((f) => f.path.endsWith("meta.json"));
      expect(metaFile).toBeDefined();

      if (metaFile) {
        const meta = JSON.parse(metaFile.content);
        // Check for FumaDocs v14+ features
        expect(meta.icon).toBeDefined();
        expect(meta.defaultOpen).toBeDefined();
        // Check for separators in pages array
        const hasSeparator = meta.pages.some(
          (p: string | object) => typeof p === "string" && p.startsWith("---")
        );
        expect(hasSeparator).toBe(true);
      }
    });
  });

  describe("error handling", () => {
    it("throws for invalid crate with no root module", () => {
      // Create a crate where root doesn't point to a module
      const invalidCrate: RustdocCrate = {
        root: "0:0:0",
        includes_private: false,
        index: {
          "0:0:0": {
            id: "0:0:0",
            crate_id: 0,
            name: "not_a_module",
            visibility: "public",
            docs: undefined,
            links: {},
            attrs: [],
            inner: {
              // This is a function, not a module!
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
            },
          },
        },
        paths: {},
        external_crates: {},
        format_version: 57,
      };

      const generator = new RustdocGenerator(invalidCrate, defaultOptions);
      expect(() => generator.generate()).toThrow("Root item is not a module");
    });
  });

  describe("custom filter", () => {
    it("respects custom filter function", () => {
      const crate = loadFixture("minimal.json");
      const options: GeneratorOptions = {
        ...defaultOptions,
        filter: (item) => {
          // Filter out deprecated items
          return !item.deprecation;
        },
      };
      const generator = new RustdocGenerator(crate, options);

      const files = generator.generate();

      // DeprecatedItem should not have its own page
      const deprecatedFile = files.find(
        (f) => f.path.includes("DeprecatedItem") && !f.path.includes("index")
      );
      expect(deprecatedFile).toBeUndefined();
    });
  });

  describe("custom frontmatter", () => {
    it("respects custom frontmatter generator", () => {
      const crate = loadFixture("minimal.json");
      const options: GeneratorOptions = {
        ...defaultOptions,
        frontmatter: (item, path) => ({
          title: `Custom: ${item.name}`,
          customField: path.join("::"),
        }),
      };
      const generator = new RustdocGenerator(crate, options);

      const files = generator.generate();

      const structFile = files.find((f) => f.path.includes("TestStruct.mdx"));
      if (structFile) {
        expect(structFile.content).toContain("Custom: TestStruct");
        expect(structFile.content).toContain("customField:");
      }
    });
  });
});
