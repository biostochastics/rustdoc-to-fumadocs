/**
 * Tests for cli.ts - argument parsing, path validation, and the `run()`
 * entrypoint. These exercise the async I/O paths end-to-end against the
 * minimal fixture, using a tmpdir for output.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, validateOutputPath, formatError, run, type CliStreams } from "../../src/cli.js";
import { RustdocError, ErrorCode } from "../../src/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "..", "fixtures", "minimal.json");

function captureStreams(): { streams: CliStreams; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: {
      stdout: (msg) => out.push(msg),
      stderr: (msg) => err.push(msg),
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function collectAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  const { readdir: rd } = await import("node:fs/promises");
  const { stat: st } = await import("node:fs/promises");
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const entries = await rd(cur);
    for (const name of entries) {
      const full = join(cur, name);
      const s = await st(full);
      if (s.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

describe("parseArgs", () => {
  it("returns defaults when given no arguments", () => {
    const args = parseArgs([]);
    expect(args.output).toBe("content/docs/api");
    expect(args.baseUrl).toBe("/docs/api");
    expect(args.groupBy).toBe("module");
    expect(args.help).toBe(false);
    expect(args.json).toBe(false);
    expect(args.verbose).toBe(false);
  });

  it("parses long and short flag forms", () => {
    const args = parseArgs([
      "--input",
      "foo.json",
      "-o",
      "out",
      "--base-url",
      "/api",
      "-g",
      "flat",
      "-v",
      "--no-index",
      "--no-tabs",
      "--no-cards",
      "--dry-run",
      "--json",
    ]);
    expect(args.input).toBe("foo.json");
    expect(args.output).toBe("out");
    expect(args.baseUrl).toBe("/api");
    expect(args.groupBy).toBe("flat");
    expect(args.verbose).toBe(true);
    expect(args.noIndex).toBe(true);
    expect(args.noTabs).toBe(true);
    expect(args.noCards).toBe(true);
    expect(args.dryRun).toBe(true);
    expect(args.json).toBe(true);
  });

  it("accepts a positional argument as input", () => {
    const args = parseArgs(["some/path.json"]);
    expect(args.input).toBe("some/path.json");
  });

  it("ignores positional after --input is set", () => {
    const args = parseArgs(["--input", "first.json", "second.json"]);
    expect(args.input).toBe("first.json");
  });

  it("throws on missing value for flags that require one", () => {
    expect(() => parseArgs(["--input"])).toThrow(/requires/);
    expect(() => parseArgs(["--output"])).toThrow(/requires/);
    expect(() => parseArgs(["--group-by"])).toThrow(/requires/);
  });

  it("throws on value that looks like another flag", () => {
    expect(() => parseArgs(["--input", "--output"])).toThrow(/requires/);
  });

  it("rejects invalid --group-by values", () => {
    expect(() => parseArgs(["--group-by", "bogus"])).toThrow(/module, kind, or flat/);
  });

  it("accepts all valid --group-by values", () => {
    expect(parseArgs(["-g", "module"]).groupBy).toBe("module");
    expect(parseArgs(["-g", "kind"]).groupBy).toBe("kind");
    expect(parseArgs(["-g", "flat"]).groupBy).toBe("flat");
  });

  it("sets help flag for -h and --help", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

describe("validateOutputPath", () => {
  const outDir = resolve("/tmp/some-output");

  it("returns an absolute path for safe relative paths", () => {
    const result = validateOutputPath(outDir, "module/item.mdx");
    expect(result).toBe(resolve(outDir, "module/item.mdx"));
  });

  it("allows the output directory itself", () => {
    const result = validateOutputPath(outDir, "");
    expect(result).toBe(outDir);
  });

  it("rejects parent traversal with ../", () => {
    expect(() => validateOutputPath(outDir, "../escape.mdx")).toThrow(RustdocError);
    expect(() => validateOutputPath(outDir, "../../etc/passwd")).toThrow(/Path traversal detected/);
  });

  it("rejects absolute paths that resolve outside the output directory", () => {
    // Note: resolve(outDir, "/etc/passwd") === "/etc/passwd" because an
    // absolute second arg overrides the first.
    expect(() => validateOutputPath(outDir, "/etc/passwd")).toThrow(/Path traversal detected/);
  });

  it("rejects prefix-sibling directories (e.g., /out vs /out-evil)", () => {
    // Asking for "../some-output-evil/x" from "/tmp/some-output" resolves to
    // "/tmp/some-output-evil/x" — shares the string prefix but is a different
    // directory. The separator check must prevent it.
    expect(() => validateOutputPath(outDir, `..${sep}some-output-evil${sep}x.mdx`)).toThrow(
      /Path traversal detected/
    );
  });

  it("sets error code and context on RustdocError", () => {
    try {
      validateOutputPath(outDir, "../escape.mdx");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RustdocError);
      if (err instanceof RustdocError) {
        expect(err.code).toBe(ErrorCode.OUTPUT_WRITE_FAILED);
        expect(err.context).toMatchObject({ outputDir: outDir });
      }
    }
  });
});

describe("formatError", () => {
  it("uses toString for RustdocError so hint is included", () => {
    const err = new RustdocError(ErrorCode.INPUT_READ_FAILED, "boom", { hint: "try X" });
    const formatted = formatError(err);
    expect(formatted).toContain("[INPUT_READ_FAILED]");
    expect(formatted).toContain("boom");
    expect(formatted).toContain("Hint: try X");
  });

  it("prefixes generic Error with 'Error: '", () => {
    expect(formatError(new Error("bad"))).toBe("Error: bad");
  });

  it("stringifies non-Error values", () => {
    expect(formatError("oops")).toBe("Error: oops");
    expect(formatError(42)).toBe("Error: 42");
  });
});

describe("run() - end-to-end CLI", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "rd2fd-cli-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("prints help and returns 0 for --help", async () => {
    const { streams, stdout, stderr } = captureStreams();
    const code = await run(["--help"], streams);
    expect(code).toBe(0);
    expect(stdout()).toContain("rustdoc-to-fumadocs");
    expect(stdout()).toContain("USAGE:");
    expect(stderr()).toBe("");
  });

  it("errors with exit 1 when no input is provided and no Cargo.toml", async () => {
    const { streams, stderr } = captureStreams();
    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      const code = await run([], streams);
      expect(code).toBe(1);
      expect(stderr()).toMatch(/No input specified/);
    } finally {
      process.chdir(cwd);
    }
  });

  it("errors with exit 1 on invalid argument", async () => {
    const { streams, stderr } = captureStreams();
    const code = await run(["--group-by", "wat"], streams);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/Invalid --group-by/);
  });

  it("errors with exit 1 when input file does not exist", async () => {
    const { streams, stderr } = captureStreams();
    const code = await run(["--input", join(tmp, "missing.json")], streams);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/Input file not found/);
  });

  it("errors with exit 1 and valid JSON when --json + missing input", async () => {
    const { streams, stdout } = captureStreams();
    const code = await run(["--input", join(tmp, "missing.json"), "--json"], streams);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout());
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe("INPUT_READ_FAILED");
    expect(parsed.error.message).toMatch(/Input file not found/);
  });

  it("errors with exit 1 when input JSON is malformed", async () => {
    const bad = join(tmp, "bad.json");
    await writeFile(bad, "{not valid json", "utf-8");
    const { streams, stderr } = captureStreams();
    const code = await run(["--input", bad], streams);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/INVALID_JSON/);
  });

  it("performs a dry run without writing files", async () => {
    const { streams, stdout } = captureStreams();
    const outDir = join(tmp, "out");
    const code = await run(["--input", fixturePath, "--output", outDir, "--dry-run"], streams);
    expect(code).toBe(0);
    expect(stdout()).toContain("DRY RUN");
    expect(stdout()).toContain("Would generate");
    await expect(readdir(outDir)).rejects.toThrow();
  });

  it("writes MDX files to the output directory on success", async () => {
    const { streams } = captureStreams();
    const outDir = join(tmp, "out");
    const code = await run(["--input", fixturePath, "--output", outDir], streams);
    expect(code).toBe(0);
    const entries = await readdir(outDir);
    expect(entries.length).toBeGreaterThan(0);
    // Files land under a per-crate directory; recursively confirm at least one
    // .mdx file exists somewhere beneath outDir.
    const allFiles = await collectAllFiles(outDir);
    expect(allFiles.some((p) => p.endsWith(".mdx"))).toBe(true);
    expect(allFiles.some((p) => p.endsWith("meta.json"))).toBe(true);
  });

  it("emits --json output with crate metadata on success", async () => {
    const { streams, stdout } = captureStreams();
    const outDir = join(tmp, "out");
    const code = await run(["--input", fixturePath, "--output", outDir, "--json"], streams);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.success).toBe(true);
    expect(parsed.crate.name).toBe("test_crate");
    expect(parsed.stats.totalFiles).toBeGreaterThan(0);
    expect(typeof parsed.crate.formatVersion).toBe("number");
  });

  it("reports output write failure when the output path is unwritable", async () => {
    // Skip on Windows where chmod semantics differ, and when running as root
    // (root bypasses permission checks so the test cannot force a failure).
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const { streams, stderr } = captureStreams();
    // Make tmp read-only so mkdir inside fails with EACCES.
    await chmod(tmp, 0o500);
    try {
      const code = await run(["--input", fixturePath, "--output", join(tmp, "out")], streams);
      expect(code).toBe(1);
      expect(stderr()).toMatch(/OUTPUT_WRITE_FAILED|EACCES|permission/i);
    } finally {
      await chmod(tmp, 0o700);
    }
  });
});

describe("run() - --crate auto-detection", () => {
  let tmp: string;
  let origCwd: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "rd2fd-cli-crate-"));
    origCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns 1 with hint when --crate json is missing", async () => {
    const { streams, stderr } = captureStreams();
    const code = await run(["--crate", "does_not_exist"], streams);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/Could not find rustdoc JSON/);
    expect(stderr()).toMatch(/target\/doc\/does_not_exist\.json/);
  });

  it("finds rustdoc JSON in target/doc/<crate>.json", async () => {
    const { mkdir: mk } = await import("node:fs/promises");
    await mk(join(tmp, "target", "doc"), { recursive: true });
    // Copy fixture to the expected location
    const content = await readFile(fixturePath, "utf-8");
    await writeFile(join(tmp, "target", "doc", "test_crate.json"), content, "utf-8");

    const { streams } = captureStreams();
    const code = await run(
      ["--crate", "test_crate", "--output", join(tmp, "out"), "--json"],
      streams
    );
    expect(code).toBe(0);
  });
});

describe("run() - --workspace mode", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "rd2fd-cli-ws-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("generates docs for every workspace member with a rustdoc JSON", async () => {
    const { mkdir: mk } = await import("node:fs/promises");
    // Set up a workspace with one member backed by the minimal fixture.
    await mk(join(tmp, "crates", "testy"), { recursive: true });
    await writeFile(join(tmp, "Cargo.toml"), `[workspace]\nmembers = ["crates/testy"]\n`, "utf-8");
    await writeFile(
      join(tmp, "crates", "testy", "Cargo.toml"),
      `[package]\nname = "testy"\nversion = "0.1.0"\n`,
      "utf-8"
    );
    const content = await readFile(fixturePath, "utf-8");
    await mk(join(tmp, "target", "doc"), { recursive: true });
    // The fixture's root crate name is "test_crate" — that's the dir the
    // generator will emit under, and it's what the top-level meta.json
    // should link to (not the Cargo package name "testy").
    await writeFile(join(tmp, "target", "doc", "testy.json"), content, "utf-8");

    const { streams } = captureStreams();
    const outDir = join(tmp, "out");
    const code = await run(["--workspace", tmp, "--output", outDir], streams);
    expect(code).toBe(0);

    // Top-level files exist.
    const topMeta = JSON.parse(await readFile(join(outDir, "meta.json"), "utf-8")) as {
      pages: string[];
    };
    expect(topMeta.pages[0]).toBe("index");
    // Meta should reference the crate's root name, not the Cargo package name.
    expect(topMeta.pages).toContain("...test_crate");
    const indexContent = await readFile(join(outDir, "index.mdx"), "utf-8");
    expect(indexContent).toContain("[`test_crate`](./test_crate)");
    expect(indexContent).toContain("1 crate");
  });

  it("returns a non-zero exit when no member has a rustdoc JSON", async () => {
    const { mkdir: mk } = await import("node:fs/promises");
    await mk(join(tmp, "crates", "ghost"), { recursive: true });
    await writeFile(join(tmp, "Cargo.toml"), `[workspace]\nmembers = ["crates/ghost"]\n`, "utf-8");
    await writeFile(
      join(tmp, "crates", "ghost", "Cargo.toml"),
      `[package]\nname = "ghost"\nversion = "0.1.0"\n`,
      "utf-8"
    );

    const { streams, stderr } = captureStreams();
    const code = await run(["--workspace", tmp, "--output", join(tmp, "out")], streams);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/No workspace members produced output/);
  });

  it("reports a clear error when --workspace points at a non-workspace Cargo.toml", async () => {
    await writeFile(
      join(tmp, "Cargo.toml"),
      `[package]\nname = "solo"\nversion = "0.1.0"\n`,
      "utf-8"
    );

    const { streams, stderr } = captureStreams();
    const code = await run(["--workspace", tmp, "--output", join(tmp, "out")], streams);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/no \[workspace\] table/);
  });
});
