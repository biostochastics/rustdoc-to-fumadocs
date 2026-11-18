# Installation

The CLI requires Node.js 20.19+ on the 20.x line, or 22.12+. To use the version in a Git checkout, install the locked dependencies, build a distributable archive, and install that archive.

```sh
git clone https://github.com/biostochastics/rustdoc-to-fumadocs.git
cd rustdoc-to-fumadocs
npm ci
npm pack
npm install --global ./rustdoc-to-fumadocs-0.5.0.tgz
rustdoc-to-fumadocs --version
```

For development, use `npm run dev -- --help`. For a local build without a global installation, run `npm run build`, then invoke `node dist/cli.js --help`. To pin a project dependency, install the same archive into the documentation project and run the CLI with `npx --no-install rustdoc-to-fumadocs`.

## Generate input

From a Rust crate directory, run the following command and supply the resulting JSON to the converter.

```sh
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps
rustdoc-to-fumadocs --input target/doc/my_crate.json --output content/docs/api
```

A machine that receives the JSON from CI can perform the conversion without an installed Rust toolchain. For a workspace or a nondefault target directory, see the [CLI examples](README.md#cargo-workspaces). See the [compatibility matrix](README.md#compatibility) for tested Rust producers and Fumadocs consumers.
