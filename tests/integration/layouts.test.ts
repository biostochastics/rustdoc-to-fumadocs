import { describe, expect, it } from "vitest";
import { RustdocGenerator, type GeneratorOptions } from "../../src/generator.js";
import type { Item, ItemInner, RustdocCrate } from "../../src/types.js";
import { checkOutput } from "../helpers/check-output.js";
import { fileMap, FORMATS, loadCrate, metaPages } from "../helpers/fixtures.js";
import { compileAll } from "../helpers/mdx.js";

const base = "/docs/api";
const options = { output: "/unused", baseUrl: base };

function itemNamed(crate: RustdocCrate, name: string): Item {
  const found = Object.values(crate.index).find((item) => item.name === name);
  if (!found) throw new Error("Missing test item " + name);
  return found;
}

it("renders on demand and allows early returns and interleaved consumers", () => {
  const titles: string[] = [];
  const generator = new RustdocGenerator(loadCrate("minimal.json"), {
    ...options,
    frontmatter: (_item, path) => {
      const title = path.join("::");
      titles.push(title);
      return { title, description: "custom", icon: "Box", extra: true };
    },
  });
  const paths = [...generator.filePaths()];
  const first = generator.generateFiles();
  const second = generator.generateFiles();
  expect(titles).toEqual([]);
  const start = first.next().value;
  expect(second.next().value).toEqual(start);
  expect(titles).toHaveLength(2);
  first.return?.();
  const files = [start, ...second];
  expect(files.map((f) => f.path)).toEqual(paths);
  expect(start.content).toContain("extra: true");
  expect(generator.generate()).toEqual(files);
});

