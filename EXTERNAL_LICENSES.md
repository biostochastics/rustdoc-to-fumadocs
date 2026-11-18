# External Dependencies and Licenses

This document acknowledges the third-party software used by rustdoc-to-fumadocs and their respective licenses.

## Runtime Dependencies

| Runtime package                                                                    | Purpose                               | License      |
| ---------------------------------------------------------------------------------- | ------------------------------------- | ------------ |
| [mdast-util-from-markdown](https://www.npmjs.com/package/mdast-util-from-markdown) | Parse CommonMark                      | MIT          |
| [mdast-util-to-markdown](https://www.npmjs.com/package/mdast-util-to-markdown)     | Serialize Markdown                    | MIT          |
| [mdast-util-gfm](https://www.npmjs.com/package/mdast-util-gfm)                     | GitHub Flavored Markdown syntax trees | MIT          |
| [micromark-extension-gfm](https://www.npmjs.com/package/micromark-extension-gfm)   | GitHub Flavored Markdown tokenization | MIT          |
| [parse5](https://www.npmjs.com/package/parse5)                                     | Parse HTML fragments                  | MIT          |
| [smol-toml](https://www.npmjs.com/package/smol-toml)                               | Read Cargo manifests                  | BSD-3-Clause |
| [yaml](https://www.npmjs.com/package/yaml)                                         | Serialize page frontmatter            | ISC          |
| [zod](https://www.npmjs.com/package/zod)                                           | Validate rustdoc data                 | MIT          |

The lockfile records the resolved versions. Installed packages include their license notices.

## Installed notices

The converter uses the dependencies listed above at runtime. The registry distributes each dependency with its own license. The development and compatibility suites also use TypeScript, ESLint, Vitest, MDX, Rust, Cargo, Next.js, and Fumadocs.

Use `npm ls --omit=dev` to list the installed runtime tree and `npm ls --all` to include development tools. Each installed package's manifest identifies its license and its package directory contains the applicable notices. The lockfile records direct and transitive dependency versions and license metadata where supplied by the registry.
