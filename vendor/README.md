# Scratchbox IDE — Option A: Workspace Vendoring

This directory provides the infrastructure for **Workspace Vendoring** of custom or local Eclipse Theia packages.

## Architecture

In Scratchbox IDE's monorepo setup:
1. The root `package.json` registers `vendor/*`, `vendor/packages/*`, and `vendor/packages/@theia/*` as first-class Yarn workspaces alongside `applications/*` and `extensions/*`.
2. Any `@theia/*` package placed in `vendor/packages/@theia/<package-name>` is linked directly by Yarn Workspaces into `node_modules/@theia/<package-name>`.
3. This allows local modifications, custom builds, or patched versions of Theia packages to be used immediately across all applications (`browser`, `electron`) and extensions (`product`, `launcher`, `updater`) without publishing to npm or managing global symlinks.

## Directory Structure

```
vendor/
├── README.md                  # This documentation
├── packages/                  # Workspace root for vendored packages
│   └── @theia/                # Scoped @theia packages
│       ├── core/              # e.g., @theia/core (if vendored)
│       ├── monaco/            # e.g., @theia/monaco (if vendored)
│       └── ...
```

## Automated Tooling & CLI Commands

Scratchbox IDE provides automated management tools in `scripts/vendor-theia.ts`:

### 1. Vendor / Import Local Theia Packages
Import built packages from a local Theia repository build:
```bash
# Copy mode (default: standalone copy into vendor/packages/@theia)
yarn vendor:theia --source /path/to/theia

# Symlink mode (live development link to external build directory)
yarn vendor:theia --source /path/to/theia --mode symlink

# Import specific packages only
yarn vendor:theia --source /path/to/theia --packages core,monaco,ai-core
```

### 2. Check Vendor Status
Check which packages are currently vendored locally vs resolved from npm:
```bash
yarn vendor:status
```

### 3. Verify Package Integrity
Verify that all vendored packages have valid manifests, built `lib/` artifacts, and workspace configuration:
```bash
yarn vendor:verify
```

### 4. Clean / Un-vendor
Safely remove all vendored packages to restore default npm resolution:
```bash
yarn vendor:clean
```

## How It Works with Yarn
When packages are present in `vendor/packages/@theia/*`:
1. Run `yarn install` (or `yarn`) at the root.
2. Yarn will detect workspace packages matching the names in `dependencies` (e.g. `@theia/core`) and create symlinks in `node_modules/@theia/core` pointing to `vendor/packages/@theia/core`.
3. Running `yarn build` or `yarn build:dev` will compile your application using the local vendored builds.
