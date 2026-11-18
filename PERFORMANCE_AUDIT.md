# Converter performance audit

November 17, 2026 · rustdoc-to-fumadocs 0.5.0 and 0.5.1

## Follow-up to 0.5.1

The comparison starts at 0.5.1 (`959b856`), which already includes the Markdown cache, suffix cursors and batched destination checks. Each cell shows median wall time in milliseconds, from that release to this change. Runs used Node 22.17.1 on an Apple M4 Pro with a warm APFS cache. Each command started a fresh process. Build and input order varied over five measured rounds after one warm-up. [Timing and peak RSS samples](benchmarks/post-0.5.1.json)

| Input                                  | JSON preview (ms) | Fresh publication (ms) | Unchanged publication (ms) |
| -------------------------------------- | ----------------: | ---------------------: | -------------------------: |
| `syn`                                  |         586 → 546 |              636 → 573 |                  599 → 561 |
| `serde_core`                           |         406 → 366 |              427 → 377 |                  418 → 372 |
| Six-crate workspace                    |       1,091 → 969 |          1,155 → 1,042 |                1,098 → 975 |
| 262,144 additional path summaries      |         409 → 368 |              416 → 366 |                  412 → 362 |
| 4,000 undocumented functions           |         231 → 225 |              878 → 493 |                  375 → 368 |
| 4,000 functions with one-sentence docs |         631 → 227 |            1,280 → 505 |                  781 → 381 |
| Minimal fixture                        |         119 → 115 |              122 → 118 |                  122 → 117 |

- **Rendering.** Single-line prose with a restricted alphabet and punctuation can pass through directly. For summaries, an opening paragraph whose lines start with prose and contain no reference brackets can be parsed on its own. Formatted summaries copy only the selected paragraph’s inline nodes. Potential references, GFM tables, headings and MDX-sensitive input still go through the appropriate Markdown transforms. To reproduce the documented 4,000-function workload, build the file-count input described in the reproduction section below and set each function’s docs to `Returns value number <id>.`
- **Validation.** The crate and item-ID schemas use Zod’s compiled parser. Legacy normalization and detailed error reporting still run through the same schemas. On the path-heavy fixture, isolated median validation time fell from 97 to 52 ms in four measured fresh processes per build after warm-up.
- **Publication.** A first publication with one missing crate directory verifies the staged tree, renames it into place, then installs the manifest. Existing directories and workspace roots use the per-file merge. With 4,002 files already rendered, median commit and cleanup fell from 468 to 51 ms in the isolated writer. The remaining fresh-publication cost is predominantly staging those individual files.

The correctness audit reproduced a lost page after a filename changed capitalization on a case-insensitive volume. The writer now removes stale spellings before installing replacements and checks ownership when another manifest spelling reaches the same file. A failed preparation blocks commit. Rollback removes directories created by the transaction while preserving independent additions.

Across 108 fixture and real-crate configurations, 2,480 ordered generated files and all warnings matched 0.5.1. The on-disk comparison covered 1,718 files across 21 CLI configurations and verified each file against its manifest. All 375 default-layout pages from the six real crates compiled and passed the internal-link checker.

## Release 0.5.1 results

Publishing `syn` to an empty directory took **647 ms**, down from **789 ms**. Rebuilding 4,002 unchanged files took **380 ms**, down from **931 ms**. The following medians compare the release with `b25483b` on the same Apple M4 Pro and local APFS volume. Each command ran in a fresh Node 22.17.1 process. We interleaved builds and workloads, discarded one warm-up round, and kept five observations per cell. [Release measurements](benchmarks/release-0.5.1.json)

| Input                                       | Fresh before (ms) | Fresh after (ms) | Unchanged before (ms) | Unchanged after (ms) |
| ------------------------------------------- | ----------------: | ---------------: | --------------------: | -------------------: |
| `syn`                                       |               789 |              647 |                   785 |                  601 |
| `serde_core`                                |               471 |              426 |                   465 |                  410 |
| 4,002 small files                           |             1,013 |              923 |                   931 |                  380 |
| Six real crates in one workspace            |             1,384 |            1,176 |                 1,378 |                1,102 |
| 32 `smallvec` workspace members             |             1,537 |            1,329 |                 1,542 |                1,265 |
| 22.93 MiB input dominated by external paths |               420 |              413 |                   416 |                  414 |

