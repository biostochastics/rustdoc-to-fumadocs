import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputTransaction } from "../../src/output.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rustdoc-out-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function publish(files: Record<string, string>, owner = "crate:a", prune = true) {
  const tx = await OutputTransaction.open(root);
  try {
    await tx.add(Object.entries(files).map(([path, content]) => ({ path, content })));
    await tx.commit(owner, prune);
  } finally {
    await tx.close();
  }
}
it("removes obsolete owned pages and keeps edited or independently owned content", async () => {
  await publish({ "a/old.mdx": "original", "a/edited.mdx": "original", "a/only/index.mdx": "old" });
  await publish({ "b/index.mdx": "other" }, "crate:b");
  await writeFile(join(root, "a/edited.mdx"), "my edit");
  await writeFile(join(root, "a/tutorial.mdx"), "guide");
  await publish({ "a/new.mdx": "new" });
  expect((await readdir(join(root, "a"))).sort()).toEqual([
    "edited.mdx",
    "new.mdx",
    "tutorial.mdx",
  ]);
  expect(await readFile(join(root, "a/edited.mdx"), "utf8")).toBe("my edit");
  expect(await readFile(join(root, "b/index.mdx"), "utf8")).toBe("other");
});
it("retains previous ownership in a partial run for cleanup after a complete retry", async () => {
  await publish({ "a/item.mdx": "a", "b/item.mdx": "b" }, "workspace");
  await publish({ "a/item.mdx": "updated" }, "workspace", false);
  expect(await readFile(join(root, "b/item.mdx"), "utf8")).toBe("b");
  await publish({ "a/item.mdx": "updated" }, "workspace");
  expect(await readdir(root)).not.toContain("b");
});
it("rejects conflicting destinations before altering published pages", async () => {
  await publish({ "a/index.mdx": "first" });
  await mkdir(join(root, "a/occupied.mdx"));
  await expect(publish({ "a/index.mdx": "second", "a/occupied.mdx": "page" })).rejects.toThrow();
  expect(await readFile(join(root, "a/index.mdx"), "utf8")).toBe("first");
});
it("refuses to publish into an aliased directory", async () => {
  await mkdir(join(root, "real"));
  await symlink(
    join(root, "real"),
    join(root, "alias"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await expect(publish({ "alias/index.mdx": "index" })).rejects.toThrow(/directory/);
  expect(await readdir(join(root, "real"))).toEqual([]);
});
it("leaves previously removed obsolete directories absent", async () => {
  await publish({ "a/module/old.mdx": "old" });
  await rm(join(root, "a/module"), { recursive: true });
  await publish({ "a/new.mdx": "page" });
  expect(await readdir(join(root, "a"))).toEqual(["new.mdx"]);
});

it("preserves the page and manifest on an unchanged publication", async () => {
  const files = { "a/index.mdx": "same" };
  await publish(files);
  const paths = [join(root, "a/index.mdx"), join(root, ".rustdoc-to-fumadocs.manifest")];
  const stamps = () => Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs));
  const before = await stamps();
  await publish(files);
  expect(await stamps()).toEqual(before);
});

it("repairs live edits and removals after preparation, including spilled workspace members", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`api/page-${i}.mdx`, "Résumé 🦀\n".repeat(5500) + i])
  );
  await publish(files);
  const tx = await OutputTransaction.open(root);
  try {
    for (const [path, content] of Object.entries(files)) await tx.add([{ path, content }]);
    await writeFile(join(root, "api/page-0.mdx"), "changed");
    await rm(join(root, "api/page-59.mdx"));
    await tx.commit("crate:a");
    for (const path of ["api/page-0.mdx", "api/page-59.mdx"]) {
      expect(await readFile(join(root, path), "utf8")).toBe(files[path]);
    }
  } finally {
    await tx.close();
  }
});
