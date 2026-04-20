/**
 * Cargo workspace discovery and multi-crate generation.
 *
 * Handles workspaces like biostochastics/rustyid where a root `Cargo.toml`
 * declares several member crates. Each member has its own rustdoc JSON in
 * `target/doc/<member_name>.json`, and the tool generates per-crate output
 * subdirectories plus a top-level `meta.json` linking them.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep, isAbsolute } from "node:path";
import { parse as parseToml } from "smol-toml";
import { stringify as stringifyYaml } from "yaml";
import { RustdocError, ErrorCode } from "./errors.js";

/**
 * One member of a Cargo workspace.
 */
export interface WorkspaceMember {
  /** Member name, as declared in the member's own Cargo.toml `package.name`. */
  name: string;
  /** Absolute path to the member's directory (which contains its Cargo.toml). */
  path: string;
}

/**
 * Parsed workspace metadata.
 */
export interface Workspace {
  /** Absolute path to the root workspace directory (parent of the root Cargo.toml). */
  rootDir: string;
  /** Discovered members. Exclude patterns have already been applied. */
  members: WorkspaceMember[];
}

function tomlStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Expand one `[workspace].members` pattern. Supports the literal form
 * ("crates/fluxid") and a single trailing `*` segment ("crates/*"), which
 * Cargo itself supports and covers effectively all real-world workspaces.
 * More elaborate glob forms (brace expansion, `**`) are uncommon in
 * workspace manifests and intentionally not supported here.
 */