describe.each(FORMATS)("layout and visibility regressions (%s)", (format) => {
  const input = () => loadCrate(`layout_cases.${format}.json`);
  const generate = (overrides?: Partial<GeneratorOptions>) =>
    new RustdocGenerator(input(), { ...options, ...overrides }).generate();

  it.each(["module", "kind", "flat"] as const)(
    "emits every internal destination with and without indexes in %s layout",
    async (groupBy) => {
      for (const generateIndex of [true, false]) {
        const generator = new RustdocGenerator(input(), { ...options, groupBy, generateIndex });
        const files = generator.generate();
        const paths = files.map((file) => file.path);
        expect([...generator.filePaths()]).toEqual(paths);
        const urls = paths
          .filter((p) => p.endsWith(".mdx"))
          .map((p) => p.replace(/(?:\/index)?\.mdx$/, ""));
        expect(new Set(urls).size).toBe(urls.length);
        expect(checkOutput(files).broken).toEqual([]);
        const landing = generator
          .landingUrl()!
          .split("#")[0]
          .slice(base.length + 1);
        expect(urls).toContain(landing);
        expect(generator.pageIndex().has("layout_cases")).toBe(generateIndex);
        expect(await compileAll(files)).toEqual([]);
      }
    }
  );

  it("drops links to omitted module indexes and handles an empty indexless crate", () => {
    const crate = input();
    const item = itemNamed(crate, "root_fn");
    item.docs = "See [the module](functions).";
    item.links = { functions: itemNamed(crate, "functions").id };
    const generator = new RustdocGenerator(crate, { ...options, generateIndex: false });
    expect(fileMap(generator.generate()).get("layout_cases/root_fn.mdx")).toContain(
      "See the module."
    );
    expect(generator.pageIndex().has("layout_cases::functions")).toBe(false);
    const empty = new RustdocGenerator(crate, {
      ...options,
      generateIndex: false,
      filter: () => false,
    });
    expect(empty.landingUrl()).toBeNull();
    expect(empty.pageIndex().size).toBe(0);
  });

  it("resolves rustdoc same-page method fragments from a trait member in a group", () => {
    const crate = loadCrate(`kitchen_sink.${format}.json`);
    const owner = itemNamed(crate, "Shape");
    if (!("trait" in owner.inner)) throw new Error("Expected Shape trait");
    const member = owner.inner.trait.items
      .map((id) => crate.index[id])
      .find((item) => item.name === "SIDES")!;
    member.docs = "See [the method](#tymethod.area).";
    const files = new RustdocGenerator(crate, { ...options, groupBy: "kind" }).generate();
    expect(fileMap(files).get("kitchen_sink/traits.mdx")).toContain(
      "[the method](/docs/api/kitchen_sink/traits#shape.method.area)"
    );
    expect(checkOutput(files).broken).toEqual([]);
  });

  it("resolves rustdoc HTML links from members against the public module", () => {
    const crate = input();
    const member = itemNamed(crate, "new");
    member.docs = 'See <a href="struct.Tuple.html">the tuple</a>.';
    for (const groupBy of ["module", "kind", "flat"] as const) {
      const generator = new RustdocGenerator(crate, { ...options, groupBy });
      const target = generator.pageIndex().get("layout_cases::Tuple")!;
      const files = generator.generate();
      const page = fileMap(files).get(
        groupBy === "kind" ? "layout_cases/structs.mdx" : "layout_cases/Public.mdx"
      )!;
      expect(page).toContain('href="' + target + '"');
      expect(checkOutput(files).broken).toEqual([]);
    }
  });

  it("resolves known standard members when rustdoc omits their index entries", () => {
    const crate = input();
    const root = crate.index[crate.root];
    expect(crate.paths[root.links["`Vec::new`"]]).toBeUndefined();
    root.docs += "\n\nUnknown [`Unrelated::new`].";
    root.links["`Unrelated::new`"] = 999999;
    const body = fileMap(new RustdocGenerator(crate, options).generate()).get(
      "layout_cases/index.mdx"
    )!;
    expect(body).toContain("/alloc/vec/struct.Vec.html#method.new)");
    expect(body).toContain("/core/option/enum.Option.html#variant.Some)");
    expect(body).toContain("[`Vec::new`](https://");
    expect(body).toContain("[`std::vec::Vec::new`](https://");
    expect(body).toContain("Unknown `Unrelated::new`.");
  });

  it("flattens nested members into one directory and lists every page in its sidebar", () => {
    const files = fileMap(generate({ groupBy: "flat" }));
    expect([...files.keys()].every((p) => p.split("/").length === 2)).toBe(true);
    const pages = metaPages(files, "layout_cases/meta.json");
    for (const path of files.keys()) {
      if (path.endsWith(".mdx")) expect(pages).toContain(path.split("/")[1].slice(0, -4));
    }
    expect(files.get("layout_cases/functions.mdx")).toContain(
      "/docs/api/layout_cases/functions--nested"
    );
  });

  it("retains methods and auto traits with unique anchors and reserves group routes", () => {
    const generator = new RustdocGenerator(input(), { ...options, groupBy: "kind" });
    const paths = generator.pageIndex();
    const files = fileMap(generator.generate());
    expect(paths.get("layout_cases::Case")).not.toBe(paths.get("layout_cases::CASE"));
    for (const name of ["Case", "CASE"]) {
      const anchor = paths.get("layout_cases::" + name)!.split("#")[1];
      expect(files.get("layout_cases/structs.mdx")).toContain(
        "## `" + name + "` [#" + anchor + "]"
      );
    }
    const structs = files.get("layout_cases/structs.mdx")!;
    expect(structs).toContain("#### `new` [#public.method.new]");
    expect(structs).toContain("### Usage [#public.section.usage]");
    expect(structs).toContain("### Auto Trait Implementations");
    expect(files.get("layout_cases/index.mdx")).toContain("/structs#public.method.new");
    expect(files.get("layout_cases/index.mdx")).toContain("/structs#public.section.usage");
    expect(files.has("layout_cases/functions.mdx")).toBe(true);
    expect(files.has("layout_cases/functions-mod/index.mdx")).toBe(true);
  });

  it("renders trait aliases and expresses the safety of extern statics", () => {
    const files = fileMap(generate());
    expect(files.get("layout_cases/Clonable.mdx")).toContain("trait Clonable = Clone + Send;");
    expect(files.get("layout_cases/BITS.mdx")).toContain("unsafe static BITS: u32;");
    expect(files.get("layout_cases/SAFE_BITS.mdx")).toContain("safe static SAFE_BITS: u32;");
    expect(files.get("layout_cases/BITS.mdx")).not.toContain("= ;");
  });

  it("links to the owner when a rustdoc fragment names a method without a heading", () => {
    const crate = input();
    itemNamed(crate, "root_fn").docs = "See [inherited](struct.Public.html#method.inherited).";
    for (const groupBy of ["module", "kind"] as const) {
      const generator = new RustdocGenerator(crate, { ...options, groupBy });
      const href = generator.pageIndex().get("layout_cases::Public");
      const files = generator.generate();
      expect(files.some((f) => f.content.includes("[inherited](" + href + ")"))).toBe(true);
      expect(checkOutput(files).broken).toEqual([]);
    }
  });

  it("applies visibility to fields and inherent methods while keeping enum members", () => {
    const crate = input();
    const publicItem = itemNamed(crate, "Public");
    const privateField = itemNamed(crate, "private_field");
    const method = itemNamed(crate, "crate_method");
    publicItem.docs = "See [the field](field) and [the method](method).";
    publicItem.links = { field: privateField.id, method: method.id };
    const files = fileMap(new RustdocGenerator(crate, options).generate());
    const page = files.get("layout_cases/Public.mdx")!;
    expect(page).not.toMatch(/private_field|private_method|crate_method/);
    expect(page).toContain("See the field and the method.");
    expect(page).toContain("- `shown`: `u32`");
    expect(files.get("layout_cases/Color.mdx")).toContain("#### `Blue`");
    expect(files.get("layout_cases/Tuple.mdx")).toContain("struct Tuple(_, pub u64);");
    expect(files.get("layout_cases/Tuple.mdx")).toContain(
      "- `1`: `u64` - Public field at position one."
    );
  });

  it("includes selected private items and preserves tuple field visibility", () => {
    const files = fileMap(generate({ filter: (item) => item.name !== "crate_method" }));
    const page = files.get("layout_cases/Public.mdx")!;
    expect(page).toContain("private_field");
    expect(page).toContain("fn private_method()");
    expect(page).not.toContain("fn crate_method()");
    expect(files.has("layout_cases/inner/index.mdx")).toBe(true);
    expect(files.get("layout_cases/Tuple.mdx")).toContain("struct Tuple(pub(crate) u32, pub u64);");
    expect(files.get("layout_cases/left/Scoped.mdx")).toContain(
      "struct Scoped(pub(in crate::left) u16);"
    );
  });

  it("preserves conditional impls, member features and distinct implementors", () => {
    const files = fileMap(generate());
    const generic = files.get("layout_cases/Generic.mdx")!;
    expect(generic).toContain("impl<T> Generic<T> where T: Clone + Ord");
    expect(generic).toContain("Send where T: Send");
    for (const [name, heading] of [
      ["Color", "variant.Green"],
      ["Public", "method.optional_method"],
    ]) {
      const page = files.get("layout_cases/" + name + ".mdx")!;
      expect(page.slice(page.indexOf("[#" + heading + "]"))).toContain(
        "crate feature `optional` only"
      );
    }
    const implementors = files.get("layout_cases/Marker.mdx")!;
    expect(implementors).toContain("[`left::Handle`](/docs/api/layout_cases/left/Handle)");
    expect(implementors).toContain("[`right::Handle`](/docs/api/layout_cases/right/Handle)");
  });

  it("retains use-site documents, deprecations, variant aliases, and deduplicates a convergent glob", () => {
    const files = fileMap(generate());
    const index = files.get("layout_cases/index.mdx")!;
    expect(index).toContain("[`Primary`](/docs/api/layout_cases/Color#variant.Blue)");
    expect(index).toContain("A color alias.");
    expect(index).toContain("Public alias documentation.");
    expect(files.get("layout_cases/Export.mdx")).toContain('title={"Deprecated since 0.2.0"}');
    expect(files.get("layout_cases/Export.mdx")).toContain("Public alias documentation.");
    expect([...files.keys()].filter((p) => p.includes("Shared"))).toEqual([
      "layout_cases/Shared.mdx",
    ]);
    const filtered = fileMap(
      generate({ filter: (item) => item.name !== "Original" && item.visibility === "public" })
    );
    expect(filtered.has("layout_cases/Export.mdx")).toBe(false);
  });

  it("keeps file components and collision suffixes within the filesystem byte limit", () => {
    const crate = input();
    const prefix = "界".repeat(90);
    itemNamed(crate, "Case").name = prefix + "a";
    itemNamed(crate, "CASE").name = prefix + "b";
    const files = new RustdocGenerator(crate, options).generate();
    const names = files.map(({ path }) => path.split("/").at(-1)!);
    expect(names.filter((name) => name.startsWith("界"))).toHaveLength(2);
    expect(names.every((name) => Buffer.byteLength(name) <= 255)).toBe(true);
    expect(checkOutput(files).broken).toEqual([]);
  });

  it("does not change caller-owned docstrings across planning and repeated rendering", () => {
    const crate = input();
    const item = itemNamed(crate, "Public");
    item.docs = "Use this example.\n\n```\n# let hidden = ();\n## shown\n```";
    const before = JSON.stringify(crate);
    const generator = new RustdocGenerator(crate, options);
    generator.pageIndex();
    const first = generator.generate();
    expect(first).toEqual(generator.generate());
    expect(JSON.stringify(crate)).toBe(before);
    expect(fileMap(first).get("layout_cases/Public.mdx")).toContain("# shown");
  });
});

