# Security

Report security issues privately to the maintainer by email. Include the affected version, platform, observed behavior, and impact. The maintainer aims to respond within 48 hours. The current maintenance line is 0.5.x.

## Input and output

The CLI limits each JSON input to 100 MiB. It validates known rustdoc payloads, reports unsupported formats, and renders source comments as Markdown data. For untrusted crates, isolate both the Rust documentation build and the consuming site build.

Use an output directory controlled by the build user. Descendant symlinks are rejected and publication uses staged files and a lock. The writer assumes other programs do not concurrently replace directories in that tree. The generated ownership manifest determines which obsolete pages may be cleaned up.

## Dependency status for 0.5.0

The November 17, 2026 npm audit reported zero advisories in the production dependency tree. The development tree still includes `picomatch` through test, lint, and release tools. The advisory covers the latest published release, 4.0.7. The converter uses Node's built-in glob matcher for Cargo workspace discovery. [Upstream advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