async function expandMemberPattern(rootDir: string, pattern: string): Promise<string[]> {
  // Refuse absolute paths: they'd escape the workspace root, which is
  // never what Cargo itself allows. Treat as an unrecognized pattern.
  if (isAbsolute(pattern)) return [];
  if (!pattern.includes("*")) {
    return [resolve(rootDir, pattern)];
  }
  if (pattern.indexOf("*") !== pattern.lastIndexOf("*")) {
    // Multiple stars — skip rather than guess at semantics.
    return [];
  }
  // Split on the last path separator. The `*` must live in the final segment;
  // patterns like `*/foo` are not supported (Cargo doesn't permit them either
  // in practice). The parent directory is everything before the final "/";
  // within that directory we match entries whose name matches the prefix/
  // suffix around the star in the final segment.
  const lastSep = pattern.lastIndexOf("/");
  const lastSegment = lastSep === -1 ? pattern : pattern.slice(lastSep + 1);
  const parentRel = lastSep === -1 ? "." : pattern.slice(0, lastSep);
  if (lastSegment.includes("*") === false) return [];
  const starIdx = lastSegment.indexOf("*");
  const segPrefix = lastSegment.slice(0, starIdx);
  const segSuffix = lastSegment.slice(starIdx + 1);
  const parentDir = resolve(rootDir, parentRel);
  let entries: string[];
  try {
    entries = await readdir(parentDir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (segPrefix && !entry.startsWith(segPrefix)) continue;
    if (segSuffix && !entry.endsWith(segSuffix)) continue;
    matches.push(resolve(parentDir, entry));
  }
  return matches;
}

/**
 * Read a member's own `Cargo.toml` to recover its `package.name`. Cargo
 * requires this to be globally unique within the workspace, so it's the right
 * key to use for output directory naming and cross-crate lookups.
 */
async function readMemberName(memberDir: string): Promise<string | null> {
  const tomlPath = join(memberDir, "Cargo.toml");
  let content: string;
  try {
    content = await readFile(tomlPath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const pkg = (parsed as Record<string, unknown>).package;
  if (typeof pkg !== "object" || pkg === null) return null;
  const name = (pkg as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

/**
 * Load and parse a workspace Cargo.toml. Returns the workspace root directory
 * and the list of members (after expanding globs and applying excludes).
 *
 * Fails with a {@link RustdocError} if:
 *   - the Cargo.toml can't be read
 *   - the TOML is malformed
 *   - there is no `[workspace]` table
 *
 * Members whose own Cargo.toml is unreadable or missing are silently skipped
 * with a warning, since Cargo's own behavior on a broken workspace is to
 * error — but we prefer to do as much as we can rather than block all output.
 */
export async function loadWorkspace(workspaceTomlPath: string): Promise<Workspace> {
  let content: string;
  try {
    content = await readFile(workspaceTomlPath, "utf-8");
  } catch (err) {
    throw new RustdocError(
      ErrorCode.INPUT_READ_FAILED,
      `Failed to read workspace Cargo.toml: ${workspaceTomlPath}`,
      {
        hint: "Pass --workspace followed by a directory that contains a Cargo.toml with a [workspace] table.",
        context: { path: workspaceTomlPath, originalError: (err as Error).message },
      }
    );
  }

  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch (err) {
    throw new RustdocError(
      ErrorCode.INVALID_JSON,
      `Failed to parse workspace Cargo.toml: ${(err as Error).message}`,
      {
        hint: "Check that the TOML is syntactically valid.",
        context: { path: workspaceTomlPath },
      }
    );
  }

  const root = parsed as Record<string, unknown>;
  const wk = root.workspace;
  if (typeof wk !== "object" || wk === null) {
    throw new RustdocError(
      ErrorCode.INVALID_ITEM_STRUCTURE,
      `Cargo.toml at ${workspaceTomlPath} has no [workspace] table.`,
      {
        hint: "Pass --workspace only when pointing at a Cargo workspace root. For a single-crate package, omit --workspace and use --input or --crate instead.",
      }
    );
  }
  const wkRec = wk as Record<string, unknown>;
  const memberPatterns = tomlStringArray(wkRec.members);
  const excludePatterns = new Set(tomlStringArray(wkRec.exclude));

  const rootDir = resolve(workspaceTomlPath, "..");
  const rootPrefix = rootDir.endsWith(sep) ? rootDir : rootDir + sep;

  const expanded: string[] = [];
  for (const pattern of memberPatterns) {
    const dirs = await expandMemberPattern(rootDir, pattern);
    for (const dir of dirs) {
      // Cargo excludes take precedence over members. The exclude list is
      // interpreted as literal directories here (Cargo allows globs too but
      // they're rare in practice; we can extend if a user hits this).
      const rel = dir.startsWith(rootPrefix) ? dir.slice(rootPrefix.length) : dir;
      if (!excludePatterns.has(rel)) {
        expanded.push(dir);
      }
    }
  }

  const seen = new Set<string>();
  const members: WorkspaceMember[] = [];
  for (const memberDir of expanded) {
    if (seen.has(memberDir)) continue;
    seen.add(memberDir);
    const name = await readMemberName(memberDir);
    if (!name) continue;
    members.push({ name, path: memberDir });
  }

  return { rootDir, members };
}

/**
 * Given a workspace member name, find its rustdoc JSON file under a target
 * directory. Cargo replaces hyphens with underscores in output filenames, so
 * we probe both forms.
 */
export async function findMemberRustdocJson(
  crateName: string,
  targetDir: string
): Promise<string | null> {
  const { access } = await import("node:fs/promises");
  const probe = async (name: string): Promise<string | null> => {
    const p = join(targetDir, "doc", `${name}.json`);
    try {
      await access(p);
      return p;
    } catch {
      return null;
    }
  };
  return (await probe(crateName)) ?? (await probe(crateName.replace(/-/g, "_")));
}

/**
 * Render the top-level workspace `meta.json` that lists every member as a
 * collapsible section in the sidebar.
 */
export function renderWorkspaceMeta(members: WorkspaceMember[], title = "API"): string {
  return (
    JSON.stringify(
      {
        title,
        defaultOpen: true,
        pages: ["index", ...members.map((m) => `...${m.name}`)],
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Escape a member name for safe inclusion in a markdown inline-code span.
 * Rust crate names can't legally contain backticks, but we're defensive
 * against adversarial rustdoc JSON or manifest tampering.
 */
function escapeCode(name: string): string {
  return name.replace(/`/g, "\\`");
}

/**
 * Render the top-level workspace landing page. The frontmatter is written
 * by the `yaml` package, so workspace/crate names containing `"`, `:`,
 * newlines, or other YAML metacharacters can't break parsing.
 */
export function renderWorkspaceIndex(workspaceName: string, members: WorkspaceMember[]): string {
  const frontmatter = stringifyYaml(
    {
      title: workspaceName,
      description: `API reference for the ${workspaceName} workspace (${members.length} crate${members.length === 1 ? "" : "s"})`,
      icon: "Folder",
    },
    { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }
  );
  const lines: string[] = [
    "---",
    frontmatter.trimEnd(),
    "---",
    "",
    `# ${escapeCode(workspaceName)}`,
    "",
    `This workspace contains **${members.length}** crate${members.length === 1 ? "" : "s"}:`,
    "",
  ];
  for (const m of members) {
    lines.push(`- [\`${escapeCode(m.name)}\`](./${encodeURIComponent(m.name)})`);
  }
  lines.push("");
  return lines.join("\n");
}
