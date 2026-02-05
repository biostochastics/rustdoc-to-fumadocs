# Independent Repository Setup Plan

> **Goal**: Transform `rustdoc-to-fumadocs` into a standalone, production-grade TypeScript/Node.js package with modern tooling, CI/CD, and npm publishing capabilities.

**Created**: 2026-02-04
**Status**: Planning
**Estimated Effort**: 2-4 hours

---

## Table of Contents

1. [Pre-Migration Checklist](#1-pre-migration-checklist)
2. [Repository Initialization](#2-repository-initialization)
3. [ESLint v9 Flat Config](#3-eslint-v9-flat-config)
4. [Prettier Configuration](#4-prettier-configuration)
5. [Husky + lint-staged](#5-husky--lint-staged)
6. [Commitlint](#6-commitlint)
7. [Changesets for Versioning](#7-changesets-for-versioning)
8. [GitHub Actions CI/CD](#8-github-actions-cicd)
9. [Package.json Enhancements](#9-packagejson-enhancements)
10. [Documentation Files](#10-documentation-files)
11. [Optional Enhancements](#11-optional-enhancements)
12. [Post-Setup Verification](#12-post-setup-verification)

---

## 1. Pre-Migration Checklist

Before moving the project:

- [ ] Ensure all tests pass: `npm run test:run`
- [ ] Build successfully: `npm run build`
- [ ] Commit all changes in parent repo
- [ ] Note the current version: `0.2.0`
- [ ] Export any relevant git history (optional)

```bash
# From tools/rustdoc-to-fumadocs
npm run test:run
npm run build
```

---

## 2. Repository Initialization

### 2.1 Create New Repository

```bash
# Move to new location
mv rustdoc-to-fumadocs ~/projects/rustdoc-to-fumadocs
cd ~/projects/rustdoc-to-fumadocs

# Initialize fresh git repo (or keep history)
git init
git add .
git commit -m "chore: initial commit from resume-factory extraction"

# Create GitHub repo and push
gh repo create rustdoc-to-fumadocs --public --source=. --push
```

### 2.2 Update .gitignore

Replace current `.gitignore` with comprehensive version:

```gitignore
# Dependencies
node_modules/

# Build output
dist/
*.tsbuildinfo

# Test output
coverage/
test-output/
tests/fixtures/real-crates/

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# OS files
.DS_Store
Thumbs.db

# IDE
.idea/
.vscode/
*.swp
*.swo
*~

# Environment
.env
.env.local
.env.*.local

# Cache
.eslintcache
.prettiercache
*.cache

# Misc
*.tgz
.npmrc
```

---

## 3. ESLint v9 Flat Config

### 3.1 Install Dependencies

```bash
npm install -D eslint @eslint/js typescript-eslint eslint-config-prettier
```

### 3.2 Create `eslint.config.mjs`

```javascript
// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Global ignores
  {
    ignores: ["dist/", "node_modules/", "coverage/", "test-output/"],
  },

  // Base ESLint recommended
  eslint.configs.recommended,

  // TypeScript recommended with type checking
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // TypeScript parser options
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Project-specific rules
  {
    files: ["src/**/*.ts"],
    rules: {
      // Customize as needed
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },

  // Test files - relaxed rules
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Disable rules that conflict with Prettier
  eslintConfigPrettier
);
```

### 3.3 Create `tsconfig.eslint.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*", "eslint.config.mjs", "vitest.config.ts"]
}
```

### 3.4 Add Scripts to package.json

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix"
  }
}
```

---

## 4. Prettier Configuration

### 4.1 Install Dependencies

```bash
npm install -D prettier
```

### 4.2 Create `.prettierrc.json`

```json
{
  "semi": true,
  "singleQuote": false,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100,
  "bracketSpacing": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

### 4.3 Create `.prettierignore`

```
dist/
node_modules/
coverage/
test-output/
*.json
pnpm-lock.yaml
package-lock.json
```

### 4.4 Add Scripts to package.json

```json
{
  "scripts": {
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

---

## 5. Husky + lint-staged

### 5.1 Install Dependencies

```bash
npm install -D husky lint-staged
```

### 5.2 Initialize Husky

```bash
npx husky init
```

### 5.3 Create `.husky/pre-commit`

```bash
#!/usr/bin/env sh
npx lint-staged
```

### 5.4 Add lint-staged Config to package.json

```json
{
  "lint-staged": {
    "*.{ts,mjs,js}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml,yaml}": ["prettier --write"]
  }
}
```

---

## 6. Commitlint

### 6.1 Install Dependencies

```bash
npm install -D @commitlint/cli @commitlint/config-conventional
```

### 6.2 Create `commitlint.config.cjs`

```javascript
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat", // New feature
        "fix", // Bug fix
        "docs", // Documentation
        "style", // Formatting (no code change)
        "refactor", // Code refactoring
        "perf", // Performance improvement
        "test", // Adding tests
        "build", // Build system changes
        "ci", // CI config changes
        "chore", // Maintenance
        "revert", // Revert commit
      ],
    ],
    "subject-case": [2, "always", "lower-case"],
    "header-max-length": [2, "always", 100],
  },
};
```

### 6.3 Create `.husky/commit-msg`

```bash
#!/usr/bin/env sh
npx --no -- commitlint --edit $1
```

---

## 7. Changesets for Versioning

### 7.1 Install Dependencies

```bash
npm install -D @changesets/cli
```

### 7.2 Initialize Changesets

```bash
npx changeset init
```

### 7.3 Configure `.changeset/config.json`

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.2/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

### 7.4 Add Scripts to package.json

```json
{
  "scripts": {
    "changeset": "changeset",
    "version": "changeset version",
    "release": "npm run build && changeset publish"
  }
}
```

### 7.5 Workflow

```bash
# After making changes, create a changeset
npm run changeset
# Answer prompts: patch/minor/major, description

# When ready to release
npm run version    # Updates version and CHANGELOG
git add .
git commit -m "chore: version packages"
npm run release    # Publishes to npm
git push --follow-tags
```

---

## 8. GitHub Actions CI/CD

### 8.1 Create `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check

  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run typecheck

  test:
    name: Test (Node ${{ matrix.node }})
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run test:run
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v4
        if: matrix.node == 20
        with:
          files: coverage/lcov.info
          fail_ci_if_error: false

  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
```

### 8.2 Create `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          registry-url: "https://registry.npmjs.org"

      - run: npm ci
      - run: npm run build
      - run: npm run test:run

      - name: Create Release Pull Request or Publish
        id: changesets
        uses: changesets/action@v1
        with:
          publish: npm run release
          version: npm run version
          commit: "chore: release packages"
          title: "chore: release packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 8.3 Create `.github/PULL_REQUEST_TEMPLATE.md`

```markdown
## Description

<!-- Describe your changes -->

## Type of Change

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature causing existing functionality to break)
- [ ] Documentation update

## Checklist

- [ ] I have read the [CONTRIBUTING](CONTRIBUTING.md) guidelines
- [ ] My code follows the project's style guidelines
- [ ] I have added tests covering my changes
- [ ] All new and existing tests pass
- [ ] I have updated documentation as needed
- [ ] I have added a changeset (`npm run changeset`) if this is a user-facing change
```

### 8.4 Create `.github/ISSUE_TEMPLATE/bug_report.yml`

```yaml
name: Bug Report
description: Report a bug or unexpected behavior
labels: [bug]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for reporting a bug! Please fill out the sections below.

  - type: textarea
    id: description
    attributes:
      label: Bug Description
      description: Clear description of what happened
    validations:
      required: true

  - type: textarea
    id: reproduction
    attributes:
      label: Steps to Reproduce
      description: How can we reproduce this issue?
      placeholder: |
        1. Run `npx rustdoc-to-fumadocs --crate foo`
        2. See error...
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: Expected Behavior
      description: What did you expect to happen?
    validations:
      required: true

  - type: input
    id: version
    attributes:
      label: Version
      description: What version are you using?
      placeholder: "0.2.0"
    validations:
      required: true

  - type: input
    id: node
    attributes:
      label: Node.js Version
      placeholder: "20.11.0"
    validations:
      required: true

  - type: dropdown
    id: os
    attributes:
      label: Operating System
      options:
        - macOS
        - Linux
        - Windows
    validations:
      required: true
```

### 8.5 Create `.github/ISSUE_TEMPLATE/feature_request.yml`

```yaml
name: Feature Request
description: Suggest a new feature or improvement
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem Statement
      description: What problem does this feature solve?
    validations:
      required: true

  - type: textarea
    id: solution
    attributes:
      label: Proposed Solution
      description: How would you like this to work?
    validations:
      required: true

  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives Considered
      description: Any alternative solutions you've considered?

  - type: textarea
    id: context
    attributes:
      label: Additional Context
      description: Any other context, screenshots, or examples?
```

---

## 9. Package.json Enhancements

### 9.1 Complete package.json

```json
{
  "name": "rustdoc-to-fumadocs",
  "version": "0.2.0",
  "description": "Convert rustdoc JSON to Fumadocs-compatible MDX files",
  "keywords": [
    "rustdoc",
    "fumadocs",
    "mdx",
    "documentation",
    "rust",
    "typescript",
    "api-docs",
    "converter"
  ],
  "author": "Your Name <email@example.com>",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/YOUR_ORG/rustdoc-to-fumadocs.git"
  },
  "homepage": "https://github.com/YOUR_ORG/rustdoc-to-fumadocs#readme",
  "bugs": {
    "url": "https://github.com/YOUR_ORG/rustdoc-to-fumadocs/issues"
  },
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "rustdoc-to-fumadocs": "dist/cli.js"
  },
  "files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "generate": "tsx src/cli.ts",
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build",
    "changeset": "changeset",
    "version": "changeset version",
    "release": "npm run build && changeset publish"
  },
  "lint-staged": {
    "*.{ts,mjs,js}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml,yaml}": ["prettier --write"]
  },
  "dependencies": {
    "yaml": "^2.3.4",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@changesets/cli": "^2.27.0",
    "@commitlint/cli": "^19.0.0",
    "@commitlint/config-conventional": "^19.0.0",
    "@eslint/js": "^9.0.0",
    "@types/node": "^20.11.0",
    "@vitest/coverage-v8": "^4.0.18",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^9.0.0",
    "husky": "^9.0.0",
    "lint-staged": "^15.0.0",
    "prettier": "^3.2.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.0.18"
  }
}
```

---

## 10. Documentation Files

### 10.1 Create `LICENSE` (MIT)

```
MIT License

Copyright (c) 2024 Your Name

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 10.2 Create `CONTRIBUTING.md`

````markdown
# Contributing to rustdoc-to-fumadocs

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/YOUR_ORG/rustdoc-to-fumadocs.git
   cd rustdoc-to-fumadocs
   ```
````

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Run tests**

   ```bash
   npm run test:run
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

## Development Workflow

1. Create a new branch from `main`
2. Make your changes
3. Add tests for new functionality
4. Run the full test suite: `npm run test:run`
5. Run linting: `npm run lint`
6. Create a changeset: `npm run changeset`
7. Commit with conventional commit format
8. Open a pull request

## Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `perf:` - Performance improvements
- `test:` - Adding or updating tests
- `build:` - Build system changes
- `ci:` - CI configuration changes
- `chore:` - Maintenance tasks

**Examples:**

```
feat: add support for union types
fix: handle empty module documentation
docs: update CLI usage examples
```

## Code Style

- TypeScript with strict mode
- ESLint + Prettier for formatting
- Vitest for testing

## Testing

- Unit tests go in `tests/unit/`
- Integration tests go in `tests/integration/`
- Use fixtures from `tests/fixtures/`

Run tests:

```bash
npm run test           # Watch mode
npm run test:run       # Single run
npm run test:coverage  # With coverage
```

## Creating a Changeset

When making user-facing changes, create a changeset:

```bash
npm run changeset
```

Follow the prompts to describe your changes. This will create a markdown file in `.changeset/` that will be used to generate the changelog.

## Questions?

Open an issue or start a discussion on GitHub.

````

### 10.3 Create `SECURITY.md`

```markdown
# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, please:

1. **Do not** open a public issue
2. Email security concerns to: your-email@example.com
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and work with you to address the issue.

## Security Measures

This tool includes several security measures:

- **Input size limits**: Maximum 100MB input file
- **Path sanitization**: Prevents directory traversal attacks
- **Output validation**: Ensures output stays within designated directory
- **Recursion limits**: Prevents stack overflow attacks
````

### 10.4 Create `CODE_OF_CONDUCT.md`

```markdown
# Code of Conduct

## Our Pledge

We pledge to make participation in our community a harassment-free experience for everyone.

## Our Standards

**Positive behavior:**

- Using welcoming and inclusive language
- Being respectful of differing viewpoints
- Gracefully accepting constructive criticism
- Focusing on what is best for the community

**Unacceptable behavior:**

- Trolling, insulting comments, personal attacks
- Harassment of any kind
- Publishing others' private information
- Other conduct inappropriate in a professional setting

## Enforcement

Instances of unacceptable behavior may be reported to the project maintainers. All complaints will be reviewed and investigated.

## Attribution

This Code of Conduct is adapted from the [Contributor Covenant](https://www.contributor-covenant.org/).
```

### 10.5 Create `.editorconfig`

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false

[Makefile]
indent_style = tab
```

---

## 11. Optional Enhancements

### 11.1 TypeDoc for API Documentation

```bash
npm install -D typedoc
```

Create `typedoc.json`:

```json
{
  "$schema": "https://typedoc.org/schema.json",
  "entryPoints": ["src/index.ts"],
  "out": "docs/api",
  "plugin": ["typedoc-plugin-markdown"],
  "readme": "none",
  "excludePrivate": true,
  "excludeInternal": true
}
```

Add script:

```json
{
  "scripts": {
    "docs": "typedoc"
  }
}
```

### 11.2 Renovate for Dependency Updates

Create `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "labels": ["dependencies"],
  "packageRules": [
    {
      "matchUpdateTypes": ["minor", "patch"],
      "automerge": true
    }
  ]
}
```

### 11.3 Coverage Thresholds

Update `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
```

---

## 12. Post-Setup Verification

### 12.1 Verification Checklist

```bash
# 1. Install dependencies
npm install

# 2. Lint passes
npm run lint

# 3. Format check passes
npm run format:check

# 4. Type check passes
npm run typecheck

# 5. Tests pass
npm run test:run

# 6. Build succeeds
npm run build

# 7. Husky hooks work
git add .
git commit -m "test: verify hooks work"
# Should run lint-staged and commitlint

# 8. Changeset creation works
npm run changeset
```

### 12.2 GitHub Repository Setup

After pushing to GitHub:

1. **Enable branch protection** for `main`:
   - Require pull request reviews
   - Require status checks (lint, test, build)
   - Require branches to be up to date

2. **Add secrets** for npm publishing:
   - `NPM_TOKEN`: npm access token with publish permissions

3. **Enable GitHub Actions** in repository settings

4. **Configure Codecov** (optional):
   - Add `CODECOV_TOKEN` secret if needed

### 12.3 npm Publishing Setup

1. Create npm account if needed
2. Generate access token with publish permissions
3. Add as `NPM_TOKEN` secret in GitHub
4. First publish manually to claim package name:
   ```bash
   npm login
   npm publish --access public
   ```

---

## File Checklist Summary

```
rustdoc-to-fumadocs/
├── .changeset/
│   └── config.json
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── release.yml
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   └── feature_request.yml
│   └── PULL_REQUEST_TEMPLATE.md
├── .husky/
│   ├── pre-commit
│   └── commit-msg
├── src/                          # (existing)
├── tests/                        # (existing)
├── .editorconfig                 # NEW
├── .gitignore                    # UPDATED
├── .prettierrc.json              # NEW
├── .prettierignore               # NEW
├── CHANGELOG.md                  # (existing, will be auto-updated)
├── CLAUDE.md                     # (existing)
├── CODE_OF_CONDUCT.md            # NEW
├── commitlint.config.cjs         # NEW
├── CONTRIBUTING.md               # NEW
├── eslint.config.mjs             # NEW
├── LICENSE                       # NEW
├── package.json                  # UPDATED
├── README.md                     # (existing)
├── SECURITY.md                   # NEW
├── tsconfig.eslint.json          # NEW
├── tsconfig.json                 # (existing)
└── vitest.config.ts              # (existing, optional update)
```

**New files to create: 18**
**Files to update: 2** (package.json, .gitignore)

---

## Quick Start Commands

```bash
# Run all setup in sequence
npm install -D eslint @eslint/js typescript-eslint eslint-config-prettier prettier husky lint-staged @commitlint/cli @commitlint/config-conventional @changesets/cli

# Initialize husky
npx husky init

# Initialize changesets
npx changeset init

# Create first commit with all changes
git add .
git commit -m "chore: set up independent repository tooling"
```
