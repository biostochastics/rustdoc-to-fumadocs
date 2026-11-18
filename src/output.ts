import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
const IO_BATCH = 16;
const DEFERRED_BYTES = 4 * 1024 * 1024;
const PACK_BYTES = 512 * 1024;
type Files = Record<string, string>;
type Manifest = Record<string, Files>;

/** Settle every in-flight operation before cleanup or rollback can begin. */
async function inBatches<T>(items: Iterable<T>, run: (item: T) => Promise<void>) {
  let batch: Promise<void>[] = [];
  async function finish() {
    const failed = (await Promise.allSettled(batch)).find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    batch = [];
  }
  for (const item of items) {
    batch.push(run(item));
    if (batch.length === IO_BATCH) await finish();
  }
  if (batch.length) await finish();
}

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

async function fileDigest(path: string, bytes: number): Promise<string> {
  if (bytes <= 256 * 1024) return digest(await readFile(path));
  // Up to IO_BATCH verifications may be in flight. Stream large destinations.
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest("hex");
}

async function ownedFiles(path: string): Promise<Manifest> {
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
  private remainingBytes = DEFERRED_BYTES;
  private deferred: { paths: string[]; contents: string[] | string }[] = [];
  private constructor(
    private root: string,
    private stage: string,
    private deferWrites: boolean
  ) {}

  static async open(output: string): Promise<OutputTransaction> {
    try {
      await mkdir(output, { recursive: true });
      const root = await realpath(output);
      // This is only a preparation hint. Commit reads authoritative ownership under the lock.
      const deferWrites = Boolean((await existing(join(root, MANIFEST)))?.isFile());
      return new OutputTransaction(root, await mkdtemp(join(root, ".rustdoc-stage-")), deferWrites);
    } catch (err) {
      throw outputWriteError(output, err as Error);
    }
  }

  async add(files: GeneratedFile[]): Promise<void> {
    try {
      for (const { path, content } of files) {
        checkedPage(path);
        if (this.pages.has(path)) throw new Error(`Duplicate output path: ${path}`);
        this.pages.set(path, digest(content));
      }
      if (!this.deferWrites) {
        await inBatches(files, (file) => this.stageFile(file));
        return;
      }
      // Small reruns can be held until comparison. For larger workspaces, keep
      // recovery copies in bounded packs so unchanged pages need no individual files.
      for (let start = 0; start < files.length; ) {
        let end = start;
        let bytes = 0;
        while (end < files.length) {
          const weight = files[end].content.length * 2 + 128;
          if (end > start && bytes + weight > PACK_BYTES) break;
          bytes += weight;
          end++;
        }
        const batch = files.slice(start, end);
        start = end;
        const paths = batch.map((file) => file.path);
        const contents = batch.map((file) => file.content);
        if (bytes <= this.remainingBytes) {
          this.remainingBytes -= bytes;
          this.deferred.push({ paths, contents });
        } else if (bytes > PACK_BYTES) {
          // Keep the fallback for a single oversized page without serializing it twice.
          await this.stageFile(batch[0]);
        } else {
          const pack = join(this.stage, "pack-" + this.deferred.length);
          this.deferred.push({ paths, contents: pack });
          await writeFile(pack, JSON.stringify(contents), { flag: "wx" });
        }
      }
    } catch (err) {
      throw outputWriteError(this.root, err as Error);
    }
  }

  private async stageFile({ path, content }: GeneratedFile): Promise<void> {
    const dest = validateOutputPath(join(this.stage, "new"), path);
    const dir = dirname(dest);
    if (!this.dirs.has(dir)) this.dirs.set(dir, mkdir(dir, { recursive: true }));
    await this.dirs.get(dir);
    await writeFile(dest, content, { flag: "wx" });
  }

  private async stageChanges(changes: Map<string, boolean>) {
    for (const batch of this.deferred) {
      if (!batch.paths.some((path) => changes.has(path))) continue;
      const contents =
        typeof batch.contents === "string"
          ? (JSON.parse(await readFile(batch.contents, "utf8")) as string[])
          : batch.contents;
      await inBatches(batch.paths.entries(), async ([i, path]) => {
        if (changes.has(path)) await this.stageFile({ path, content: contents[i] });
      });
    }
    this.deferred = [];
  }

  private async destination(path: string, createParents = true) {
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
    return { dest, stat: st };
  }

  async commit(owner: string, prune = true) {
    const lock = join(this.root, ".rustdoc-to-fumadocs.lock");
    const applied: { dest: string; backup?: string; installed: boolean }[] = [];
    try {
      await mkdir(lock);
    } catch (err) {
      throw outputWriteError(lock, err as Error);
    }
    try {
      const manifestDest = await this.destination(MANIFEST);
      const manifest: Manifest = manifestDest.stat
        ? await ownedFiles(manifestDest.dest)
        : (Object.create(null) as Manifest);
      const old = manifest[owner] ?? {};
      const next = Object.fromEntries(this.pages);
      const otherPaths = new Set(
        Object.entries(manifest)
          .filter(([key]) => key !== owner)
          .flatMap(([, files]) => Object.keys(files))
      );
      // Build the map in publication order before the concurrent read-only checks.
      const changes = new Map<string, boolean>();
      let ownershipChanged =
        !Object.hasOwn(manifest, owner) || (prune && Object.keys(old).length !== this.pages.size);
      for (const [path, hash] of this.pages) {
        changes.set(path, true);
        if (hash !== old[path]) ownershipChanged = true;
      }
      if (prune)
        for (const path of Object.keys(old)) {
          if (!this.pages.has(path) && !otherPaths.has(path)) changes.set(path, false);
        }
      await inBatches(changes, async ([path, install]) => {
        const { dest, stat } = await this.destination(path, false);
        if (install && old[path] !== next[path]) return;
        const matches = !!stat && (await fileDigest(dest, stat.size)) === old[path];
        const needsChange = install ? !matches : matches;
        if (!needsChange) changes.delete(path);
      });
      await this.stageChanges(changes);
      let written = 0;
      for (const install of changes.values()) if (install) written++;
      const result = {
        written,
        unchanged: this.pages.size - written,
        removed: changes.size - written,
      };
      if (ownershipChanged) {
        manifest[owner] = prune ? next : { ...old, ...next };
        await mkdir(join(this.stage, "new"), { recursive: true });
        await writeFile(join(this.stage, "new", MANIFEST), JSON.stringify(manifest) + "\n");
        changes.set(MANIFEST, true);
      }
      for (const [path, install] of changes) {
        const { dest, stat } = await this.destination(path);
        let backup: string | undefined;
        if (stat) {
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
      return result;
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
