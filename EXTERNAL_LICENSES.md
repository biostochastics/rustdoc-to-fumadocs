# External Dependencies and Licenses

This document acknowledges the third-party software used by rustdoc-to-fumadocs and their respective licenses.

## Runtime Dependencies

### yaml

- **Description**: JavaScript parser and stringifier for YAML
- **License**: MIT
- **Repository**: https://github.com/eemeli/yaml
- **Version**: ^2.3.4

```text
Copyright Eemeli Aro <eemeli@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### zod

- **Description**: TypeScript-first schema validation with static type inference
- **License**: MIT
- **Repository**: https://github.com/colinhacks/zod
- **Version**: ^3.25.76

```text
MIT License

Copyright (c) 2020 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Development Dependencies

### typescript

- **Description**: TypeScript is a superset of JavaScript that compiles to clean JavaScript output
- **License**: Apache-2.0
- **Repository**: https://github.com/Microsoft/TypeScript
- **Version**: ^5.3.3

### vitest

- **Description**: Blazing fast Unit Test Framework powered by V8
- **License**: MIT
- **Repository**: https://github.com/vitest-dev/vitest
- **Version**: ^4.0.18

### eslint

- **Description**: Find and fix problems in your JavaScript code
- **License**: MIT
- **Repository**: https://github.com/eslint/eslint
- **Version**: ^9.39.2

### prettier

- **Description**: Prettier is an opinionated code formatter
- **License**: MIT
- **Repository**: https://github.com/prettier/prettier
- **Version**: ^3.8.1

### tsx

- **Description**: Node.js enhanced with esbuild to run TypeScript
- **License**: MIT
- **Repository**: https://github.com/privatenumber/tsx
- **Version**: ^4.7.0

### @types/node

- **Description**: TypeScript definitions for Node.js
- **License**: MIT
- **Repository**: https://github.com/DefinitelyTyped/DefinitelyTyped
- **Version**: ^20.11.0

### @vitest/coverage-v8

- **Description**: V8 coverage provider for Vitest
- **License**: MIT
- **Repository**: https://github.com/vitest-dev/vitest
- **Version**: ^4.0.18

### eslint-config-prettier

- **Description**: Turns off all rules that are unnecessary or might conflict with Prettier
- **License**: MIT
- **Repository**: https://github.com/prettier/eslint-config-prettier
- **Version**: ^10.1.8

### typescript-eslint

- **Description**: ESLint plugin and config for TypeScript
- **License**: Apache-2.0
- **Repository**: https://github.com/typescript-eslint/typescript-eslint
- **Version**: ^8.54.0

### @changesets/cli

- **Description**: A tool to manage versioning and changelogs with a +changeset based workflow
- **License**: MIT
- **Repository**: https://github.com/changesets/changesets
- **Version**: ^2.29.8

### @commitlint/cli

- **Description**: Lint commit messages
- **License**: MIT
- **Repository**: https://github.com/conventional-changelog/commitlint
- **Version**: ^20.4.1

### @commitlint/config-conventional

- **Description**: Shareable commitlint config enforcing conventional commits
- **License**: MIT
- **Repository**: https://github.com/conventional-changelog/commitlint
- **Version**: ^20.4.1

### husky

- **Description**: Git hooks made easy
- **License**: MIT
- **Repository**: https://github.com/typicode/husky
- **Version**: ^9.1.7

### lint-staged

- **Description**: Run linters on git staged files
- **License**: MIT
- **Repository**: https://github.com/lint-staged/lint-staged
- **Version**: ^16.2.7

## Build Tools

### @eslint/js

- **Description**: JavaScript language implementation for ESLint
- **License**: MIT
- **Repository**: https://github.com/eslint/eslint
- **Version**: ^9.39.2

## License Summary

| Category   | Licenses Used                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT        | yaml, zod, vitest, eslint, prettier, tsx, @types/node, @vitest/coverage-v8, eslint-config-prettier, @changesets/cli, @commitlint/cli, @commitlint/config-conventional, husky, lint-staged |
| Apache-2.0 | typescript, typescript-eslint, @eslint/js                                                                                                                                                 |

## License Compliance

All dependencies used by rustdoc-to-fumadocs are open-source software with permissive licenses (MIT and Apache-2.0). These licenses allow free use, modification, and distribution, subject to the terms of each respective license.

## Additional Runtime Dependencies (Transitive)

The following packages are transitive dependencies of the main dependencies:

- **buffer** - MIT License
- **events** - MIT License
- **path** - MIT License
- **process** - MIT License
- **stream** - MIT License
- **string_decoder** - MIT License
- **util** - MIT License

These are Node.js built-in module equivalents and follow Node.js licensing.

## Rust Toolchain Acknowledgment

rustdoc-to-fumadocs is designed to work with the Rust ecosystem. The generated documentation is derived from rustdoc, which is part of the Rust project:

- **Rust Programming Language**: MIT OR Apache-2.0
- **Cargo**: MIT OR Apache-2.0
- **rustdoc**: MIT OR Apache-2.0

See https://www.rust-lang.org/licenses for details.

## Contact

For questions about third-party licenses, please open an issue at:

https://github.com/biostochastics/rustdoc-to-fumadocs/issues

## Updates to Dependencies

This document is updated with each release. To view the current dependencies:

```bash
# View runtime dependencies
npm list --depth=0

# View all dependencies including dev
cat package.json
```

For any license concerns or questions, please contact the maintainers through the GitHub issue tracker.