`--help` fell from **101 to 26 ms**. Indexing 2,048 colliding function names took **2.2 ms** in the release, compared with **201 ms** in the original audit. Fresh `syn` peak RSS fell from **286 to 230 MiB**. Caching small workspace members raised peak RSS on the 32-member unchanged run from **236 to 249 MiB**. The path-heavy workload saw little change.

The renderer retains up to 64 parsed Markdown trees per render, with a combined 256 KiB source budget and a 64 KiB per-document limit. A 4 MiB budget on raw workspace input sizes governs reuse between passes. On reruns the writer retains up to 4 MiB of estimated page content, spills additional content to disk, and checks up to 16 destinations at a time. These budgets measure input or page content. In a ten-render test with large docstrings and external links invalidated before each render, post-GC heap stayed between **14.0 and 14.9 MiB** and every render produced the same digest.

The release matched the baseline’s ordered file paths, contents, and warnings across 108 configurations and **2,480 file comparisons**. Published manifests matched in every timed workload. All 375 real-crate MDX pages compiled and passed internal-link checks. The consumer site built with Fumadocs 14.7.7, 15.8.5, and 16.19.4.

## Baseline and prototype measurements

The following sections document the original audit of 0.5.0. Its isolated experiments measured the contribution of individual changes before integration in 0.5.1.

## What a conversion costs

Each CLI cell is the median of five fresh Node processes on an Apple M4 Pro with 24 GiB RAM, macOS 26.6.2, APFS, and Node 22.17.1. One initial round warmed the filesystem cache. Preview is the real `--json` command. Fresh writes into an empty destination. Unchanged starts a new process against the preceding output. Time includes process startup and exit. RSS is the high-water mark of the fresh writer process.

| Input, default layout | Input MiB | Indexed items | Files | Preview ms | Fresh ms | Unchanged ms | Peak RSS MiB |
| --------------------- | --------: | ------------: | ----: | ---------: | -------: | -----------: | -----------: |
| itoa 1.0.18           |      0.11 |            61 |     4 |        147 |      154 |          154 |           90 |
| bitflags 2.11.1       |      0.27 |           260 |    23 |        206 |      212 |          213 |          113 |
| smallvec 1.15.2       |      0.39 |           402 |     9 |        199 |      204 |          202 |          113 |
| either 1.16.0         |      0.49 |           274 |     9 |        218 |      219 |          219 |          116 |
| serde_core 1.0.228    |      3.44 |         2,900 |    67 |        454 |      475 |          473 |          157 |
| syn 2.0.118           |      5.37 |         7,425 |   282 |        732 |      791 |          792 |          282 |

In a separate compiled-library driver, `syn` spent **21 ms** in JSON parsing, **84 ms** in schema validation, **512 ms** in `generate()`, and **68 ms** publishing fresh output. Input reading and hashing took 2 and 4 ms. On `serde_core` those four main stages took 14, 61, 271, and about 19 ms. The phase driver times imports separately and excludes CLI reporting. Medians from separate runs need not add up to the CLI median.

Layout changes mostly affected filesystem work on `syn`. Module, flat, and kind produced **282, 274, and 36 files**. Generation took **512, 509, and 503 ms**, while fresh publication took **68, 61, and 13 ms**. Kind grouping still renders the item bodies. For a long-lived library consumer, a warmed `syn` generator took **138 ms** on repeat calls versus **378 ms** with a fresh generator over the same already-validated crate. Those numbers exclude startup and validation and use the median of the last five interleaved calls per mode.

## 1. Reuse work in the Markdown pipeline

`fromMarkdown` accounted for **47%** of sampled time on a `syn --json` run and **37%** on `serde_core`. Markdown serialization accounted for another **8%** and **12%**. Garbage collection appeared separately at **12%** and **7%**. A separate call-count run found **1,838 full Markdown parses** on `syn`. The existing caches already reuse resolved docstrings and formatted summaries within a generator. The remaining repetition crosses different consumers of the same document. [Document transforms](src/docs.ts) · [Generator caches](src/generator.ts)

