import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputTransaction } from "../../src/output.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rustdoc-out-")));
});
afterEach(async () => {
  vi.clearAllMocks();
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

it("installs a fresh crate directory and then the manifest", async () => {
  await publish({ "api/index.mdx": "main", "api/nested/item.mdx": "item" });
  expect(vi.mocked(rename).mock.calls.map(([, dest]) => dest)).toEqual([
    join(root, "api"),
    join(root, ".rustdoc-to-fumadocs.manifest"),
  ]);
  expect(await readFile(join(root, "api/nested/item.mdx"), "utf8")).toBe("item");
});

it("merges pages into an existing directory on first publication", async () => {
  await mkdir(join(root, "api"));
  await writeFile(join(root, "api/tutorial.mdx"), "handwritten");
  await publish({ "api/index.mdx": "generated" });
  expect(await readFile(join(root, "api/tutorial.mdx"), "utf8")).toBe("handwritten");
  expect(await readFile(join(root, "api/index.mdx"), "utf8")).toBe("generated");
});

it("rolls back the fresh tree if manifest publication fails and preserves independent additions", async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    await fs.rename(from, to);
    await writeFile(join(root, "api/tutorial.mdx"), "handwritten");
    await mkdir(join(root, ".rustdoc-to-fumadocs.manifest"));
  });
  await expect(publish({ "api/child/index.mdx": "page" })).rejects.toThrow(/regular file/);
  expect(await readdir(join(root, "api"))).toEqual(["tutorial.mdx"]);
});

it("commits the current filename when only its capitalization changes", async () => {
  await publish({ "api/entry.mdx": "old" });
  await publish({ "api/Entry.mdx": "new" });
  expect(await readdir(join(root, "api"))).toEqual(["Entry.mdx"]);
  expect(await readFile(join(root, "api/Entry.mdx"), "utf8")).toBe("new");
});

it.each([true, false])("preserves an edited obsolete case alias (prune=%s)", async (prune) => {
  await publish({ "api/entry.mdx": "old" });
  const manifest = join(root, ".rustdoc-to-fumadocs.manifest");
  const before = await readFile(manifest);
  await writeFile(join(root, "api/entry.mdx"), "my edit");
  const caseInsensitive = await stat(join(root, "api/Entry.mdx")).then(
    () => true,
    () => false
  );
  const publication = publish({ "api/Entry.mdx": "new" }, "crate:a", prune);
  if (caseInsensitive) {
    await expect(publication).rejects.toThrow(/edited page/);
    expect(await readFile(manifest)).toEqual(before);
  } else {
    await publication;
    expect(await readFile(join(root, "api/Entry.mdx"), "utf8")).toBe("new");
  }
  expect(await readFile(join(root, "api/entry.mdx"), "utf8")).toBe("my edit");
});

it("keeps another owner's page across capitalization differences on the destination filesystem", async () => {
  await publish({ "api/entry.mdx": "shared content" });
  const caseInsensitive = await stat(join(root, "api/Entry.mdx")).then(
    () => true,
    () => false
  );
  await publish({ "api/Entry.mdx": "shared content" }, "crate:b");
  await publish({ "api/new.mdx": "new" });
  expect(await readFile(join(root, "api/Entry.mdx"), "utf8")).toBe("shared content");
  if (!caseInsensitive) expect(await readdir(join(root, "api"))).not.toContain("entry.mdx");
});

it("leaves unexpected staging entries out of the published directory", async () => {
  const tx = await OutputTransaction.open(root);
  try {
    await tx.add([{ path: "api/index.mdx", content: "page" }]);
    const stage = (await readdir(root)).find((path) => path.startsWith(".rustdoc-stage-"))!;
    await writeFile(join(root, stage, "new/api/extra.mdx"), "untracked");
    await tx.commit("crate:a");
  } finally {
    await tx.close();
  }
  expect(await readdir(join(root, "api"))).toEqual(["index.mdx"]);
});

it("refuses to commit a transaction after a preparation error", async () => {
  const tx = await OutputTransaction.open(root);
  try {
    const page = { path: "api/page.mdx", content: "page" };
    await tx.add([page]);
    await expect(tx.add([page])).rejects.toThrow(/Duplicate/);
    await expect(tx.commit("crate:a")).rejects.toThrow(/Duplicate/);
  } finally {
    await tx.close();
  }
  expect(await readdir(root)).toEqual([]);
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
