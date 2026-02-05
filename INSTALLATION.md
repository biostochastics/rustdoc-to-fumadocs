# Installation Guide

This guide covers all methods for installing and setting up `rustdoc-to-fumadocs`.

## Prerequisites

### Node.js Requirements

- **Node.js**: Version 18.0 or higher
- **Package Manager**: npm, yarn, or pnpm
- **TypeScript Support**: The tool is written in TypeScript and requires compilation before use

Verify your Node.js version:

```bash
node --version
```

### Rust Toolchain Requirements

To generate rustdoc JSON output, you need:

- **Rust**: Version 1.76 or higher (for rustdoc JSON format v35)
- **Cargo**: Included with Rust installation
- **Nightly Rust** (recommended) or `RUSTC_BOOTSTRAP=1`

Verify your Rust version:

```bash
rustc --version
cargo --version
```

## Installation Methods

### Method 1: Local Development (Recommended)

Clone and install from source for development:

```bash
# Clone the repository
git clone https://github.com/biostochastics/rustdoc-to-fumadocs.git
cd rustdoc-to-fumadocs

# Navigate to the tool directory (if part of monorepo)
cd tools/rustdoc-to-fumadocs

# Install dependencies
npm install

# Build the TypeScript code
npm run build

# Verify installation
npm run typecheck
```

### Method 2: Global npm Installation

Install the published package globally:

```bash
# Install globally
npm install -g rustdoc-to-fumadocs

# Verify installation
rustdoc-to-fumadocs --help
```

### Method 3: Direct CLI Usage (No Build)

Use `tsx` or `npx` to run directly without building:

```bash
# Using npx (Node Package Executor)
npx rustdoc-to-fumadocs --help

# Using tsx for development
npx tsx src/cli.ts --help
```

### Method 4: Docker (Optional)

Create a Dockerfile for containerized usage:

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

ENTRYPOINT ["node", "dist/cli.js"]
```

Build and run:

```bash
docker build -t rustdoc-to-fumadocs .
docker run --rm rustdoc-to-fumadocs --help
```

## Verification Steps

After installation, verify everything works correctly:

### 1. Check CLI Availability

```bash
# If installed globally
rustdoc-to-fumadocs --version

# If using npm scripts
npm run dev -- --version
```

### 2. Validate TypeScript Compilation

```bash
npm run typecheck
```

### 3. Run Test Suite

```bash
npm run test:run
```

Expected output: All 222 tests should pass.

## Initial Setup for a New Rust Project

### Step 1: Generate Rustdoc JSON

Navigate to your Rust project directory:

```bash
cd /path/to/your-rust-project

# Generate rustdoc JSON (requires nightly or RUSTC_BOOTSTRAP)
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo +nightly doc --no-deps

# Verify the JSON file was created
ls -la target/doc/*.json
```

### Step 2: Configure rustdoc-to-fumadocs

Create a configuration file (optional) or use CLI arguments:

```bash
# Basic conversion
rustdoc-to-fumadocs --crate my_crate --output content/docs/api

# With all options
rustdoc-to-fumadocs \
  --crate my_crate \
  --output content/docs/api \
  --group-by module \
  --no-tabs \
  --no-cards
```

### Step 3: Integrate with FumaDocs

Update your FumaDocs configuration:

```typescript
// mdx-components.tsx
import { Callout } from "fumadocs-ui/components/callout";
import { Tabs, Tab } from "fumadocs-ui/components/tabs";
import { Cards, Card } from "fumadocs-ui/components/card";

export function getMDXComponents(components) {
  return {
    ...components,
    Callout,
    Tabs,
    Tab,
    Cards,
    Card,
  };
}
```

```typescript
// source.config.ts
import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const apiDocs = defineDocs({
  dir: "content/docs/api",
});

export default defineConfig();
```

## Common Installation Issues

### Issue: "command not found" after npm install

**Solution**: Ensure npm global bin is in your PATH

```bash
# Add to ~/.zshrc or ~/.bashrc
export PATH="$(npm config get prefix)/bin:$PATH"

# Reload shell
source ~/.zshrc  # or source ~/.bashrc
```

### Issue: Node.js version too old

**Solution**: Use nvm to manage Node.js versions

```bash
# Install nvm (if not already installed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Install and use Node.js 20
nvm install 20
nvm use 20
```

### Issue: RUSTC_BOOTSTRAP not working

**Solution**: Use nightly Rust instead

```bash
rustup install nightly
rustup default nightly

# Generate docs
RUSTDOCFLAGS="-Z unstable-options --output-format json" cargo doc --no-deps
```

### Issue: Permission denied errors

**Solution**: Use a Node version manager or npm with a custom prefix

```bash
# Configure npm to use a user-writable directory
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
```

## Updating

### Update from npm

```bash
# Check current version
npm list rustdoc-to-fumadocs

# Update to latest
npm update rustdoc-to-fumadocs

# Or reinstall
npm install -g rustdoc-to-fumadocs@latest
```

### Update from source

```bash
git pull origin main
npm install
npm run build
```

## Uninstalling

### npm global uninstall

```bash
npm uninstall -g rustdoc-to-fumadocs
```

### Remove local installation

```bash
# Remove cloned repository
rm -rf /path/to/rustdoc-to-fumadocs

# Remove generated documentation
rm -rf content/docs/api
```
