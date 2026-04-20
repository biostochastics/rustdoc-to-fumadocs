#!/usr/bin/env node
/**
 * CLI for converting rustdoc JSON to Fumadocs-compatible MDX files.
 *
 * Usage:
 *   npx tsx src/cli.ts --input target/doc/my_crate.json --output content/docs/api
 *   npx tsx src/cli.ts --crate my_crate --output content/docs/api
 */

import { readFile, writeFile, mkdir, stat, access } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { RustdocGenerator, type GeneratorOptions } from "./generator.js";
import { validateRustdocJson, parseJsonSafe } from "./validation.js";
import {
  RustdocError,
  ErrorCode,
  isRustdocError,
  inputReadError,
  outputWriteError,
} from "./errors.js";
import {
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

/**
 * Maximum number of concurrent file writes.
 * Bounded to avoid EMFILE / file descriptor exhaustion on large crates.
 */
const WRITE_CONCURRENCY = 16;

/**
 * Validates that a resolved output path stays within the intended output directory.
 * Prevents directory traversal attacks where malicious rustdoc JSON could write
 * files outside the target directory.
 *
 * @param outputDir - The base output directory (resolved to absolute path)
 * @param filePath - The file path to validate (relative path from generator)
 * @returns The validated absolute path
 * @throws RustdocError if path escapes the output directory
 */
export function validateOutputPath(outputDir: string, filePath: string): string {
  const resolvedOutput = resolve(outputDir);
  const resolvedFile = resolve(outputDir, filePath);

  // Ensure the resolved file path stays under the output directory.
  // Use a trailing OS-specific separator to prevent prefix attacks
  // (e.g., /output vs /output-evil) on both POSIX and Windows.
  const normalizedOutput = resolvedOutput.endsWith(sep) ? resolvedOutput : resolvedOutput + sep;

  if (!resolvedFile.startsWith(normalizedOutput) && resolvedFile !== resolvedOutput) {
    throw new RustdocError(
      ErrorCode.OUTPUT_WRITE_FAILED,
      `Path traversal detected: "${filePath}" would write outside output directory`,
      {
        hint: "Check the rustdoc JSON for malicious item names containing path separators",
        context: { outputDir: resolvedOutput, attemptedPath: resolvedFile },
      }
    );
  }

  return resolvedFile;
}

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
}

/**
 * JSON output format for --json flag.
 */
export interface JsonOutput {
  success: boolean;
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
                          generate docs for every [workspace].members entry.
                          Overrides --input/--crate.
  -o, --output <dir>      Output directory (default: content/docs/api)
  -b, --base-url <url>    Base URL for generated docs (default: /docs/api)
  -g, --group-by <mode>   Group items by: module, kind, or flat (default: module)
  --no-index              Don't generate index pages for modules
  --no-tabs               Don't use Tabs component for implementations
  --no-cards              Don't use Cards component for cross-references
  -n, --dry-run           Show what would be generated without writing files
  --json                  Output results as JSON (for scripting/CI)
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

  The JSON file will be in target/doc/<crate_name>.json

SUPPORTED FORMATS:
  This tool supports rustdoc JSON format versions 35-57 (Rust 1.76+).
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

async function findRustdocJson(crateName: string): Promise<string | null> {
  const possiblePaths = [
    `target/doc/${crateName}.json`,
    `target/doc/${crateName.replace(/-/g, "_")}.json`,
  ];

  for (const p of possiblePaths) {
    if (await pathExists(p)) {
      return p;
    }
  }

  return null;
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

/**
 * Writes files in bounded-concurrency batches to avoid file descriptor
 * exhaustion on large crates. Directories are created on demand.
 */
async function writeFilesParallel(
  files: { path: string; absolutePath: string; content: string }[],
  concurrency: number,
  onProgress?: (written: number, path: string) => void
): Promise<void> {
  const createdDirs = new Set<string>();
  let written = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const idx = cursor++;
      const file = files[idx];
      const dir = dirname(file.absolutePath);
      if (!createdDirs.has(dir)) {
        try {
          await mkdir(dir, { recursive: true });
        } catch (err) {
          throw outputWriteError(dir, err as Error);
        }
        createdDirs.add(dir);
      }
      try {
        await writeFile(file.absolutePath, file.content);
      } catch (err) {
        throw outputWriteError(file.absolutePath, err as Error);
      }
      written++;
      onProgress?.(written, file.absolutePath);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);
}

/**
 * Loads and validates rustdoc JSON, returning both crate and warnings.
 */
async function loadRustdocJsonWithWarnings(
  path: string,
  verbose: boolean,
  streams: CliStreams
): Promise<{ crate: ReturnType<typeof validateRustdocJson>["crate"]; warnings: string[] }> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    throw inputReadError(path, err as Error);
  }

  const data = parseJsonSafe(content, path);
  const { crate, warnings } = validateRustdocJson(data);

  if (verbose && warnings.length > 0) {
    for (const warning of warnings) {
      streams.stderr(`Warning: ${warning}\n`);
    }
  }

  return { crate, warnings };
}

