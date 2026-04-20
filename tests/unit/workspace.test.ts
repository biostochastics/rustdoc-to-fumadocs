/**
 * Unit tests for workspace.ts — Cargo workspace discovery and rendering.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWorkspace,
  findMemberRustdocJson,
  renderWorkspaceMeta,
  renderWorkspaceIndex,
  type WorkspaceMember,
} from "../../src/workspace.js";
import { isRustdocError, ErrorCode } from "../../src/errors.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "rd2fd-ws-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeMember(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.1.0"\n`,
    "utf-8"
  );
}

describe("loadWorkspace", () => {
  it("parses a workspace with explicit members", async () => {
    await writeMember(join(tmp, "crates", "alpha"), "alpha");
    await writeMember(join(tmp, "crates", "beta"), "beta");
    await writeFile(
      join(tmp, "Cargo.toml"),
      `[workspace]\nmembers = ["crates/alpha", "crates/beta"]\n`,
      "utf-8"
    );

    const ws = await loadWorkspace(join(tmp, "Cargo.toml"));
    expect(ws.members.map((m) => m.name).sort()).toEqual(["alpha", "beta"]);
    expect(ws.rootDir).toBe(tmp);
  });

  it("expands glob patterns like 'crates/*'", async () => {
    await writeMember(join(tmp, "crates", "alpha"), "alpha");
    await writeMember(join(tmp, "crates", "beta"), "beta");
    await writeMember(join(tmp, "crates", "gamma"), "gamma");
    await writeFile(join(tmp, "Cargo.toml"), `[workspace]\nmembers = ["crates/*"]\n`, "utf-8");

    const ws = await loadWorkspace(join(tmp, "Cargo.toml"));
    expect(ws.members.map((m) => m.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("applies the exclude list", async () => {
    await writeMember(join(tmp, "crates", "alpha"), "alpha");
    await writeMember(join(tmp, "crates", "beta"), "beta");
    await writeMember(join(tmp, "crates", "keep-out"), "keep_out");
    await writeFile(
      join(tmp, "Cargo.toml"),
      `[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/keep-out"]\n`,
      "utf-8"
    );

    const ws = await loadWorkspace(join(tmp, "Cargo.toml"));
    expect(ws.members.map((m) => m.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("skips members whose own Cargo.toml is missing", async () => {
    await writeMember(join(tmp, "crates", "real"), "real");
    await mkdir(join(tmp, "crates", "ghost"), { recursive: true });
    await writeFile(
      join(tmp, "Cargo.toml"),
      `[workspace]\nmembers = ["crates/real", "crates/ghost"]\n`,
      "utf-8"
    );

    const ws = await loadWorkspace(join(tmp, "Cargo.toml"));
    expect(ws.members.map((m) => m.name)).toEqual(["real"]);
  });

  it("rejects a Cargo.toml with no [workspace] table", async () => {
    await writeFile(
      join(tmp, "Cargo.toml"),
      `[package]\nname = "single"\nversion = "0.1.0"\n`,
      "utf-8"
    );

    await expect(loadWorkspace(join(tmp, "Cargo.toml"))).rejects.toSatisfy(
      (err) => isRustdocError(err) && err.code === ErrorCode.INVALID_ITEM_STRUCTURE
    );
  });

  it("reports a readable error when the manifest does not exist", async () => {
    await expect(loadWorkspace(join(tmp, "does-not-exist.toml"))).rejects.toSatisfy(
      (err) => isRustdocError(err) && err.code === ErrorCode.INPUT_READ_FAILED
    );
  });
});

describe("findMemberRustdocJson", () => {
  it("finds the JSON using the exact crate name", async () => {
    const doc = join(tmp, "doc");
    await mkdir(doc, { recursive: true });
    await writeFile(join(doc, "alpha.json"), "{}", "utf-8");
    const p = await findMemberRustdocJson("alpha", tmp);
    expect(p).toBe(join(doc, "alpha.json"));
  });

  it("falls back on underscore-for-hyphen substitution", async () => {
    const doc = join(tmp, "doc");
    await mkdir(doc, { recursive: true });
    await writeFile(join(doc, "my_crate.json"), "{}", "utf-8");
    const p = await findMemberRustdocJson("my-crate", tmp);
    expect(p).toBe(join(doc, "my_crate.json"));
  });

  it("returns null when neither form exists", async () => {
    const p = await findMemberRustdocJson("nope", tmp);
    expect(p).toBeNull();
  });
});

describe("renderWorkspaceMeta", () => {
  it("emits a sidebar listing the members as sub-folders", () => {
    const members: WorkspaceMember[] = [
      { name: "alpha", path: "/x/alpha" },
      { name: "beta", path: "/x/beta" },
    ];
    const meta = JSON.parse(renderWorkspaceMeta(members));
    expect(meta.pages).toEqual(["index", "...alpha", "...beta"]);
  });
});

describe("renderWorkspaceIndex", () => {
  it("produces a landing page with a link per member", () => {
    const members: WorkspaceMember[] = [
      { name: "alpha", path: "/x/alpha" },
      { name: "beta", path: "/x/beta" },
    ];
    const index = renderWorkspaceIndex("wstest", members);
    expect(index).toContain("wstest");
    expect(index).toContain("[`alpha`](./alpha)");
    expect(index).toContain("[`beta`](./beta)");
  });
});
