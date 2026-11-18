/**
 * Cargo workspace discovery and multi-crate generation.
 *
 * Handles workspaces like biostochastics/rustyid where a root `Cargo.toml`
 * declares several member crates. Each member has its own rustdoc JSON in
 * `target/doc/<member_name>.json`, and the tool generates per-crate output
 * subdirectories plus a top-level `meta.json` linking them.
 */

import { readFile, access, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve, relative, matchesGlob } from "node:path";
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
  /** Rustdoc filename stem for a renamed library or binary target. */
  crateName?: string;
  /** Reachable landing page, or null when no pages were emitted. */
  landingUrl?: string | null;
  /**
   * False when the package cannot be published (`publish = false` or
   * `publish = []`, directly or through `publish.workspace = true`).
   * Workspace mode skips such members (xtask, test harnesses) by default.
   */
  publish?: boolean;
}

/**
 * Parsed workspace metadata.
 */
export interface Workspace {
  /** Absolute path to the root workspace directory (parent of the root Cargo.toml). */
  rootDir: string;
  /** Discovered members. Exclude patterns have already been applied. */
  members: WorkspaceMember[];
  targetDirectory?: string;
  skipped?: { name: string; reason: string }[];
}

function tomlStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

const cargoExec = promisify(execFile);

interface CargoPackage {
  id: string;
  name: string;
  manifest_path: string;
  publish: string[] | null;
  targets: { name: string; kind: string[]; doc: boolean }[];
}

/** Cargo resolves implicit path dependencies, inherited settings, targets and all workspace globs. */
export async function cargoWorkspace(manifest: string): Promise<Workspace | undefined> {
  try {
    const { stdout } = await cargoExec(
      "cargo",
      ["metadata", "--no-deps", "--offline", "--format-version", "1", "--manifest-path", manifest],
      { cwd: dirname(manifest), maxBuffer: 32 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout) as {
      workspace_root: string;
      target_directory: string;
      workspace_members: string[];
      packages: CargoPackage[];
    };
    const ids = new Set(data.workspace_members);
    const members = data.packages
      .filter((p) => ids.has(p.id))
      .map((p) => {
        const targets = p.targets.filter((t) => t.doc);
        const target =
          targets.find((t) =>
            t.kind.some((k) =>
              ["lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"].includes(k)
            )
          ) ??
          targets.find((t) => t.kind.includes("bin") && t.name === p.name) ??
          targets.find((t) => t.kind.includes("bin"));
        return {
          name: p.name,
          crateName: target?.name.replace(/-/g, "_"),
          path: dirname(p.manifest_path),
          publish: p.publish === null || p.publish.length > 0,
        };
      });
    return { rootDir: data.workspace_root, targetDirectory: data.target_directory, members };
  } catch {
    // Prebuilt JSON can be converted on hosts without a working Cargo installation.
    return undefined;
  }
}

/** Expand directory patterns when prebuilt JSON is shipped without Cargo. */
async function manifestDirectories(
  root: string,
  pattern: string,
  excludes: string[]
): Promise<string[]> {
  const parts = pattern.split("/");
  let directories = [root];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (!/[?*[]/.test(part)) {
      directories = directories.map((d) => resolve(d, part));
      continue;
    }
    const next = new Set<string>();
    const pending = [...directories];
    if (part === "**") pending.forEach((d) => next.add(d));
    for (const dir of pending) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !matchesGlob(entry.name, part)) continue;
        const path = join(dir, entry.name);
        if (excludes.some((e) => matchesGlob(relative(root, path), e))) continue;
        next.add(path);
        if (part === "**") pending.push(path);
      }
    }
    directories = [...next];
  }
  return directories
    .filter((dir) => !excludes.some((e) => matchesGlob(relative(root, dir), e)))
    .sort();
}

/** Whether a `publish` value allows publishing (`false` and `[]` do not). */
function publishable(value: unknown): boolean | undefined {
  if (value === false) return false;
  if (value === true) return true;
  if (Array.isArray(value)) return value.length > 0;
  return undefined;
}

interface ManifestTarget {
  name?: string;
  path?: string;
  doc?: boolean;
}

