import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { GeneratedFile } from "./generator.js";
import { ErrorCode, RustdocError, outputWriteError } from "./errors.js";

const MANIFEST = ".rustdoc-to-fumadocs.manifest";
type Files = Record<string, string>;
type Manifest = Record<string, Files>;

export function validateOutputPath(outputDir: string, filePath: string): string {
  const base = resolve(outputDir);
  const absolute = resolve(base, filePath);
  if (absolute !== base && !absolute.startsWith(base.endsWith(sep) ? base : base + sep)) {
    throw new RustdocError(
      ErrorCode.OUTPUT_WRITE_FAILED,
      `Path traversal detected: "${filePath}" would write outside output directory`,
      { context: { outputDir: base, attemptedPath: absolute } }
    );
  }
  return absolute;
}

function checkedPage(path: string): string {
  if (
    path.split("/").some((s) => !s || s === "." || s === ".." || s.includes("\\")) ||
    !(path.endsWith(".mdx") || path.split("/").pop() === "meta.json")
  ) {
    throw new Error(`Invalid generated page path: ${path}`);
  }
  return path;
}

function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
}

const digest = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

async function ownedFiles(path: string): Promise<Manifest> {
  if (!(await existing(path))) return Object.create(null) as Manifest;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid output manifest");
  for (const files of Object.values(value as Record<string, unknown>)) {
    if (!files || typeof files !== "object" || Array.isArray(files))
      throw new Error("Invalid output manifest");
    for (const [page, hash] of Object.entries(files)) {
      checkedPage(page);
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
        throw new Error("Invalid output manifest digest");
    }
  }
  return value as Manifest;
}

/** Stage each member independently. Publish only after every page has been generated. */
export class OutputTransaction {
  private preserveBackup = false;
  private pages = new Map<string, string>();
  private dirs = new Map<string, Promise<unknown>>();
  private constructor(
    private root: string,
    private stage: string
  ) {}

  static async open(output: string): Promise<OutputTransaction> {
    try {
      await mkdir(output, { recursive: true });
      const root = await realpath(output);
      return new OutputTransaction(root, await mkdtemp(join(root, ".rustdoc-stage-")));
    } catch (err) {
      throw outputWriteError(output, err as Error);
    }
  }

  async add(files: GeneratedFile[]): Promise<void> {
    for (let i = 0; i < files.length; i += 16) {
      const writes = files.slice(i, i + 16).map(async ({ path, content }) => {
        checkedPage(path);
        if (this.pages.has(path)) throw new Error(`Duplicate output path: ${path}`);
        this.pages.set(path, digest(content));
        const dest = validateOutputPath(join(this.stage, "new"), path);
        const dir = dirname(dest);
        if (!this.dirs.has(dir)) this.dirs.set(dir, mkdir(dir, { recursive: true }));
        await this.dirs.get(dir);
        await writeFile(dest, content, { flag: "wx" });
      });
      const failed = (await Promise.allSettled(writes)).find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw outputWriteError(this.root, failed.reason as Error);
    }
  }

  private async destination(path: string, createParents = true): Promise<string> {
    let dir = this.root;
    const parts = path.split("/");
    for (const segment of parts.slice(0, -1)) {
      dir = join(dir, segment);
      const st = await existing(dir);
      if (st && !st.isDirectory()) throw new Error(`Output parent must be a directory: ${dir}`);
      if (!st && createParents) await mkdir(dir);
    }
    const dest = validateOutputPath(this.root, path);
    const st = await existing(dest);
    if (st && !st.isFile()) throw new Error(`Output destination must be a regular file: ${dest}`);
    return dest;
  }

  async commit(owner: string, prune = true): Promise<void> {
    const lock = join(this.root, ".rustdoc-to-fumadocs.lock");
    const applied: { dest: string; backup?: string; installed: boolean }[] = [];
    try {
      await mkdir(lock);
    } catch (err) {
      throw outputWriteError(lock, err as Error);
    }
    try {
      const manifestDest = await this.destination(MANIFEST);
      const manifest = await ownedFiles(manifestDest);
      const old = manifest[owner] ?? {};
      const next = Object.fromEntries(this.pages);
      const otherPaths = new Set(
        Object.entries(manifest)
          .filter(([key]) => key !== owner)
          .flatMap(([, files]) => Object.keys(files))
      );
      const changes = new Map<string, boolean>();
      for (const [path, hash] of this.pages) {
        const dest = await this.destination(path);
        if (old[path] === hash && (await existing(dest)) && digest(await readFile(dest)) === hash)
          continue;
        changes.set(path, true);
      }
      for (const [path, hash] of Object.entries(old)) {
        if (!prune || this.pages.has(path) || otherPaths.has(path)) continue;
        const dest = await this.destination(path, false);
        if ((await existing(dest)) && digest(await readFile(dest)) === hash)
          changes.set(path, false);
      }
      manifest[owner] = prune ? next : { ...old, ...next };
      await mkdir(join(this.stage, "new"), { recursive: true });
      await writeFile(join(this.stage, "new", MANIFEST), JSON.stringify(manifest) + "\n");
      changes.set(MANIFEST, true);
      for (const [path, install] of changes) {
        const dest = await this.destination(path);
        let backup: string | undefined;
        if (await existing(dest)) {
          backup = join(this.stage, "backup", path);
          await mkdir(dirname(backup), { recursive: true });
          await rename(dest, backup);
        }
        const change = { dest, backup, installed: false };
        applied.push(change);
        if (install) {
          await rename(join(this.stage, "new", path), dest);
          change.installed = true;
        }
      }
      // Empty former module directories would otherwise appear in folder discovery.
      for (const [path, install] of changes) {
        if (install) continue;
        let dir = dirname(join(this.root, path));
        while (relative(this.root, dir)) {
          try {
            await rmdir(dir);
          } catch {
            break;
          }
          dir = dirname(dir);
        }
      }
    } catch (err) {
      const failures: string[] = [];
      for (const step of applied.reverse()) {
        try {
          if (step.installed) await rm(step.dest);
          if (step.backup) await rename(step.backup, step.dest);
        } catch (recoveryError) {
          failures.push(String(recoveryError));
        }
      }
      if (failures.length) {
        this.preserveBackup = true;
        throw outputWriteError(
          this.root,
          new Error(
            `Publication failed and recovery needs attention. Backups remain at ${this.stage}. ${failures.join(", ")}`
          )
        );
      }
      throw outputWriteError(this.root, err as Error);
    } finally {
      await rmdir(lock);
    }
  }

  async close(): Promise<void> {
    if (!this.preserveBackup) await rm(this.stage, { recursive: true, force: true });
  }
}
