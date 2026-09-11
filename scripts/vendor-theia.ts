/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import yargs from 'yargs';

export interface TheiaPackageInfo {
    name: string;
    version: string;
    sourcePath: string;
    unscopedName: string;
    hasLib: boolean;
    hasPackageJson: boolean;
}

export interface VendorManagerOptions {
    repoRoot?: string;
    vendorTargetDir?: string;
}

export interface ImportOptions {
    sourceDir: string;
    packages?: string[];
    mode?: 'copy' | 'symlink';
}

export interface ImportResult {
    success: boolean;
    importedCount: number;
    importedPackages: string[];
    errors: string[];
}

export interface VendorStatus {
    isVendored: boolean;
    vendoredPackages: string[];
    usedTheiaPackages: string[];
    unvendoredPackages: string[];
}

export interface VerificationResult {
    valid: boolean;
    issues: string[];
    packagesChecked: number;
}

export class VendorTheiaManager {
    readonly repoRoot: string;
    readonly vendorTargetDir: string;

    constructor(options: VendorManagerOptions = {}) {
        this.repoRoot = options.repoRoot || path.resolve(__dirname, '..');
        this.vendorTargetDir = options.vendorTargetDir || path.join(this.repoRoot, 'vendor/packages/@theia');
    }

    /**
     * Discover all Theia packages inside a source directory (e.g. local theia build or packages folder).
     */
    async discoverPackages(sourceDir: string): Promise<TheiaPackageInfo[]> {
        const discovered: TheiaPackageInfo[] = [];
        if (!await fs.pathExists(sourceDir)) {
            return discovered;
        }

        const candidateDirs: string[] = [];
        const packagesSubdir = path.join(sourceDir, 'packages');

        if (await fs.pathExists(packagesSubdir)) {
            const entries = await fs.readdir(packagesSubdir);
            for (const entry of entries) {
                candidateDirs.push(path.join(packagesSubdir, entry));
            }
        } else {
            const entries = await fs.readdir(sourceDir);
            for (const entry of entries) {
                const fullPath = path.join(sourceDir, entry);
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory()) {
                    candidateDirs.push(fullPath);
                }
            }
        }

        for (const candidateDir of candidateDirs) {
            const pkgJsonPath = path.join(candidateDir, 'package.json');
            if (await fs.pathExists(pkgJsonPath)) {
                try {
                    const pkgJson = await fs.readJson(pkgJsonPath);
                    if (pkgJson && pkgJson.name) {
                        const unscoped = pkgJson.name.startsWith('@theia/')
                            ? pkgJson.name.replace('@theia/', '')
                            : path.basename(candidateDir);

                        discovered.push({
                            name: pkgJson.name,
                            version: pkgJson.version || '0.0.0',
                            sourcePath: candidateDir,
                            unscopedName: unscoped,
                            hasLib: await fs.pathExists(path.join(candidateDir, 'lib')),
                            hasPackageJson: true
                        });
                    }
                } catch (e) {
                    // Ignore invalid JSON in non-package folders
                }
            }
        }