it("keeps literal suffixes occupied when case variants share filenames and anchors", () => {
  const crate = loadCrate("minimal.json");
  const root = crate.index[crate.root];
  const template = itemNamed(crate, "test_function");
  const names = ["Alpha", "alpha-fn", "ALPHA", "alpha-fn-3", "aLpHa", "alpha-2", "alPHA"];
  if (!("module" in root.inner)) throw new Error("Expected fixture root module");
  root.inner.module.items = names.map((name, i) => {
    const id = i + 1;
    crate.index[id] = { ...template, id, name };
    crate.paths[id] = { crate_id: 0, kind: "function", path: ["test_crate", name] };
    return id;
  });
  const routes = (groupBy: "module" | "kind") => {
    const index = new RustdocGenerator(crate, { ...options, groupBy }).pageIndex();
    return names.map((name) =>
      index
        .get("test_crate::" + name)
        ?.split("/")
        .at(-1)
    );
  };
  expect(routes("module")).toEqual([
    "Alpha",
    "alpha-fn",
    "ALPHA-fn-2",
    "alpha-fn-3",
    "aLpHa-fn-4",
    "alpha-2",
    "alPHA-fn-5",
  ]);
  expect(routes("kind")).toEqual(
    ["alpha", "alpha-fn", "alpha-2", "alpha-fn-3", "alpha-3", "alpha-2-2", "alpha-4"].map(
      (anchor) => "functions#" + anchor
    )
  );
});

