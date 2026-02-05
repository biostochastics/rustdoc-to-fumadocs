#!/usr/bin/env node
/**
 * CLI for converting rustdoc JSON to Fumadocs-compatible MDX files.
 *
 * Usage:
 *   npx tsx src/cli.ts --input target/doc/my_crate.json --output content/docs/api
 *   npx tsx src/cli.ts --crate my_crate --output content/docs/api
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RustdocGenerator, type GeneratorOptions } from "./generator.js";
import { validateRustdocJson, parseJsonSafe } from "./validation.js";
import {
  RustdocError,
  ErrorCode,
  isRustdocError,
  inputReadError,
  outputWriteError,
} from "./errors.js";

/**
 * Maximum input file size in bytes (100MB).
 * Prevents memory exhaustion from extremely large rustdoc JSON files.
 */
const MAX_INPUT_SIZE_BYTES = 100 * 1024 * 1024;

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
function validateOutputPath(outputDir: string, filePath: string): string {
  const resolvedOutput = resolve(outputDir);
  const resolvedFile = resolve(outputDir, filePath);

  // Ensure the resolved file path starts with the output directory
  // Use trailing separator to prevent prefix attacks (e.g., /output vs /output-evil)
  const normalizedOutput = resolvedOutput.endsWith("/") ? resolvedOutput : resolvedOutput + "/";

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

interface CliArgs {
  input?: string;
  crate?: string;
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
interface JsonOutput {
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

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
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
        if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
          console.error("Error: --input requires a path argument");
          process.exit(1);
        }
        result.input = args[++i];
        break;
      case "-c":
      case "--crate":
        if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
          console.error("Error: --crate requires a name argument");
          process.exit(1);
        }
        result.crate = args[++i];
        break;
      case "-o":
      case "--output":
        if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
          console.error("Error: --output requires a directory argument");
          process.exit(1);
        }
        result.output = args[++i];
        break;
      case "-b":
      case "--base-url":
        if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
          console.error("Error: --base-url requires a URL argument");
          process.exit(1);
        }
        result.baseUrl = args[++i];
        break;
      case "-g":
      case "--group-by": {
        if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
          console.error("Error: --group-by requires a mode argument (module, kind, or flat)");
          process.exit(1);
        }
        const mode = args[++i];
        if (mode !== "module" && mode !== "kind" && mode !== "flat") {
          console.error(
            `Error: Invalid --group-by value "${mode}". Must be: module, kind, or flat`
          );
          process.exit(1);
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
      default:
        // Positional argument - treat as input
        if (!result.input && !arg.startsWith("-")) {
          result.input = arg;
        }
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
rustdoc-to-fumadocs - Convert rustdoc JSON to Fumadocs MDX

USAGE:
  rustdoc-to-fumadocs [OPTIONS] [INPUT]

OPTIONS:
  -i, --input <path>      Path to rustdoc JSON file
  -c, --crate <name>      Crate name (will look in target/doc/<name>.json)
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
`);
}

function findRustdocJson(crateName: string): string | null {
  const possiblePaths = [
    `target/doc/${crateName}.json`,
    `target/doc/${crateName.replace(/-/g, "_")}.json`,
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
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
function formatError(error: unknown): string {
  if (isRustdocError(error)) {
    return error.toString();
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return `Error: ${String(error)}`;
}

function main(): void {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Determine input path
  let inputPath: string | null = null;

  if (args.input) {
    inputPath = resolve(args.input);
  } else if (args.crate) {
    inputPath = findRustdocJson(args.crate);
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
      console.error(formatError(error));
      process.exit(1);
    }
  }

  if (!inputPath) {
    // Try to auto-detect from Cargo.toml
    if (existsSync("Cargo.toml")) {
      try {
        const cargoToml = readFileSync("Cargo.toml", "utf-8");
        const nameMatch = /^name\s*=\s*"([^"]+)"/m.exec(cargoToml);
        if (nameMatch) {
          const crateName = nameMatch[1];
          inputPath = findRustdocJson(crateName);
          if (inputPath && args.verbose) {
            console.log(`Auto-detected crate: ${crateName}`);
          }
        }
      } catch {
        // Ignore Cargo.toml read errors for auto-detection
      }
    }
  }

  if (!inputPath) {
    console.error("Error: No input specified. Use --input or --crate.");
    console.error("Run with --help for usage information.");
    process.exit(1);
  }

  if (!existsSync(inputPath)) {
    const error = new RustdocError(
      ErrorCode.INPUT_READ_FAILED,
      `Input file not found: ${inputPath}`,
      {
        hint: "Check that the file path is correct and the file exists.",
        context: { path: inputPath },
      }
    );
    console.error(formatError(error));
    process.exit(1);
  }

  // Check file size before loading to prevent memory exhaustion
  try {
    const stats = statSync(inputPath);
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
      if (args.json) {
        const output: JsonOutput = {
          success: false,
          error: { code: error.code, message: error.message, hint: error.hint },
        };
        console.log(JSON.stringify(output, null, 2));
        process.exit(1);
      }
      console.error(formatError(error));
      process.exit(1);
    }
  } catch (err) {
    // If we can't stat the file, proceed and let the read handle the error
    if (args.verbose) {
      console.warn(`Warning: Could not check file size: ${(err as Error).message}`);
    }
  }

  // Suppress console output in JSON mode
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const log = args.json ? () => {} : console.log.bind(console);

  log(`Loading rustdoc JSON from: ${inputPath}`);

  let validationWarnings: string[] = [];
  let crate;

  try {
    const result = loadRustdocJsonWithWarnings(inputPath, args.verbose);
    crate = result.crate;
    validationWarnings = result.warnings;
  } catch (err) {
    if (args.json) {
      const output: JsonOutput = {
        success: false,
        error: isRustdocError(err)
          ? { code: err.code, message: err.message, hint: err.hint }
          : { code: "UNKNOWN", message: String(err) },
      };
      console.log(JSON.stringify(output, null, 2));
      process.exit(1);
    }
    throw err;
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

  // Calculate stats
  const stats = {
    totalFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.content.length, 0),
    mdxFiles: files.filter((f) => f.path.endsWith(".mdx")).length,
    metaFiles: files.filter((f) => f.path.endsWith(".json")).length,
  };

  if (args.json) {
    // JSON output mode
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
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  if (args.dryRun) {
    // Dry run mode - show what would be generated
    console.log("\n--- DRY RUN ---");
    console.log(`Would generate ${files.length} files to: ${args.output}\n`);

    // Group files by type
    const mdxFiles = files.filter((f) => f.path.endsWith(".mdx"));
    const metaFiles = files.filter((f) => f.path.endsWith(".json"));

    console.log(`MDX files (${mdxFiles.length}):`);
    for (const file of mdxFiles.slice(0, 20)) {
      console.log(`  ${file.path} (${file.content.length} bytes)`);
    }
    if (mdxFiles.length > 20) {
      console.log(`  ... and ${mdxFiles.length - 20} more`);
    }

    console.log(`\nmeta.json files (${metaFiles.length}):`);
    for (const file of metaFiles.slice(0, 10)) {
      console.log(`  ${file.path}`);
    }
    if (metaFiles.length > 10) {
      console.log(`  ... and ${metaFiles.length - 10} more`);
    }

    console.log(`\nTotal: ${stats.totalBytes.toLocaleString()} bytes`);

    if (validationWarnings.length > 0) {
      console.log(`\nWarnings (${validationWarnings.length}):`);
      for (const w of validationWarnings) {
        console.log(`  ⚠ ${w}`);
      }
    }

    console.log("\n--- END DRY RUN ---");
    process.exit(0);
  }

  log(`Generating ${files.length} files to: ${args.output}`);

  // Show progress for large crates
  const showProgress = files.length > 50 && !args.verbose;
  if (showProgress) {
    process.stdout.write(`Writing files... 0/${files.length}`);
  }

  let written = 0;
  let skippedEmpty = 0;

  for (const file of files) {
    // Skip empty content files (except meta.json which may be minimal)
    if (!file.content.trim() && !file.path.endsWith(".json")) {
      skippedEmpty++;
      if (args.verbose) {
        console.warn(`Skipping empty file: ${file.path}`);
      }
      continue;
    }

    // Validate path to prevent directory traversal attacks
    const fullPath = validateOutputPath(args.output, file.path);
    const dir = dirname(fullPath);

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, file.content);
    } catch (err) {
      throw outputWriteError(fullPath, err as Error);
    }

    written++;
    if (showProgress && written % 10 === 0) {
      process.stdout.write(`\rWriting files... ${written}/${files.length}`);
    }

    if (args.verbose) {
      console.log(`  -> ${fullPath}`);
    }
  }

  if (showProgress) {
    process.stdout.write(`\rWriting files... ${written}/${files.length}\n`);
  }

  if (skippedEmpty > 0) {
    log(`Skipped ${skippedEmpty} empty file(s)`);
  }

  log("Done!");
}

/**
 * Loads and validates rustdoc JSON, returning both crate and warnings.
 */
function loadRustdocJsonWithWarnings(
  path: string,
  verbose: boolean
): { crate: ReturnType<typeof validateRustdocJson>["crate"]; warnings: string[] } {
  // Read the file
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    throw inputReadError(path, err as Error);
  }

  // Parse JSON safely
  const data = parseJsonSafe(content, path);

  // Validate with Zod and check structure
  const { crate, warnings } = validateRustdocJson(data);

  // Display warnings if verbose
  if (verbose && warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }
  }

  return { crate, warnings };
}

try {
  main();
} catch (err) {
  console.error(formatError(err));
  process.exit(1);
}