| Reason for parsing, module layout                    | syn calls | serde_core calls |
| ---------------------------------------------------- | --------: | ---------------: |
| Plain description for frontmatter, cards, or aliases |       649 |               64 |
| Rewrite documentation links                          |       199 |               64 |
| Sanitize the document for MDX                        |       530 |              262 |
| Demote headings                                      |       176 |              105 |
| Extract the formatted index summary                  |       284 |               58 |
| **Total**                                            | **1,838** |          **553** |

**Start with the plain description.** Each reference card computes its target’s `summaryLine` from the full raw docstring. Default frontmatter computes it again. A widely referenced type therefore incurs parsing cost on incoming references. The 649 calls on `syn` saw just 272 distinct source strings. The prototype used a `WeakMap` keyed by the item, stored the raw docs alongside the result, and reused it across all four raw-summary call sites. The raw-text key check preserves behavior if an item’s docs change. A further unmeasured improvement is to sort eligible card targets and select the six displayed entries before deriving their descriptions. Preserve stable ordering for equal titles. [Card construction](src/generator.ts) · [Default frontmatter](src/generator.ts) · [Plain summary](src/docs.ts)

| Prototype                     | syn generation ms | syn fresh CLI ms | serde_core generation ms | serde_core fresh CLI ms |
| ----------------------------- | ----------------: | ---------------: | -----------------------: | ----------------------: |
| Baseline in the comparison    |               508 |              790 |                      273 |                     472 |
| Cache plain item descriptions |               411 |              689 |                      269 |                     467 |
| Reuse parsed Markdown alone   |               398 |                — |                      237 |                       — |
| Both changes                  |               375 |              649 |                      235 |                     430 |

The combined prototype’s five fresh `syn` CLI runs ranged from **643 to 674 ms**, versus **786 to 798 ms** for baseline. Plain-description caching gave little benefit on the smaller crates. The combined prototype also left `either` generation essentially flat at **86 versus 85 ms**. These gains depend on document reuse.

**Prototype parsed-document reuse separately.** The experiment retained the 64 most recently parsed exact source strings and their original syntax trees. Link analysis, fence discovery, plain summaries, and section lookup borrowed those trees. Sanitization, heading demotion, and formatted summary generation received a `structuredClone` because they mutate nodes. This preserves reference definitions beyond the first paragraph, nested headings, GFM tables, doctests, and HTML processing. For a production design, scope retention to the conversion and add a byte budget or skip unusually large documents. The experiment capped entry count only. Keep resolved URLs scoped to the generator’s external-page map. [Markdown parser](src/docs.ts) · [Mutating transforms](src/docs.ts) · [External-page invalidation](src/generator.ts)

## 2. Reduce serial work when publishing many files

A synthetic module of ordinary public functions with unique names and no docstrings isolates file-count cost. At 4,000 items, the converter emitted **868,536 bytes** across **4,002 files**. Generating them took **80 ms**. In the phase driver, staging took **219 ms** and fresh commit took **545 ms**. On the unchanged pass, removing the unused staging tree alone took **114 ms**.

| Public functions | Output files | CLI preview ms | Fresh CLI ms | Unchanged CLI ms |
| ---------------: | -----------: | -------------: | -----------: | ---------------: |
|              250 |          252 |            136 |          189 |              183 |
|            1,000 |        1,002 |            165 |          367 |              354 |
|            4,000 |        4,002 |            236 |        1,024 |              974 |

The transaction writes every generated file before it compares the manifest and live file digests. On the unchanged 4,002-file run, instrumentation counted **4,003 staged writes**, **4,003 live file reads**, and **12,010 live `lstat` calls**. Only the manifest was replaced. The staged writes totaled **1,247,629 bytes** including the manifest. On `syn`, the unchanged counts were **283, 283, and 1,000**. These are Node filesystem API calls observed at the output directory. [Staging](src/output.ts) · [Destination inspection](src/output.ts) · [Commit](src/output.ts)