it("displays unstable const use independently of ordinary function stability", () => {
  const crate = loadCrate("layout_cases.v60.json");
  const item = itemNamed(crate, "root_fn");
  item.stability = { feature: "api", level: "stable", since: "1.0.0" };
  item.const_stability = { feature: "const_api", level: "unstable" };
  expect(
    fileMap(new RustdocGenerator(crate, options).generate()).get("layout_cases/root_fn.mdx")
  ).toContain("**Unstable in const contexts** (feature `const_api`)");
});

it("accepts zero as a real rustdoc ID in cross-reference cards", () => {
  const mk = (id: number, name: string, inner: ItemInner): Item => ({
    id,
    name,
    inner,
    crate_id: 0,
    visibility: "public",
    attrs: [],
    links: {},
  });
  const trait = {
    is_auto: false,
    is_dyn_compatible: true,
    is_unsafe: false,
    generics: { params: [], where_predicates: [] },
    items: [],
    implementations: [],
    bounds: [],
  };
  const crate: RustdocCrate = {
    root: 2,
    format_version: 57,
    includes_private: false,
    paths: {},
    external_crates: {},
    index: {
      0: mk(0, "Base", { trait }),
      1: mk(1, "Derived", {
        trait: {
          ...trait,
          bounds: [
            {
              trait_bound: { trait: { id: 0, path: "Base" }, generic_params: [], modifier: "none" },
            },
          ],
        },
      }),
      2: mk(2, "sample", { module: { is_crate: true, is_stripped: false, items: [0, 1] } }),
    },
  };
  const page = fileMap(new RustdocGenerator(crate, options).generate()).get("sample/Derived.mdx");
  expect(page).toContain('href={"/docs/api/sample/Base"}');
  expect(page).not.toMatch(/<Card [^>]*icon=/);
});
