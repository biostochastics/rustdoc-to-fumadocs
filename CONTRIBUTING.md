# Contributing to rustdoc-to-fumadocs

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/biostochastics/rustdoc-to-fumadocs.git
   cd rustdoc-to-fumadocs
   ```

2. **Install dependencies**

   ```bash
   npm ci
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

Pull requests targeting `main` and pushes to `main` run formatting, lint, typechecking, coverage, and installed-package checks on one Node 24 Ubicloud runner.

Pushing any tag runs the same checks on the tagged commit. After they pass, full CI tests the Node.js compatibility floors, Windows and macOS, Rust toolchains and third-party crates, and production builds of Fumadocs sites. To run the same suite before tagging, use `gh workflow run ci.yml --ref main` or select **Run workflow** in GitHub Actions.

## Creating a Changeset

When making user-facing changes, create a changeset:

```bash
npm run changeset
```

Use a patch for backward-compatible fixes. Use a minor version for new public functionality. During 0.x development, use a minor version for incompatible changes and describe the migration. After 1.0, incompatible changes require a major version.

Follow the prompts to describe your changes. This will create a markdown file in `.changeset/` that will be used to generate the changelog.

## Questions?

Open an issue or start a discussion on GitHub.
