#!/usr/bin/env node
/**
 * CLI for converting rustdoc JSON to Fumadocs-compatible MDX files.
 *
 * Usage:
 *   npx tsx src/cli.ts --input target/doc/my_crate.json --output content/docs/api
 *   npx tsx src/cli.ts --crate my_crate --output content/docs/api
 */

import { readFile, stat, access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parse as parseToml } from "smol-toml";
import { OutputTransaction } from "./output.js";
export { validateOutputPath } from "./output.js";
import {
  RustdocGenerator,
  sanitizePath,
  type GeneratedFile,
  type GeneratorOptions,
} from "./generator.js";
import { validateRustdocJson, parseJsonSafe } from "./validation.js";
import { RustdocError, ErrorCode, isRustdocError, inputReadError } from "./errors.js";
import {
  cargoWorkspace,
  loadWorkspace,
  findMemberRustdocJson,
  renderWorkspaceMeta,
  renderWorkspaceIndex,
  type WorkspaceMember,
} from "./workspace.js";

/**
 * Maximum input file size in bytes (100MB).
 * Prevents memory exhaustion from extremely large rustdoc JSON files.
 */
const MAX_INPUT_SIZE_BYTES = 100 * 1024 * 1024;

export interface CliArgs {
  input?: string;
  crate?: string;
  /**
   * If set, treat the given directory as a Cargo workspace root. The tool will
   * read `<workspace>/Cargo.toml`, enumerate `[workspace].members`, and
   * generate docs for every member into `<output>/<member_name>/`.
   *
   * When provided without a value (e.g. bare `--workspace`), the current
   * working directory is used. `--input` and `--crate` are ignored in this
   * mode.
   */
  workspace?: string;
  /**
   * Cargo target directory holding `doc/<crate>.json`. Defaults to
   * `$CARGO_TARGET_DIR`, then `<workspace>/target` (or `./target`).
   */
  targetDir?: string;
  /** Source repository URL for "Source" links (see GeneratorOptions.sourceUrlBase). */
  sourceUrlBase?: string;
  /** Git ref for source links (see GeneratorOptions.sourceRef). */
  sourceRef?: string;
  /** Workspace members to leave out (package or crate names). */
  exclude: string[];
  /** Also document workspace members with `publish = false`. */
  includeUnpublished: boolean;
  output: string;
  baseUrl: string;
  groupBy: "module" | "kind" | "flat";
  noIndex: boolean;
  noTabs: boolean;
  noCards: boolean;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

/**
 * JSON output format for --json flag.
 */
export interface JsonOutput {
  success: boolean;
  status?: "complete" | "partial";
  workspace?: { generated: string[]; skipped: MemberIssue[] };
  crate?: {
    name: string;
    version: string | null;
    formatVersion: number;
  };
  files?: { path: string; size: number }[];
  stats?: {
    totalFiles: number;
    totalBytes: number;
    mdxFiles: number;
    metaFiles: number;
  };
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    hint?: string;
    context?: Record<string, unknown>;
  };
}

/**
 * Streams to use for CLI output. Tests inject these to capture output without
 * touching the real process streams.
 */