**Batch the read-only comparison under the existing lock.** The prototype checked up to 16 destinations concurrently with parent creation disabled, awaited every result, collected changes in original order, and kept installation and rollback sequential. On 4,002 unchanged files, median **commit** fell from **351 to 162 ms** and **whole publication** from **664 to 477 ms**. Fresh publication moved only from **751 to 746 ms**. On 1,002 unchanged files, whole publication fell from **168 to 118 ms**. Fresh and unchanged 4,002-file outputs matched the baseline manifest and on-disk digests. Focused checks also passed for edited stale pages, missing current pages, other owners, partial runs, conflicting destinations, and aliased directories.

Eliminating unchanged staging could save more, but needs a separate transaction design. A candidate must verify the live file under the lock and retain a way to repair it if it was edited or removed after preparation. A workspace must still finish preparing its members before installation and preserve recovery on a later failure. The cost of this redesign is easiest to justify on sites with thousands of files.

## 3. Keep workspace memory bounded and target validation where it matters

The current CLI performs two member passes. It keeps route strings, member metadata, and input digests between passes, then reloads and validates one member at a time for rendering. The earlier codebase audit described a previous release that retained every crate. Reintroducing that retention would trade away a measured benefit. [Workspace indexing](src/cli.ts) · [Second pass and digest check](src/cli.ts)

| Workspace                         | Files | Fresh CLI ms | Peak RSS MiB | Heap after indexing and GC, MiB |
| --------------------------------- | ----: | -----------: | -----------: | ------------------------------: |
| 1 renamed smallvec member         |    11 |          226 |          115 |                            14.3 |
| 8 renamed smallvec members        |    74 |          567 |          157 |                            14.6 |
| 32 renamed smallvec members       |   290 |        1,544 |          233 |                            14.9 |
| Six distinct real crates together |   396 |        1,400 |          311 |                            27.3 |

The six-crate workspace did **12 parses and 12 validations**. Across both passes, parsing took **74 ms**, validation **196 ms**, hashing **12 ms**, and first-pass `pageIndex()` **5 ms**. Rendering took **878 ms**. Post-index heap is a separate forced-GC observation. Peak RSS covers the full process and includes temporary allocations. In a single-`syn` diagnostic, live JS heap was **12 MiB** after imports, **45 MiB** while source text, parsed input, and validated output were all held, and **37 MiB** after releasing the source and original parsed object. The ordinary CLI’s **282 MiB** peak RSS measures something different.

**Input shape determines whether validation deserves priority.** Adding 262,144 valid external path summaries to `smallvec` left all nine output files byte-identical. At **22.93 MiB** of input, JSON parsing took **112 ms**, validation **92 ms**, and generation **69 ms**. With 32,768 added summaries the corresponding times were **13, 30, and 70 ms**. The larger case reached **284 MiB** peak RSS in the phase process. For installations with large dependency path tables, measure input parsing and shape validation independently of page count.

For those workloads, investigate a compact normalized representation or a byte-bounded reuse policy for small workspace members. Preserve the between-pass digest check, unit-variant normalization, legacy formats, error paths, and partial-workspace semantics. The validator already marks normalized crate objects in a `WeakSet`, so passing its result to a generator avoids an extra validation within a pass. An isolated change to enumerate a tagged variant’s keys once moved `syn` validation only from **85 to 82 ms** and `serde_core` from **63 to 62 ms**. That is a lower priority. [Input loader](src/cli.ts) · [Tagged schema](src/rustdoc-schema.ts) · [Validator](src/validation.ts)

## 4. Fix quadratic filename allocation for colliding identifiers

File allocation probes the bare name, then the kind suffix, then every numeric suffix starting over at the beginning. Rust identifiers can differ by case while generated filenames share the same case-folded namespace. In that family, allocating the next name repeats every earlier unsuccessful probe. The following isolates `pageIndex()` with validation complete, using the default module layout. [Filename allocation](src/generator.ts)

| Public functions | Unique names ms | Case variants of the same ASCII name ms | Case variants with suffix cursor ms |
| ---------------: | --------------: | --------------------------------------: | ----------------------------------: |
|              128 |             0.2 |                                     0.9 |                                 0.2 |
|              512 |             0.6 |                                    12.7 |                                 0.6 |
|            2,048 |             1.3 |                                   200.9 |                                 1.8 |

