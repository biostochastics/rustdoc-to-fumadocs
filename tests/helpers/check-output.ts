/**
 * Link checker for generated output: every internal link must point at a
 * generated page (and, with an anchor, at a heading on it), and no literal
 * intra-doc brackets (`` [`Foo`] ``) may remain in prose.
 *
 * Used by the tests, and runnable on a real output directory:
 *   npx tsx tests/helpers/check-output.ts <outDir> [baseUrl]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createProcessor } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import GithubSlugger from "github-slugger";
import type { Nodes } from "mdast";

export interface CheckResult {
  pages: number;
  links: number;
  broken: { file: string; url: string; reason: string }[];
  /** `` [`Foo`] `` left in prose (unresolved intra-doc links). */
  literalBrackets: { file: string; text: string }[];
  /** Links that are neither absolute paths, URLs nor anchors. */
  relative: { file: string; url: string }[];
}

const parser = createProcessor({ remarkPlugins: [remarkGfm] });

function visibleText(node: Nodes): string {
  if ("children" in node) return node.children.map(visibleText).join("");
  return "value" in node ? node.value : "";
}

/** Inspect rendered Markdown nodes, including children of Fumadocs JSX. */
function readPage(f: { path: string; content: string }, result: CheckResult) {
  const body = f.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const ids = new Set<string>();
  const urls: string[] = [];
  const references: string[] = [];
  const definitions = new Map<string, string>();
  const slugger = new GithubSlugger();
  function walk(node: Nodes): void {
    if (node.type === "heading") {
      const label = visibleText(node);
      const custom = node.children.at(-1);
      const explicit =
        custom?.type === "text" ? /\s*\[#([^\]]+)\]\s*$/.exec(custom.value)?.[1] : undefined;
      const id = explicit ?? slugger.slug(label);
      if (ids.has(id))
        result.broken.push({ file: f.path, url: `#${id}`, reason: "duplicate heading ID" });
      ids.add(id);
    }
    if (node.type === "link") urls.push(node.url);
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
    if (node.type === "linkReference") references.push(node.identifier);
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      for (const attr of node.attributes) {
        if (attr.type !== "mdxJsxAttribute" || !attr.value) continue;
        if (attr.name === "id" && typeof attr.value === "string") {
          if (ids.has(attr.value))
            result.broken.push({
              file: f.path,
              url: `#${attr.value}`,
              reason: "duplicate HTML ID",
            });
          ids.add(attr.value);
        }
        if (attr.name !== "href") continue;
        if (typeof attr.value === "string") urls.push(attr.value);
        else {
          const expr = attr.value.data?.estree?.body[0];
          if (
            expr?.type === "ExpressionStatement" &&
            expr.expression.type === "Literal" &&
            typeof expr.expression.value === "string"
          )
            urls.push(expr.expression.value);
        }
      }
    }
    if ("children" in node) {
      for (const [i, child] of node.children.entries()) {
        if (
          child.type === "inlineCode" &&
          node.children[i - 1]?.type === "text" &&
          node.children[i + 1]?.type === "text"
        ) {
          const start = child.position?.start.offset ?? 0;
          const end = child.position?.end.offset ?? 0;
          if (body[start - 1] === "[" && body[start - 2] !== "\\" && body[end] === "]") {
            result.literalBrackets.push({ file: f.path, text: body.slice(start - 1, end + 1) });
          }
        }
        walk(child);
      }
    }
  }
  try {
    walk(parser.parse(body));
  } catch (err) {
    result.broken.push({ file: f.path, url: "", reason: `invalid MDX: ${String(err)}` });
  }
  for (const ref of references) {
    const url = definitions.get(ref);
    if (url !== undefined) urls.push(url);
  }
  return { ids, urls };
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
  const result: CheckResult = { pages: 0, links: 0, broken: [], literalBrackets: [], relative: [] };
  const pages = new Map<string, Set<string>>();
  const links: { file: string; route: string; urls: string[] }[] = [];
  for (const f of files) {
    if (!f.path.endsWith(".mdx")) continue;
    const route = urlOf(f.path, baseUrl);
    if (pages.has(route))
      result.broken.push({ file: f.path, url: route, reason: "duplicate page route" });
    const { ids, urls } = readPage(f, result);
    pages.set(route, ids);
    links.push({ file: f.path, route, urls });
  }
  result.pages = pages.size;
  for (const { file, route, urls } of links) {
    for (const url of urls) {
      result.links++;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) continue;
      if (!url.startsWith("/") && !url.startsWith("#") && !url.startsWith("?"))
        result.relative.push({ file, url });
      try {
        const target = new URL(url, "https://docs.invalid" + route);
        const path = decodeURIComponent(target.pathname).replace(/\/+$/, "") || "/";
        const ids = pages.get(path);
        const anchor = decodeURIComponent(target.hash.slice(1));
        if (!ids) result.broken.push({ file, url, reason: "no such page" });
        else if (anchor && !ids.has(anchor))
          result.broken.push({ file, url, reason: `no #${anchor} on page` });
      } catch {
        result.broken.push({ file, url, reason: "invalid URL" });
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
  process.exitCode = r.broken.length || r.relative.length || r.literalBrackets.length ? 1 : 0;
}