/**
 * Workspace mode: generate docs for every member of a Cargo workspace.
 *
 * Layout: each member's output goes into `<output>/<member_name>/...` (the
 * single-crate generator already namespaces under the crate name, so we just
 * feed it the same output directory per member and let it fall out).
 * A top-level `meta.json` + `index.mdx` are added for workspace navigation.
 */
async function runWorkspace(
  args: CliArgs,
  streams: CliStreams,
  log: (msg: string) => void,
  workspaceDir: string
): Promise<number> {
  const workspaceTomlPath = resolve(workspaceDir, "Cargo.toml");
  let ws;
  try {
    ws = await loadWorkspace(workspaceTomlPath);
  } catch (err) {
    return emitError(err, args, streams);
  }

  if (ws.members.length === 0) {
    return emitError(
      new RustdocError(
        ErrorCode.INVALID_ITEM_STRUCTURE,
        `Workspace at ${workspaceTomlPath} has no [workspace].members (after exclusions).`,
        {
          hint: "Add at least one crate to the workspace members list, or omit --workspace.",
        }
      ),
      args,
      streams
    );
  }

  log(
    `Workspace: ${ws.rootDir} (${ws.members.length} member${ws.members.length === 1 ? "" : "s"})`
  );

  const targetDir = resolve(ws.rootDir, "target");
  const outputDir = resolve(args.output);
  const allFiles: { path: string; content: string }[] = [];
  const generated: WorkspaceMember[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const member of ws.members) {
    const jsonPath = await findMemberRustdocJson(member.name, targetDir);
    if (!jsonPath) {
      skipped.push({
        name: member.name,
        reason: `no rustdoc JSON at target/doc/${member.name}.json`,
      });
      continue;
    }
    log(`  ${member.name}: ${jsonPath}`);

    // Match the single-crate path's size guard — a multi-GB member JSON
    // would otherwise OOM the entire workspace run before any output
    // landed to disk.
    try {
      const st = await stat(jsonPath);
      if (st.size > MAX_INPUT_SIZE_BYTES) {
        skipped.push({
          name: member.name,
          reason: `JSON exceeds ${Math.round(MAX_INPUT_SIZE_BYTES / 1024 / 1024)}MB cap (${Math.round(st.size / 1024 / 1024)}MB)`,
        });
        continue;
      }
    } catch {
      // stat failed — let readFile produce the real error below.
    }

    let content: string;
    try {
      content = await readFile(jsonPath, "utf-8");
    } catch (err) {
      skipped.push({
        name: member.name,
        reason: `read failed: ${(err as Error).message}`,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonSafe(content, jsonPath);
    } catch (err) {
      skipped.push({
        name: member.name,
        reason: `JSON parse failed: ${(err as Error).message}`,
      });
      continue;
    }
    let crate;
    try {
      crate = validateRustdocJson(parsed).crate;
    } catch (err) {
      skipped.push({
        name: member.name,
        reason: `validation failed: ${(err as Error).message}`,
      });
      continue;
    }

    const options: GeneratorOptions = {
      output: outputDir,
      baseUrl: args.baseUrl,
      generateIndex: !args.noIndex,
      groupBy: args.groupBy,
      useTabs: !args.noTabs,
      useCards: !args.noCards,
    };
    const generator = new RustdocGenerator(crate, options);
    const files = generator.generate();
    allFiles.push(...files);
    // Record the crate's own root name (underscored, matching the output
    // directory the generator emits) rather than the Cargo package name,
    // so the top-level meta.json references the actual on-disk dirs.
    const rootName = crate.index[crate.root]?.name ?? member.name;
    generated.push({ ...member, name: rootName });
  }

  if (generated.length === 0) {
    return emitError(
      new RustdocError(
        ErrorCode.INPUT_READ_FAILED,
        `No workspace members produced output. All ${ws.members.length} members were skipped.`,
        {
          hint: 'Run `cargo doc` with the JSON rustdoc flags before invoking --workspace. Example:\n  RUSTC_BOOTSTRAP=1 RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo doc --workspace --no-deps',
          context: { skipped },
        }
      ),
      args,
      streams
    );
  }

  // Top-level workspace index + meta.json.
  const workspaceName = ws.rootDir.split(sep).filter(Boolean).pop() ?? "workspace";
  allFiles.push({
    path: "meta.json",
    content: renderWorkspaceMeta(generated, "API"),
  });
  allFiles.push({
    path: "index.mdx",
    content: renderWorkspaceIndex(workspaceName, generated),
  });

  for (const s of skipped) {
    streams.stderr(`Warning: skipped ${s.name}: ${s.reason}\n`);
  }

  return writeAndReport(args, streams, log, outputDir, allFiles, {
    totalMembers: generated.length,
    skippedMembers: skipped.length,
  });
}

/**
 * Shared file-writing path used by both single-crate and workspace modes.
 * Handles dry-run, JSON output, progress, and the actual parallel write.
 */
async function writeAndReport(
  args: CliArgs,
  streams: CliStreams,
  log: (msg: string) => void,
  outputDir: string,
  files: { path: string; content: string }[],
  extra?: { totalMembers?: number; skippedMembers?: number }
): Promise<number> {
  const stats = {
    totalFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.content.length, 0),
    mdxFiles: files.filter((f) => f.path.endsWith(".mdx")).length,
    metaFiles: files.filter((f) => f.path.endsWith(".json")).length,
  };

  if (args.json) {
    const output: JsonOutput = {
      success: true,
      files: files.map((f) => ({ path: f.path, size: f.content.length })),
      stats,
    };
    streams.stdout(JSON.stringify(output, null, 2) + "\n");
    return 0;
  }

  if (args.dryRun) {
    streams.stdout(`\n--- DRY RUN ---\n`);
    streams.stdout(`Would write ${stats.totalFiles} files (${stats.totalBytes} bytes)\n`);
    if (extra?.totalMembers !== undefined) {
      streams.stdout(`Workspace members generated: ${extra.totalMembers}\n`);
      if (extra.skippedMembers)
        streams.stdout(`Workspace members skipped: ${extra.skippedMembers}\n`);
    }
    streams.stdout(`--- END DRY RUN ---\n`);
    return 0;
  }

  log(`Generating ${files.length} files to: ${outputDir}`);

  const writable: { path: string; absolutePath: string; content: string }[] = [];
  let skippedEmpty = 0;
  for (const file of files) {
    if (!file.content.trim() && !file.path.endsWith(".json")) {
      skippedEmpty++;
      continue;
    }
    writable.push({
      path: file.path,
      absolutePath: validateOutputPath(outputDir, file.path),
      content: file.content,
    });
  }

  try {
    await writeFilesParallel(writable, WRITE_CONCURRENCY, (_written, path) => {
      if (args.verbose) streams.stdout(`  -> ${path}\n`);
    });
  } catch (err) {
    return emitError(err, args, streams);
  }

  if (skippedEmpty > 0) log(`Skipped ${skippedEmpty} empty file(s)`);
  log("Done!");
  return 0;
}

/**
 * Runs the CLI and returns an exit code. Designed to be testable: pure
 * function-style (no `process.exit`), accepts argv and stream injection.
 */
export async function run(argv: string[], streams: CliStreams = defaultStreams): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgParseError) {
      streams.stderr(err.message + "\n");
      return 1;
    }
    throw err;
  }

  if (args.help) {
    streams.stdout(helpText());
    return 0;
  }

  // In JSON mode, info messages are suppressed but errors still go to stderr.
  const topLog: (msg: string) => void = args.json
    ? () => undefined
    : (msg) => streams.stdout(msg + "\n");

  // Workspace mode: delegate entirely. --input and --crate are ignored here
  // by design, since workspace iteration sources its inputs from Cargo.toml.
  if (args.workspace !== undefined) {
    return runWorkspace(args, streams, topLog, resolve(args.workspace));
  }

  // Determine input path
  let inputPath: string | null = null;

  if (args.input) {
    inputPath = resolve(args.input);
  } else if (args.crate) {
    inputPath = await findRustdocJson(args.crate);
    if (!inputPath) {
      const error = new RustdocError(
        ErrorCode.INPUT_READ_FAILED,
        `Could not find rustdoc JSON for crate "${args.crate}"`,
        {
          hint:
            "Make sure you've generated rustdoc JSON first:\n" +
            '  RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps\n\n' +
            `Looked in:\n` +
            `  - target/doc/${args.crate}.json\n` +
            `  - target/doc/${args.crate.replace(/-/g, "_")}.json`,
          context: { crate: args.crate },
        }
      );
      return emitError(error, args, streams);
    }
  }

  if (!inputPath) {
    // Try to auto-detect from Cargo.toml
    if (await pathExists("Cargo.toml")) {
      try {
        const cargoToml = await readFile("Cargo.toml", "utf-8");
        // Support both double and single quotes in Cargo.toml name field
        const nameMatch = /^name\s*=\s*["']([^"']+)["']/m.exec(cargoToml);
        if (nameMatch) {
          const crateName = nameMatch[1];
          inputPath = await findRustdocJson(crateName);
          if (inputPath && args.verbose) {
            streams.stdout(`Auto-detected crate: ${crateName}\n`);
          }
        }
      } catch {
        // Ignore Cargo.toml read errors for auto-detection
      }
    }
  }

  if (!inputPath) {
    streams.stderr("Error: No input specified. Use --input or --crate.\n");
    streams.stderr("Run with --help for usage information.\n");
    return 1;
  }

  if (!(await pathExists(inputPath))) {
    const error = new RustdocError(
      ErrorCode.INPUT_READ_FAILED,
      `Input file not found: ${inputPath}`,
      {
        hint: "Check that the file path is correct and the file exists.",
        context: { path: inputPath },
      }
    );
    return emitError(error, args, streams);
  }

  // Check file size before loading to prevent memory exhaustion
  try {
    const stats = await stat(inputPath);
    if (stats.size > MAX_INPUT_SIZE_BYTES) {
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      const maxSizeMB = (MAX_INPUT_SIZE_BYTES / (1024 * 1024)).toFixed(0);
      const error = new RustdocError(
        ErrorCode.INPUT_READ_FAILED,
        `Input file too large: ${sizeMB}MB (max: ${maxSizeMB}MB)`,
        {
          hint:
            "The rustdoc JSON file is extremely large. Consider:\n" +
            "- Generating docs for fewer crates\n" +
            "- Using --no-deps to exclude dependencies\n" +
            "- Splitting the crate into smaller subcrates",
          context: { path: inputPath, sizeBytes: stats.size, maxBytes: MAX_INPUT_SIZE_BYTES },
        }
      );
      return emitError(error, args, streams);
    }
  } catch (err) {
    // If we can't stat the file, proceed and let the read handle the error
    if (args.verbose) {
      streams.stderr(`Warning: Could not check file size: ${(err as Error).message}\n`);
    }
  }

  // In JSON mode, info messages are suppressed but errors still go to stderr.
  const log: (msg: string) => void = args.json
    ? () => undefined
    : (msg) => streams.stdout(msg + "\n");

  log(`Loading rustdoc JSON from: ${inputPath}`);

  let validationWarnings: string[] = [];
  let crate;

  try {
    const result = await loadRustdocJsonWithWarnings(inputPath, args.verbose, streams);
    crate = result.crate;
    validationWarnings = result.warnings;
  } catch (err) {
    return emitError(err, args, streams);
  }

  log(
    `Loaded crate: ${crate.index[crate.root]?.name ?? "unknown"} (format version ${crate.format_version})`
  );

  const options: GeneratorOptions = {
    output: resolve(args.output),
    baseUrl: args.baseUrl,
    generateIndex: !args.noIndex,
    groupBy: args.groupBy,
    useTabs: !args.noTabs,
    useCards: !args.noCards,
  };

  const generator = new RustdocGenerator(crate, options);
  const files = generator.generate();

  const stats = {
    totalFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.content.length, 0),
    mdxFiles: files.filter((f) => f.path.endsWith(".mdx")).length,
    metaFiles: files.filter((f) => f.path.endsWith(".json")).length,
  };

  if (args.json) {
    const output: JsonOutput = {
      success: true,
      crate: {
        name: crate.index[crate.root]?.name ?? "unknown",
        version: crate.crate_version ?? null,
        formatVersion: crate.format_version,
      },
      files: files.map((f) => ({ path: f.path, size: f.content.length })),
      stats,
      warnings: validationWarnings.length > 0 ? validationWarnings : undefined,
    };
    streams.stdout(JSON.stringify(output, null, 2) + "\n");
    return 0;
  }

  if (args.dryRun) {
    streams.stdout("\n--- DRY RUN ---\n");
    streams.stdout(`Would generate ${files.length} files to: ${args.output}\n\n`);

    const mdxFiles = files.filter((f) => f.path.endsWith(".mdx"));
    const metaFiles = files.filter((f) => f.path.endsWith(".json"));

    streams.stdout(`MDX files (${mdxFiles.length}):\n`);
    for (const file of mdxFiles.slice(0, 20)) {
      streams.stdout(`  ${file.path} (${file.content.length} bytes)\n`);
    }
    if (mdxFiles.length > 20) {
      streams.stdout(`  ... and ${mdxFiles.length - 20} more\n`);
    }

    streams.stdout(`\nmeta.json files (${metaFiles.length}):\n`);
    for (const file of metaFiles.slice(0, 10)) {
      streams.stdout(`  ${file.path}\n`);
    }
    if (metaFiles.length > 10) {
      streams.stdout(`  ... and ${metaFiles.length - 10} more\n`);
    }

    streams.stdout(`\nTotal: ${stats.totalBytes.toLocaleString()} bytes\n`);

    if (validationWarnings.length > 0) {
      streams.stdout(`\nWarnings (${validationWarnings.length}):\n`);
      for (const w of validationWarnings) {
        streams.stdout(`  ! ${w}\n`);
      }
    }

    streams.stdout("\n--- END DRY RUN ---\n");
    return 0;
  }

  log(`Generating ${files.length} files to: ${args.output}`);

  // Filter out empty MDX files (meta.json may be minimal so it's allowed)
  const writable: { path: string; absolutePath: string; content: string }[] = [];
  let skippedEmpty = 0;
  for (const file of files) {
    if (!file.content.trim() && !file.path.endsWith(".json")) {
      skippedEmpty++;
      if (args.verbose) {
        streams.stderr(`Skipping empty file: ${file.path}\n`);
      }
      continue;
    }
    writable.push({
      path: file.path,
      absolutePath: validateOutputPath(args.output, file.path),
      content: file.content,
    });
  }

  const showProgress = writable.length > 50 && !args.verbose && !args.json;
  if (showProgress) {
    streams.stdout(`Writing files... 0/${writable.length}`);
  }

  try {
    await writeFilesParallel(writable, WRITE_CONCURRENCY, (written, path) => {
      if (showProgress && written % 10 === 0) {
        streams.stdout(`\rWriting files... ${written}/${writable.length}`);
      }
      if (args.verbose) {
        streams.stdout(`  -> ${path}\n`);
      }
    });
  } catch (err) {
    return emitError(err, args, streams);
  }

  if (showProgress) {
    streams.stdout(`\rWriting files... ${writable.length}/${writable.length}\n`);
  }

  if (skippedEmpty > 0) {
    log(`Skipped ${skippedEmpty} empty file(s)`);
  }

  log("Done!");
  return 0;
}

function emitError(err: unknown, args: CliArgs, streams: CliStreams): number {
  if (args.json) {
    const output: JsonOutput = {
      success: false,
      error: isRustdocError(err)
        ? { code: err.code, message: err.message, hint: err.hint }
        : { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) },
    };
    streams.stdout(JSON.stringify(output, null, 2) + "\n");
    return 1;
  }
  streams.stderr(formatError(err) + "\n");
  return 1;
}

// Run when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(formatError(err) + "\n");
      process.exit(1);
    }
  );
}
