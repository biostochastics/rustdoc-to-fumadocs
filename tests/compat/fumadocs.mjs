// Copied into a disposable consumer project by test-fumadocs.sh.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import { remarkHeading } from "fumadocs-core/mdx-plugins";
import { loader } from "fumadocs-core/source";

const ui = JSON.parse(await readFile("node_modules/fumadocs-ui/package.json", "utf8")).version;
if (process.argv.includes("--check")) {
  const html = await readFile("out/docs/api/kitchen_sink/Widget.html", "utf8");
  assert.ok(html.includes('id="method.new"'), "missing method anchor in prerendered HTML");
  assert.ok(html.includes("Trait Implementations"), "missing trait tab");
  assert.ok(html.includes("Deprecated"), "missing deprecation callout");
  const guide = await readFile("out/docs/guides/first-request.html", "utf8");
  assert.ok(guide.includes('data-guide-tip="true"'), "missing custom guide component");
  assert.ok(
    guide.includes('href="/docs/api/kitchen_sink/Widget#method.new"'),
    "missing guide link to the generated method"
  );
  console.log("Verified prerendered Fumadocs", ui);
} else {
  const entries = await readdir("content", { recursive: true });
  const files = [];
  const imports = [];
  const pages = [];
  await mkdir("generated", { recursive: true });
  for (const rel of entries.sort()) {
    const path = rel.replaceAll("\\", "/");
    if (path.endsWith("/meta.json"))
      files.push({
        path,
        type: "meta",
        data: JSON.parse(await readFile(join("content", path), "utf8")),
      });
    if (!path.endsWith(".mdx")) continue;
    const mdx = await readFile(join("content", path), "utf8");
    // The generator emits quoted YAML titles. The build uses the generated title
    // and sidebar metadata, while compiling the body with the consumer's plugins.
    const title = /^title: (.*)$/m.exec(mdx)?.[1];
    assert.ok(title, path);
    files.push({ path, type: "page", data: { title: JSON.parse(title) } });
    const name = "Page" + pages.length;
    const compiled = await compile(mdx.replace(/^---\n[\s\S]*?\n---\n/, ""), {
      remarkPlugins: [remarkGfm, remarkHeading],
    });
    await writeFile(join("generated", name + ".js"), String(compiled));
    imports.push("import " + name + ' from "./' + name + '.js";');
    pages.push([path, name]);
  }
  const source = loader({ baseUrl: "/docs", source: { files } });
  assert.equal(source.getPages().length, pages.length);
  assert.ok(source.pageTree.children.length);
  const map = new Map(
    pages.map(([p, name]) => [p.replace(/\.mdx$/, "").replace(/\/index$/, ""), name])
  );
  const routes = source.getPages().map((page) => {
    const slug = page.slugs.join("/");
    assert.ok(map.has(slug), "unexpected consumer route " + slug);
    return JSON.stringify(slug) + ":" + map.get(slug);
  });
  await writeFile(
    "generated/routes.js",
    imports.join("\n") + "\nexport const routes={" + routes.join(",") + "};"
  );
  await mkdir("app/docs/[...slug]", { recursive: true });
  const provider =
    Number(ui.split(".")[0]) >= 16 ? "fumadocs-ui/provider/next" : "fumadocs-ui/provider";
  await writeFile(
    "app/layout.jsx",
    'import {RootProvider} from "' +
      provider +
      '";export default function Layout({children}){return <html lang="en"><body><RootProvider>{children}</RootProvider></body></html>}'
  );
  await writeFile(
    "app/docs/[...slug]/page.jsx",
    `import { routes } from "../../../generated/routes";
import { Callout } from "fumadocs-ui/components/callout";
import { Cards, Card } from "fumadocs-ui/components/card";
import { Tabs, Tab } from "fumadocs-ui/components/tabs";
export function generateStaticParams(){return Object.keys(routes).map(k=>({slug:k.split("/")}))}
export default async function Page({params}){const p=await params;const Body=routes[p.slug.join("/")];return <Body components={{Callout,Cards,Card,Tabs,Tab}}/>}`
  );
  await writeFile("next.config.mjs", 'export default {output:"export",experimental:{cpus:1}};');
  if (Number(ui.split(".")[0]) >= 16) {
    await writeFile(
      "source.config.ts",
      'import {defineDocs,defineConfig} from "fumadocs-mdx/config";export const docs=defineDocs({dir:"content"});export default defineConfig();'
    );
    await writeFile(
      "next.config.mjs",
      'import {createMDX} from "fumadocs-mdx/next";export default createMDX()({output:"export",experimental:{cpus:1}});'
    );
    await writeFile(
      "app/docs/[...slug]/page.jsx",
      `import {loader} from "fumadocs-core/source";
import {docs} from "../../../.source/server";
import components from "fumadocs-ui/mdx";
import {Tab,Tabs} from "fumadocs-ui/components/tabs";
const source=loader({baseUrl:"/docs",source:docs.toFumadocsSource()});
export function generateStaticParams(){return source.getPages().map(page=>({slug:page.slugs}))}
export default async function Page({params}){const page=source.getPage((await params).slug);const Body=page.data.body;return <Body components={{...components,Tab,Tabs}}/>}`
    );
  }
  console.log("Building", pages.length, "generated pages on Fumadocs", ui);
}