/** Prefer a documented library, then the package-named binary, then a declared binary. */
export async function manifestTargetName(
  manifest: {
    lib?: ManifestTarget;
    bin?: ManifestTarget[];
    package?: { autolib?: boolean; autobins?: boolean };
  },
  name: string,
  dir: string
): Promise<string | undefined> {
  const { lib } = manifest;
  if (lib && lib.doc !== false)
    return (typeof lib.name === "string" ? lib.name : name).replace(/-/g, "_");
  if (!Array.isArray(manifest.bin)) return undefined;
  const bins = manifest.bin.filter((b) => typeof b?.name === "string" && b.doc !== false);
  const exists = (file: string) =>
    access(join(dir, file)).then(
      () => true,
      () => false
    );
  if (!lib && manifest.package?.autolib !== false && (await exists("src/lib.rs")))
    return name.replace(/-/g, "_");
  const primary = bins.find((bin) => bin.name === name);
  if (primary) return name.replace(/-/g, "_");
  if (
    manifest.package?.autobins !== false &&
    !manifest.bin.some(
      (b) =>
        b?.name === name ||
        (typeof b?.path === "string" && resolve(dir, b.path) === join(dir, "src/main.rs"))
    ) &&
    (await exists("src/main.rs"))
  )
    return name.replace(/-/g, "_");
  return bins[0]?.name?.replace(/-/g, "_");
}

/**
 * Read a member's own `Cargo.toml` to recover its `package.name` and
 * whether it is publishable. Cargo requires the name to be unique within
 * the workspace, so it's the right key for output directory naming and
 * cross-crate lookups.
 */
async function readMember(
  memberDir: string,
  workspacePublish: boolean | undefined
): Promise<{ name: string; publish: boolean; crateName?: string } | null> {
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
  const pkgRec = pkg as Record<string, unknown>;
  const name = pkgRec.name;
  if (typeof name !== "string") return null;
  const raw = pkgRec.publish;
  const inherited =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && "workspace" in raw;
  const publish = (inherited ? workspacePublish : publishable(raw)) ?? true;
  return { name, publish, crateName: await manifestTargetName(parsed, name, memberDir) };
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
  const rootDir = dirname(resolve(workspaceTomlPath));
  const cargo = await cargoWorkspace(resolve(workspaceTomlPath));
  if (cargo) return cargo;

  const wkRec = wk as Record<string, unknown>;
  const memberPatterns = tomlStringArray(wkRec.members);
  const wsPackage = wkRec.package as { publish?: unknown } | undefined;
  const publish = publishable(wsPackage?.publish);
  const excludes = tomlStringArray(wkRec.exclude).map((p) => p.replace(/\/$/, ""));
  const expanded = new Set<string>();
  if (root.package) expanded.add(rootDir);
  const skipped: { name: string; reason: string }[] = [];
  for (const pattern of memberPatterns) {
    const paths = await manifestDirectories(rootDir, pattern, excludes);
    if (!paths.length && !/[?*[]/.test(pattern) && !excludes.includes(pattern)) {
      skipped.push({ name: pattern, reason: "workspace directory missing or excluded" });
    }
    for (const dir of paths.sort()) expanded.add(dir);
  }
  const members: WorkspaceMember[] = [];
  for (const dir of expanded) {
    const m = await readMember(dir, publish);
    if (m) members.push({ ...m, path: dir });
    else skipped.push({ name: dir, reason: "missing or invalid package manifest" });
  }
  return { rootDir, members, skipped };
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
 * collapsible folder in the sidebar (each crate keeps its own meta.json).
 */
export function renderWorkspaceMeta(members: WorkspaceMember[], title = "API"): string {
  return (
    JSON.stringify(
      {
        title,
        defaultOpen: true,
        pages: ["index", ...members.map((m) => m.name)],
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
 * Render the top-level workspace landing page. Links to the member crates
 * are absolute (`baseUrl` + crate directory). The frontmatter is written
 * by the `yaml` package, so workspace/crate names containing `"`, `:`,
 * newlines, or other YAML metacharacters can't break parsing.
 */
export function renderWorkspaceIndex(
  workspaceName: string,
  members: WorkspaceMember[],
  baseUrl = "/docs/api"
): string {
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
    `# ${workspaceName.replace(/[^\p{L}\p{N} _-]/gu, (c) => `&#${c.codePointAt(0)};`)}`,
    "",
    `This workspace contains **${members.length}** crate${members.length === 1 ? "" : "s"}:`,
    "",
  ];
  const base = baseUrl.replace(/\/+$/, "");
  for (const m of members) {
    const url = m.landingUrl === undefined ? `${base}/${encodeURIComponent(m.name)}` : m.landingUrl;
    lines.push(url ? `- [\`${escapeCode(m.name)}\`](${url})` : `- \`${escapeCode(m.name)}\``);
  }
  lines.push("");
  return lines.join("\n");
}
