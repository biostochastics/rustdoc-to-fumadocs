/**
 * Link checker for generated output: every internal link must point at a
 * generated page (and, with an anchor, at a heading on it), and no literal
 * intra-doc brackets (`` [`Foo`] ``) may remain in prose.
 *
 * Used by the tests, and runnable on a real output directory:
 *   npx tsx tests/helpers/check-output.ts <outDir> [baseUrl]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { splitFences } from "../../src/docs.js";

export interface CheckResult {
  pages: number;
  links: number;
  broken: { file: string; url: string; reason: string }[];
  /** `` [`Foo`] `` left in prose (unresolved intra-doc links). */
  literalBrackets: { file: string; text: string }[];
  /** Links that are neither absolute paths, URLs nor anchors. */
  relative: { file: string; url: string }[];
}

/** github-slugger's slug for a heading's visible text (close enough here). */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Heading ids of a page: custom `[#id]` suffixes and slugged heading text. */
function headingIds(content: string): Set<string> {
  const ids = new Set<string>();
  const prose = splitFences(content)
    .filter((_, i) => i % 2 === 0)
    .join("\n");
  for (const m of prose.matchAll(/^ {0,3}#{1,6}[ \t]+(.*)$/gm)) {
    const text = m[1];
    const custom = /\s*\[#([^\]]+)\]\s*$/.exec(text);
    if (custom) ids.add(custom[1]);
    else ids.add(slug(text.replace(/`/g, "")));
  }
  return ids;
}

/** URL path a generated file is served at. */
function urlOf(path: string, baseUrl: string): string {
  const noExt = path.replace(/\.mdx$/, "");
  const page = noExt.endsWith("/index") ? noExt.slice(0, -"/index".length) : noExt;
  const base = baseUrl.replace(/\/+$/, "");
  return page === "index" ? base || "/" : `${base}/${page}`;
}

export function checkOutput(
  files: { path: string; content: string }[],
  baseUrl = "/docs/api"
): CheckResult {
  const pages = new Map<string, Set<string>>();
  for (const f of files) {
    if (f.path.endsWith(".mdx")) pages.set(urlOf(f.path, baseUrl), headingIds(f.content));
  }
  const result: CheckResult = {
    pages: pages.size,
    links: 0,
    broken: [],
    literalBrackets: [],
    relative: [],
  };
  for (const f of files) {
    if (!f.path.endsWith(".mdx")) continue;
    const pageUrl = urlOf(f.path, baseUrl);
    const prose = splitFences(f.content.replace(/^---\n[\s\S]*?\n---\n/, ""))
      .filter((_, i) => i % 2 === 0)
      .join("\n");
    const proseNoCode = prose.replace(/(`+)[^`]*?\1/g, (m) =>
      m.startsWith("``") ? "" : m.includes("[") ? m.replace(/\[|\]/g, "") : m
    );
    const defined = new Set(
      [...prose.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*\S+[ \t]*$/gm)].map((m) => m[1])
    );
    for (const m of proseNoCode.matchAll(/\[(`[^`\]]+`)\](?![([])/g)) {
      if (!defined.has(m[1])) result.literalBrackets.push({ file: f.path, text: m[0] });
    }
    const urls = [
      ...[...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]),
      ...[...f.content.matchAll(/href=\{"([^"]+)"\}/g)].map((m) => m[1]),
    ];
    for (const url of urls) {
      result.links++;
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // https:, mailto:
      let target = url;
      if (url.startsWith("#")) target = pageUrl + url;
      else if (!url.startsWith("/")) {
        result.relative.push({ file: f.path, url });
        target = posix.normalize(posix.join(pageUrl, "..", url));
      }
      const [path, anchor] = target.split("#");
      const decoded = decodeURIComponent(path).replace(/\/+$/, "");
      const ids = pages.get(decoded);
      if (!ids) {
        result.broken.push({ file: f.path, url, reason: "no such page" });
      } else if (anchor && !ids.has(decodeURIComponent(anchor))) {
        result.broken.push({ file: f.path, url, reason: `no #${anchor} on page` });
      }
    }
  }
  return result;
}

/** Read every file under `dir` as `{ path, content }` (paths relative). */
export function readTree(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else
        out.push({
          path: relative(dir, p).split("\\").join("/"),
          content: readFileSync(p, "utf-8"),
        });
    }
  };
  walk(dir);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.argv[2];
  const base = process.argv[3] ?? "/docs/api";
  const r = checkOutput(readTree(dir), base);
  console.log(
    `pages: ${r.pages}  links: ${r.links}  broken: ${r.broken.length}  ` +
      `relative: ${r.relative.length}  literal [\`…\`]: ${r.literalBrackets.length}`
  );
  for (const b of r.broken.slice(0, 40)) console.log(`BROKEN ${b.file}: ${b.url} (${b.reason})`);
  for (const b of r.relative.slice(0, 20)) console.log(`RELATIVE ${b.file}: ${b.url}`);
  for (const b of r.literalBrackets.slice(0, 20)) console.log(`BRACKET ${b.file}: ${b.text}`);
  process.exitCode = r.broken.length > 0 ? 1 : 0;
}