        return discovered;
    }

    /**
     * Import packages from a local Theia build directory into the workspace vendor directory.
     */
    async importPackages(options: ImportOptions): Promise<ImportResult> {
        const mode = options.mode || 'copy';
        const result: ImportResult = {
            success: true,
            importedCount: 0,
            importedPackages: [],
            errors: []
        };

        await fs.ensureDir(this.vendorTargetDir);

        const discovered = await this.discoverPackages(options.sourceDir);
        if (discovered.length === 0) {
            result.errors.push(`No valid packages found in source directory: ${options.sourceDir}`);
            result.success = false;
            return result;
        }

        const allowedFilter = options.packages && options.packages.length > 0
            ? options.packages.map(p => p.startsWith('@theia/') ? p.replace('@theia/', '') : p)
            : null;

        for (const pkg of discovered) {
            if (allowedFilter && !allowedFilter.includes(pkg.unscopedName) && !allowedFilter.includes(pkg.name)) {
                continue;
            }

            const targetPkgDir = path.join(this.vendorTargetDir, pkg.unscopedName);

            try {
                // Clear any existing directory or symlink at target
                if (await fs.pathExists(targetPkgDir) || (await fs.lstat(targetPkgDir).catch(() => null))) {
                    await fs.remove(targetPkgDir);
                }

                if (mode === 'symlink') {
                    await fs.ensureSymlink(pkg.sourcePath, targetPkgDir, 'dir');
                } else {
                    // Copy while filtering out node_modules, .git, and build caches
                    await fs.copy(pkg.sourcePath, targetPkgDir, {
                        filter: (src: string) => {
                            const rel = path.relative(pkg.sourcePath, src);
                            if (rel.startsWith('node_modules') || rel.includes('/node_modules/')) {
                                return false;
                            }
                            if (rel.startsWith('.git') || rel.includes('/.git/')) {
                                return false;
                            }
                            if (rel.endsWith('.tsbuildinfo') || rel.endsWith('.DS_Store')) {
                                return false;
                            }
                            return true;
                        }
                    });
                }

                result.importedCount++;
                result.importedPackages.push(pkg.name);
            } catch (err: any) {
                result.errors.push(`Failed to vendor ${pkg.name}: ${err?.message || err}`);
                result.success = false;
            }
        }

        return result;
    }

    /**
     * Get the current status of vendored Theia packages vs dependencies in the monorepo.
     */
    async getStatus(): Promise<VendorStatus> {
        const vendoredPackages: string[] = [];

        if (await fs.pathExists(this.vendorTargetDir)) {
            const entries = await fs.readdir(this.vendorTargetDir);
            for (const entry of entries) {
                if (entry === '.gitkeep') {
                    continue;
                }
                const fullPath = path.join(this.vendorTargetDir, entry);
                const pkgJsonPath = path.join(fullPath, 'package.json');
                if (await fs.pathExists(pkgJsonPath)) {
                    try {
                        const pkgJson = await fs.readJson(pkgJsonPath);
                        vendoredPackages.push(pkgJson.name || `@theia/${entry}`);
                    } catch {
                        vendoredPackages.push(`@theia/${entry}`);
                    }
                }
            }
        }

        // Scan repo packages to see which @theia/* dependencies are used
        const usedTheiaPackages = new Set<string>();
        const manifestPaths = [
            path.join(this.repoRoot, 'package.json'),
            path.join(this.repoRoot, 'applications/electron/package.json'),
            path.join(this.repoRoot, 'applications/browser/package.json'),
            path.join(this.repoRoot, 'extensions/product/package.json'),
            path.join(this.repoRoot, 'extensions/launcher/package.json'),
            path.join(this.repoRoot, 'extensions/updater/package.json')
        ];

        for (const mPath of manifestPaths) {
            if (await fs.pathExists(mPath)) {
                try {
                    const manifest = await fs.readJson(mPath);
                    const allDeps = {
                        ...manifest.dependencies,
                        ...manifest.devDependencies
                    };
                    for (const depName of Object.keys(allDeps)) {
                        if (depName.startsWith('@theia/')) {
                            usedTheiaPackages.add(depName);
                        }
                    }
                } catch {
                    // Ignore read error
                }
            }
        }

        const usedList = Array.from(usedTheiaPackages).sort();
        const unvendored = usedList.filter(pkg => !vendoredPackages.includes(pkg));

        return {
            isVendored: vendoredPackages.length > 0,
            vendoredPackages: vendoredPackages.sort(),
            usedTheiaPackages: usedList,
            unvendoredPackages: unvendored
        };
    }

    /**
     * Verify the integrity of all vendored packages.
     */
    async verify(): Promise<VerificationResult> {
        const issues: string[] = [];
        let packagesChecked = 0;

        if (!await fs.pathExists(this.vendorTargetDir)) {
            return { valid: true, issues: [], packagesChecked: 0 };
        }

        const entries = await fs.readdir(this.vendorTargetDir);
        for (const entry of entries) {
            if (entry === '.gitkeep') {
                continue;
            }

            packagesChecked++;
            const pkgDir = path.join(this.vendorTargetDir, entry);
            const pkgJsonPath = path.join(pkgDir, 'package.json');

            if (!await fs.pathExists(pkgJsonPath)) {
                issues.push(`Package "${entry}" in vendor directory is missing package.json`);
                continue;
            }

            try {
                const pkgJson = await fs.readJson(pkgJsonPath);
                if (!pkgJson.name) {
                    issues.push(`Package "${entry}" has no name field in package.json`);
                }
                const libDir = path.join(pkgDir, 'lib');
                const srcDir = path.join(pkgDir, 'src');
                const hasLib = await fs.pathExists(libDir);
                const hasSrc = await fs.pathExists(srcDir);

                if (!hasLib && !hasSrc) {
                    issues.push(`Package "${entry}" (${pkgJson.name}) has neither lib/ nor src/ directory`);
                }
            } catch (err: any) {
                issues.push(`Failed to parse package.json for "${entry}": ${err?.message || err}`);
            }
        }

        return {
            valid: issues.length === 0,
            issues,
            packagesChecked
        };
    }

    /**
     * Clean and remove all vendored packages.
     */
    async clean(): Promise<{ success: boolean; removedPackages: string[] }> {
        const removed: string[] = [];

        if (!await fs.pathExists(this.vendorTargetDir)) {
            return { success: true, removedPackages: [] };
        }

        const entries = await fs.readdir(this.vendorTargetDir);
        for (const entry of entries) {
            if (entry === '.gitkeep') {
                continue;
            }
            const fullPath = path.join(this.vendorTargetDir, entry);
            await fs.remove(fullPath);
            removed.push(`@theia/${entry}`);
        }

        return {
            success: true,
            removedPackages: removed
        };
    }
}

