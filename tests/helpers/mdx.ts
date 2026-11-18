/**
 * Compile generated MDX the way a Fumadocs site does (MDX 3 + GFM), so tests
 * can prove pages parse instead of string-matching them.
 */

import { compile } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";

/** Compile one generated page; resolves to an error message or null. */
export async function compileError(content: string): Promise<string | null> {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
  try {
    await compile(body, { remarkPlugins: [remarkGfm] });
    return null;
  } catch (err) {
    const e = err as { reason?: string; message?: string; line?: number };
    return `${e.line ?? "?"}: ${e.reason ?? e.message ?? String(err)}`;
  }
}

/** Compile every `.mdx` in a generated file list; returns `path: error` lines. */
export async function compileAll(files: { path: string; content: string }[]): Promise<string[]> {
  const errors: string[] = [];
  for (const f of files) {
    if (!f.path.endsWith(".mdx")) continue;
    const err = await compileError(f.content);
    if (err) errors.push(`${f.path}:${err}`);
  }
  return errors;
}