export interface CliStreams {
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

const defaultStreams: CliStreams = {
  stdout: (msg) => process.stdout.write(msg),
  stderr: (msg) => process.stderr.write(msg),
};

class ArgParseError extends Error {}

/**
 * Parses CLI arguments from an explicit argv array.
 *
 * Throws {@link ArgParseError} on invalid input rather than calling
 * `process.exit()`, so the function is safe to use from tests.
 */
export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    output: "content/docs/api",
    baseUrl: "/docs/api",
    groupBy: "module",
    noIndex: false,
    noTabs: false,
    noCards: false,
    dryRun: false,
    json: false,
    verbose: false,
    help: false,
    version: false,
    exclude: [],
    includeUnpublished: false,
  };

  const requireValue = (flag: string, next: string | undefined, label: string): string => {
    if (next === undefined || next.startsWith("-")) {
      throw new ArgParseError(`Error: ${flag} requires ${label}`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-V":
      case "--version":
        result.version = true;
        break;
      case "-h":
      case "--help":
        result.help = true;
        break;
      case "-v":
      case "--verbose":
        result.verbose = true;
        break;
      case "-i":
      case "--input":
        result.input = requireValue(arg, argv[++i], "a path argument");
        break;
      case "-c":
      case "--crate":
        result.crate = requireValue(arg, argv[++i], "a name argument");
        break;
      case "-o":
      case "--output":
        result.output = requireValue(arg, argv[++i], "a directory argument");
        break;
      case "-b":
      case "--base-url":
        result.baseUrl = requireValue(arg, argv[++i], "a URL argument");
        break;
      case "-g":
      case "--group-by": {
        const mode = requireValue(arg, argv[++i], "a mode argument (module, kind, or flat)");
        if (mode !== "module" && mode !== "kind" && mode !== "flat") {
          throw new ArgParseError(
            `Error: Invalid --group-by value "${mode}". Must be: module, kind, or flat`
          );
        }
        result.groupBy = mode;
        break;
      }
      case "--no-index":
        result.noIndex = true;
        break;
      case "--no-tabs":
        result.noTabs = true;
        break;
      case "--no-cards":
        result.noCards = true;
        break;
      case "-n":
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--target-dir":
        result.targetDir = requireValue(arg, argv[++i], "a directory argument");
        break;
      case "--source-url-base":
        result.sourceUrlBase = requireValue(arg, argv[++i], "a URL argument");
        break;
      case "--source-ref":
        result.sourceRef = requireValue(arg, argv[++i], "a git ref argument");
        break;
      case "--exclude":
        result.exclude.push(
          ...requireValue(arg, argv[++i], "a crate name argument")
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean)
        );
        break;
      case "--include-unpublished":
        result.includeUnpublished = true;
        break;
      case "-w":
      case "--workspace": {
        // Accept an optional directory argument. If the next token is another
        // flag or absent, default to "." (cwd).
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          result.workspace = next;
          i++;
        } else {
          result.workspace = ".";
        }
        break;
      }
      default:
        if (arg.startsWith("-")) throw new ArgParseError(`Unknown option: ${arg}`);
        // Positional argument - treat as input
        if (!result.input && !arg.startsWith("-")) {
          result.input = arg;
        }
    }
  }

  return result;
}