// CLI Execution Support
if (require.main === module) {
    const argv = yargs(process.argv.slice(2))
        .option('source', {
            type: 'string',
            description: 'Path to local Eclipse Theia build root or packages directory'
        })
        .option('mode', {
            type: 'string',
            choices: ['copy', 'symlink'],
            default: 'copy',
            description: 'Import mode: copy files or create symlink'
        })
        .option('packages', {
            type: 'string',
            description: 'Comma-separated list of package names to vendor (e.g. core,monaco,ai-core)'
        })
        .option('status', {
            type: 'boolean',
            description: 'Show status of vendored vs remote packages'
        })
        .option('verify', {
            type: 'boolean',
            description: 'Verify integrity of vendored packages'
        })
        .option('clean', {
            type: 'boolean',
            description: 'Remove all vendored packages'
        })
        .help()
        .argv as any;

    const manager = new VendorTheiaManager();

    (async () => {
        if (argv.status) {
            console.log('🔍 Checking Eclipse Theia Vendor Status...\n');
            const status = await manager.getStatus();
            console.log(`Vendored Packages (${status.vendoredPackages.length}):`);
            if (status.vendoredPackages.length === 0) {
                console.log('  (none - all packages resolved via npm/yarn.lock)');
            } else {
                status.vendoredPackages.forEach(p => console.log(`  • ${p} [LOCAL VENDOR]`));
            }
            console.log(`\nUnvendored Theia Dependencies (${status.unvendoredPackages.length}):`);
            status.unvendoredPackages.forEach(p => console.log(`  • ${p} [NPM]`));
            return;
        }

        if (argv.verify) {
            console.log('🔍 Verifying Vendored Packages Integrity...\n');
            const result = await manager.verify();
            console.log(`Packages Checked: ${result.packagesChecked}`);
            if (result.valid) {
                console.log('✅ All vendored packages are valid and healthy!');
            } else {
                console.log('❌ Issues found:');
                result.issues.forEach(i => console.log(`  • ${i}`));
                process.exit(1);
            }
            return;
        }

        if (argv.clean) {
            console.log('🧹 Cleaning vendored packages...\n');
            const result = await manager.clean();
            console.log(`Removed ${result.removedPackages.length} vendored packages.`);
            result.removedPackages.forEach(p => console.log(`  ✓ Removed ${p}`));
            console.log('\n✅ Workspace reset to standard npm resolution.');
            return;
        }

        if (argv.source) {
            console.log(`📦 Vendoring Theia packages from: ${argv.source} (mode: ${argv.mode})...\n`);
            const pkgList = argv.packages ? argv.packages.split(',').map((s: string) => s.trim()) : undefined;
            const result = await manager.importPackages({
                sourceDir: path.resolve(argv.source),
                mode: argv.mode as 'copy' | 'symlink',
                packages: pkgList
            });

            if (result.success) {
                console.log(`✅ Successfully vendored ${result.importedCount} packages into vendor/packages/@theia/:\n`);
                result.importedPackages.forEach(p => console.log(`  • ${p}`));
                console.log('\nNext step: Run `yarn` at root to update workspace symlinks in node_modules.');
            } else {
                console.log('❌ Vendoring failed with errors:');
                result.errors.forEach(e => console.log(`  • ${e}`));
                process.exit(1);
            }
            return;
        }

        console.log('Please specify an action. Run with --help for options:');
        console.log('  yarn vendor:theia --source <path-to-theia>');
        console.log('  yarn vendor:status');
        console.log('  yarn vendor:verify');
        console.log('  yarn vendor:clean');
    })().catch(err => {
        console.error('Error running vendor tool:', err);
        process.exit(1);
    });
}