The prototype remembered the next suffix per directory’s occupied-name set, kind, and folded base for short ASCII names. It still tested each candidate for occupancy and reproduced every ordered route in the benchmark. Keep the existing allocation path for Unicode and byte-truncated names until equivalence is established for those cases. Kind-page slugs, scoped headings, and member anchors have similar restart loops. Their impact on the real corpus was unmeasured. Prioritize this fix for generated Rust APIs with naming collisions. [Kind anchors](src/generator.ts) · [Scoped headings](src/generator.ts) · [Member anchors](src/generator.ts)

## 5. Defer heavyweight imports for CLI metadata commands

A temporary build deferred the generator, validation, and workspace module imports until conversion starts. Fresh-process `--help` fell from **92 to 28 ms**, and `--version` from **92 to 28 ms**. Minimal JSON preview took **117 versus 116 ms**. The three commands produced identical stdout in both builds. This is a small, isolated improvement for metadata commands. A real conversion still needs those dependencies. [CLI imports](src/cli.ts) · [CLI dispatch](src/cli.ts)

## Verification and reproduction

- **Revision.** The audit began at `d22e5e6`. During measurement the workspace advanced to `b25483b`, which changed tuple-field visibility rendering. The scaling and diagnostic runs used an isolated build of the original revision. In an interleaved fresh-write check, the newer revision produced identical output manifests on `syn` and `serde_core`, with medians of 788 and 468 ms. The test suite passed all 488 tests at the baseline and all 490 at the newer revision.
- **Corpus and equivalence.** The six real inputs were generated with rustc 1.98.1, format 60. Their 375 default-layout MDX pages compiled and their internal links passed the repository checker. Four rendering or validation prototypes each matched the baseline’s ordered paths, file contents, and warnings across **108 configurations** and **2,472 baseline file comparisons per prototype**. This covered all twelve baseline fixtures plus the six crates, three layouts, and both the default flags and a combined indexes/cards/tabs-off setting.
- **Sampling.** CLI, phase, and prototype timing tables use five observations per cell after one initial round, with fresh processes unless otherwise specified. Workspace phase and post-index heap figures use three instrumented runs. Per-document counts, filesystem counts, single-crate forced-GC snapshots, and the two V8 CPU profiles are separate diagnostics. The profiles had 707 and 358 samples respectively. Publication excludes Rust compilation and downstream MDX compilation.
- **Scope.** Absolute timings describe one Node version and one host with a warm local filesystem. Cold storage, network filesystems, other Node versions, and inputs near the 100 MiB CLI ceiling were outside the measurement set. The large-document repeat-render measurement appears in the release results above.

The benchmark runner accepts a rustdoc JSON file or a workspace directory containing its prebuilt target. It runs preview, fresh publication, and unchanged publication in separate processes and checks published sizes against the preview. The measurements file contains the timed observations, phase breakdowns, diagnostic counts, output fingerprints, and input hashes. [Benchmark runner](scripts/benchmark-converter.py) · [Measurement data](benchmarks/performance-audit-2026-11-17.json)

The companion patch contains TypeScript versions of the three principal experiments. The generator hunk adds plain-description caching, the docs hunk adds parsed-tree reuse, and the output hunk batches read-only checks. The combined patch built and passed all 488 baseline tests in a disposable checkout. For a one-change comparison, select its file with `git apply --include=src/generator.ts` in a disposable checkout, rebuild, and point the runner’s `--cli` option at that build. [Experimental patch](benchmarks/performance-audit-prototypes.patch)

```sh
npm run build
python3 scripts/benchmark-converter.py tests/fixtures/kitchen_sink.v60.json
python3 scripts/benchmark-converter.py --group-by kind path/to/syn.json
python3 scripts/benchmark-converter.py path/to/workspace
node --cpu-prof --cpu-prof-dir="$TMPDIR" dist/cli.js --input path/to/syn.json --json
```

To reproduce the file-count workload, keep the root of `minimal.json`, replace its children with clones of `test_function`, assign consecutive numeric IDs starting at 1, name them `entry_0` onward, clear their docs, and add matching path summaries. For the workspace sweep, give each copy of `smallvec` a distinct root name and update the first segment of its local path summaries to match. Keep external summaries and member payloads intact. The collision sweep changes the capitalization of twelve ASCII letters according to the bits of the function index and compares the complete ordered route map.