function helpText(): string {
  return `
rustdoc-to-fumadocs - Convert rustdoc JSON to Fumadocs MDX

USAGE:
  rustdoc-to-fumadocs [OPTIONS] [INPUT]

OPTIONS:
  -i, --input <path>      Path to rustdoc JSON file
  -c, --crate <name>      Crate name (will look in target/doc/<name>.json)
  -w, --workspace [dir]   Treat <dir> (or cwd) as a Cargo workspace root and
                          generate docs for selected Cargo workspace members.
                          Overrides --input/--crate.
  --target-dir <dir>      Cargo target directory containing doc/<crate>.json
                          (default: $CARGO_TARGET_DIR or Cargo's configured target)
  --exclude <crates>      Workspace members to skip (comma-separated or
                          repeated; package or crate names)
  --include-unpublished   Also document workspace members with
                          publish = false (skipped by default)
  -o, --output <dir>      Output directory (default: content/docs/api)
  -b, --base-url <url>    Base URL for generated docs (default: /docs/api)
  --source-url-base <url> Repository URL for "Source" links and for
                          repository-relative links in docstrings, e.g.
                          https://github.com/org/repo
  --source-ref <ref>      Git ref for source links (adds /blob/<ref>/)
  -g, --group-by <mode>   Group items by: module, kind, or flat (default: module)
  --no-index              Don't generate index pages for modules
  --no-tabs               Don't use Tabs component for implementations
  --no-cards              Don't use Cards component for cross-references
  -n, --dry-run           Show what would be generated without writing files
  --json                  Preview the file manifest as JSON without writing files
  -V, --version           Print the installed package version
  -v, --verbose           Show verbose output
  -h, --help              Show this help message

EXAMPLES:
  # From local rustdoc JSON
  rustdoc-to-fumadocs --input target/doc/my_crate.json --output docs/api

  # Auto-detect from crate name
  rustdoc-to-fumadocs --crate my_crate --output docs/api

  # Whole Cargo workspace (one output subdir per member crate)
  cargo doc --workspace --no-deps  # with the JSON RUSTDOCFLAGS
  rustdoc-to-fumadocs --workspace --output docs/api

  # Dry run to preview output
  rustdoc-to-fumadocs --crate my_crate --dry-run

  # JSON output for CI/scripts
  rustdoc-to-fumadocs --crate my_crate --json

  # Generate rustdoc JSON first, then convert
  RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps
  rustdoc-to-fumadocs --input target/doc/my_crate.json

GENERATING RUSTDOC JSON:
  Rustdoc JSON requires nightly Rust or the RUSTC_BOOTSTRAP=1 env var:

  # Using nightly:
  RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps

  # Using stable with bootstrap:
  RUSTC_BOOTSTRAP=1 RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo doc --no-deps

  The JSON file will be in target/doc/<crate_name>.json (or under
  $CARGO_TARGET_DIR / --target-dir when set)

SUPPORTED FORMATS:
  This tool supports rustdoc JSON format versions 27-61 (Rust 1.76 through 1.100 and the 2026-11-17 nightly).
  Newer versions may work but could have unsupported features.
`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Cargo target directory to read rustdoc JSON from: `--target-dir`, then
 * `$CARGO_TARGET_DIR` (both relative to the current directory, as Cargo
 * resolves them), then `<root>/target`.
 */
export function resolveTargetDir(
  flag: string | undefined,
  root: string,
  discovered?: string
): string {
  if (flag) return resolve(flag);
  const env = process.env.CARGO_TARGET_DIR;
  if (env) return resolve(env);
  return discovered ?? resolve(root, "target");
}

/**
 * Formats an error for display, using RustdocError hints when available.
 *
 * @param error - The error to format
 * @returns Formatted error string
 */
export function formatError(error: unknown): string {
  if (isRustdocError(error)) {
    return error.toString();
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return `Error: ${String(error)}`;
}

async function loadInput(path: string) {
  let content: string;
  try {
    if ((await stat(path)).size > MAX_INPUT_SIZE_BYTES)
      throw new RustdocError(
        ErrorCode.INPUT_READ_FAILED,
        `Input file too large: ${path} (max: 100MB)`
      );
    content = await readFile(path, "utf8");
  } catch (err) {
    if (isRustdocError(err)) throw err;
    throw inputReadError(path, err as Error);
  }
  return {
    ...validateRustdocJson(parseJsonSafe(content, path)),
    digest: createHash("sha256").update(content).digest("hex"),
  };
}

async function singleInput(args: CliArgs): Promise<{ path: string; packageName?: string }> {
  if (args.input) {
    if (!(await pathExists(args.input)))
      throw new RustdocError(ErrorCode.INPUT_READ_FAILED, `Input file not found: ${args.input}`, {
        hint: "Check the input path and permissions.",
      });
    return { path: resolve(args.input) };
  }
  let name = args.crate;
  let pkgName: string | undefined;
  let targetName: string | undefined;
  let discovered: string | undefined;
  if (await pathExists("Cargo.toml")) {
    const manifestPath = resolve("Cargo.toml");
    const workspace = await cargoWorkspace(manifestPath);
    discovered = workspace?.targetDirectory;
    const member = workspace?.members.find((p) =>
      name ? p.name === name || p.crateName === name : p.path === process.cwd()
    );
    if (member) {
      pkgName = member.name;
      targetName = member.crateName;
    } else if (!workspace) {
      // A prebuilt target can still be selected when the local manifest is unusable.
      try {
        const manifest = parseToml(await readFile(manifestPath, "utf8")) as {
          package?: { name?: string };
          lib?: { name?: string };
        };
        if (!name || name === manifest.package?.name || name === manifest.lib?.name) {
          pkgName = manifest.package?.name;
          targetName = manifest.lib?.name;
        }
      } catch (err) {
        if (!name) throw err;
      }
    }
    name ??= pkgName;
  }
  if (!name)
    throw new RustdocError(
      ErrorCode.INPUT_READ_FAILED,
      "No input specified. Use --input or --crate."
    );
  const dir = resolveTargetDir(args.targetDir, ".", discovered);
  const candidate = targetName ?? name;
  const path = await findMemberRustdocJson(candidate, dir);
  if (!path)
    throw new RustdocError(
      ErrorCode.INPUT_READ_FAILED,
      `Could not find rustdoc JSON for crate "${name}" at ${join(dir, "doc", candidate.replace(/-/g, "_") + ".json")}`,
      { hint: "Generate rustdoc JSON first and check --target-dir." }
    );
  return { path, packageName: pkgName };
}

interface MemberIssue {
  name: string;
  reason: string;
}

/** Report projected bytes from the same files staged for writing. */
async function generate(args: CliArgs, streams: CliStreams): Promise<number> {
  const warnings = new Set<string>();
  const warn = (msg: string): void => {
    if (warnings.has(msg)) return;
    warnings.add(msg);
    streams.stderr(`Warning: ${msg}\n`);
  };
  const log = (msg: string): void => {
    if (!args.json) streams.stdout(msg + "\n");
  };
  const output = resolve(args.output);
  const options = (name?: string): GeneratorOptions => ({
    output,
    baseUrl: args.baseUrl,
    groupBy: args.groupBy,
    generateIndex: !args.noIndex,
    useCards: !args.noCards,
    useTabs: !args.noTabs,
    sourceUrlBase: args.sourceUrlBase,
    sourceRef: args.sourceRef,
    packageName: name,
    onWarning: (msg) => warn(name ? name + ": " + msg : msg),
  });
  const files: { path: string; size: number }[] = [];
  let transaction: OutputTransaction | undefined;
  const preview = args.dryRun || args.json;
  const accept = async (batch: GeneratedFile[]): Promise<void> => {
    if (!preview) {
      transaction ??= await OutputTransaction.open(output);
      await transaction.add(batch);
    }
    for (const f of batch) files.push({ path: f.path, size: Buffer.byteLength(f.content) });
  };
  let owner = "workspace";
  let crateInfo: JsonOutput["crate"];
  let workspaceInfo: { generated: string[]; skipped: MemberIssue[] } | undefined;
  try {
    if (args.workspace !== undefined) {
      const ws = await loadWorkspace(resolve(args.workspace, "Cargo.toml"));
      const excluded = new Set(args.exclude.map((n) => n.replace(/-/g, "_")));
      const members = ws.members.filter(
        (m) =>
          !excluded.has(m.name.replace(/-/g, "_")) &&
          !excluded.has(m.crateName ?? m.name) &&
          (m.publish !== false || args.includeUnpublished)
      );
      const target = resolveTargetDir(args.targetDir, ws.rootDir, ws.targetDirectory);
      const skipped = [...(ws.skipped ?? [])];
      const prepared: {
        member: WorkspaceMember;
        path: string;
        hash: string;
        root: string;
        landingUrl: string | null;
      }[] = [];
      const pages = new Map<string, string>();
      const roots = new Set<string>();
      for (const member of members) {
        const path = await findMemberRustdocJson(member.crateName ?? member.name, target);
        if (!path) {
          skipped.push({
            name: member.name,
            reason: `no rustdoc JSON for ${member.crateName ?? member.name} in ${join(target, "doc")}`,
          });
          continue;
        }
        let input;
        try {
          input = await loadInput(path);
        } catch (err) {
          skipped.push({ name: member.name, reason: formatError(err) });
          continue;
        }
        for (const w of input.warnings) warn(`${member.name}: ${w}`);
        const generator = new RustdocGenerator(input.crate, options(member.name));
        const root = sanitizePath(input.crate.index[input.crate.root]?.name ?? member.name);
        if (roots.has(root.toLowerCase()))
          throw new RustdocError(
            ErrorCode.INVALID_ITEM_STRUCTURE,
            `Multiple workspace members use the output directory ${root}`
          );
        roots.add(root.toLowerCase());
        for (const [key, url] of generator.pageIndex()) if (!pages.has(key)) pages.set(key, url);
        prepared.push({
          member,
          path,
          hash: input.digest,
          root,
          landingUrl: generator.landingUrl(),
        });
      }
      for (const issue of skipped) warn(`skipped ${issue.name}: ${issue.reason}`);
      if (!prepared.length)
        throw new RustdocError(
          ErrorCode.INPUT_READ_FAILED,
          "No workspace members produced output.",
          {
            hint: "Generate rustdoc JSON for the selected workspace members.",
            context: { skipped },
          }
        );
      const nav: WorkspaceMember[] = [];
      for (const p of prepared) {
        const input = await loadInput(p.path);
        if (input.digest !== p.hash)
          throw new RustdocError(
            ErrorCode.INPUT_READ_FAILED,
            `Rustdoc input changed during generation: ${p.path}. Retry the conversion.`
          );
        const gen = new RustdocGenerator(input.crate, {
          ...options(p.member.name),
          externalPages: pages,
        });
        await accept(gen.generate());
        nav.push({ ...p.member, name: p.root, landingUrl: p.landingUrl });
      }
      await accept([
        { path: "meta.json", content: renderWorkspaceMeta(nav, "API") },
        {
          path: "index.mdx",
          content: renderWorkspaceIndex(basename(ws.rootDir), nav, args.baseUrl),
        },
      ]);
      workspaceInfo = { generated: prepared.map((p) => p.member.name), skipped };
    } else {
      const { path, packageName } = await singleInput(args);
      const input = await loadInput(path);
      for (const w of input.warnings) warn(w);
      const name = input.crate.index[input.crate.root]?.name ?? "crate";
      owner = "crate:" + sanitizePath(name);
      crateInfo = {
        name,
        version: input.crate.crate_version ?? null,
        formatVersion: input.crate.format_version,
      };
      log(`Loaded crate: ${name} (format version ${input.crate.format_version})`);
      await accept(new RustdocGenerator(input.crate, options(packageName)).generate());
    }
    if (transaction) await transaction.commit(owner, !workspaceInfo?.skipped.length);
    const stats = {
      totalFiles: files.length,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      mdxFiles: files.filter((f) => f.path.endsWith(".mdx")).length,
      metaFiles: files.filter((f) => f.path.endsWith(".json")).length,
    };
    if (args.json) {
      streams.stdout(
        JSON.stringify(
          {
            success: true,
            status: workspaceInfo?.skipped.length ? "partial" : "complete",
            crate: crateInfo,
            workspace: workspaceInfo,
            files,
            stats,
            warnings: warnings.size ? [...warnings] : undefined,
          },
          null,
          2
        ) + "\n"
      );
    } else {
      if (args.dryRun) log("--- DRY RUN ---");
      log(
        `${preview ? "Would generate" : "Generated"} ${files.length} files to: ${output} (${stats.totalBytes} bytes)`
      );
      if (args.verbose || args.dryRun) for (const f of files) log(`  ${f.path} (${f.size} bytes)`);
      if (args.dryRun) log("--- END DRY RUN ---");
    }
    return 0;
  } finally {
    await transaction?.close();
  }
}

export async function run(argv: string[], streams: CliStreams = defaultStreams): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      streams.stdout(helpText());
      return 0;
    }
    if (args.version) {
      const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
      streams.stdout(pkg.version + "\n");
      return 0;
    }
    return await generate(args, streams);
  } catch (err) {
    return emitError(err, { json: argv.includes("--json") }, streams);
  }
}

function emitError(err: unknown, args: Pick<CliArgs, "json">, streams: CliStreams): number {
  if (args.json) {
    const output: JsonOutput = {
      success: false,
      error: isRustdocError(err)
        ? { code: err.code, message: err.message, hint: err.hint, context: err.context }
        : { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) },
    };
    streams.stdout(JSON.stringify(output, null, 2) + "\n");
    return 1;
  }
  streams.stderr(formatError(err) + "\n");
  return 1;
}

/**
 * True when `argv1` (the script node was started with) is this module. Both
 * sides are resolved through symlinks: npm and npx start the CLI through a
 * `node_modules/.bin` symlink, and comparing the raw paths made the CLI a
 * silent no-op there.
 */
export function isDirectInvocation(argv1: string | undefined, moduleUrl: string): boolean {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

// Run when invoked directly (not when imported by tests).
if (isDirectInvocation(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(formatError(err) + "\n");
      process.exitCode = 1;
    }
  );
}
