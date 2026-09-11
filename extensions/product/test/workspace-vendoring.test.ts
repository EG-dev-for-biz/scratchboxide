/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

async function runWorkspaceVendoringTests() {
    console.log('🧪 Running Workspace Vendoring & Automated Theia Tooling Test Suite...\n');

    const repoRoot = path.resolve(__dirname, '../../..');
    const rootPackageJsonPath = path.join(repoRoot, 'package.json');
    const vendorDir = path.join(repoRoot, 'vendor');
    const vendorReadmePath = path.join(vendorDir, 'README.md');
    const vendorScriptPath = path.join(repoRoot, 'scripts/vendor-theia.ts');

    // -------------------------------------------------------------
    // Test 1: Root package.json workspaces must include vendor paths
    // -------------------------------------------------------------
    assert.ok(fs.existsSync(rootPackageJsonPath), 'Root package.json must exist');
    const rootPkg = await fs.readJson(rootPackageJsonPath);
    assert.ok(Array.isArray(rootPkg.workspaces), 'Root package.json must have workspaces array');
    assert.ok(
        rootPkg.workspaces.includes('vendor/*') ||
        rootPkg.workspaces.includes('vendor/packages/*') ||
        rootPkg.workspaces.includes('vendor/packages/@theia/*'),
        'Root package.json workspaces must include vendor directories'
    );
    assert.ok(rootPkg.scripts['vendor:theia'], 'Root package.json must contain "vendor:theia" script');
    assert.ok(rootPkg.scripts['vendor:status'], 'Root package.json must contain "vendor:status" script');
    assert.ok(rootPkg.scripts['vendor:clean'], 'Root package.json must contain "vendor:clean" script');
    assert.ok(rootPkg.scripts['vendor:verify'], 'Root package.json must contain "vendor:verify" script');
    console.log('  ✓ Test 1 Passed: Root package.json workspaces and vendor scripts configured');

    // -------------------------------------------------------------
    // Test 2: Vendor directory structure and README.md
    // -------------------------------------------------------------
    assert.ok(fs.existsSync(vendorDir), 'vendor/ directory must exist');
    assert.ok(fs.existsSync(vendorReadmePath), 'vendor/README.md must exist');
    const readmeContent = await fs.readFile(vendorReadmePath, 'utf8');
    assert.ok(readmeContent.includes('Option A: Workspace Vendoring'), 'vendor/README.md must describe Workspace Vendoring');
    assert.ok(readmeContent.includes('vendor:theia'), 'vendor/README.md must explain vendor commands');
    console.log('  ✓ Test 2 Passed: vendor/ directory structure and documentation verified');

    // -------------------------------------------------------------
    // Test 3: Tooling script exists and can be imported
    // -------------------------------------------------------------
    assert.ok(fs.existsSync(vendorScriptPath), 'scripts/vendor-theia.ts must exist');
    const vendorTooling = require(vendorScriptPath);
    assert.ok(typeof vendorTooling.VendorTheiaManager === 'function', 'VendorTheiaManager class must be exported');
    console.log('  ✓ Test 3 Passed: scripts/vendor-theia.ts module loaded and exports VendorTheiaManager');

    // -------------------------------------------------------------
    // Test 4: Dynamic import and copy from a mock local Theia build
    // -------------------------------------------------------------
    const tempDir = path.join(os.tmpdir(), `sb-vendor-test-${Date.now()}`);
    const mockTheiaSource = path.join(tempDir, 'theia-source');
    const mockVendorTarget = path.join(tempDir, 'scratchbox/vendor/packages/@theia');

    await fs.ensureDir(path.join(mockTheiaSource, 'packages/core'));
    await fs.ensureDir(path.join(mockTheiaSource, 'packages/monaco'));
    await fs.ensureDir(path.join(mockTheiaSource, 'packages/ai-core'));

    // Create mock build artifacts in theia source
    await fs.writeJson(path.join(mockTheiaSource, 'packages/core/package.json'), {
        name: '@theia/core',
        version: '1.68.0-custom',
        main: 'lib/common/index.js'
    });
    await fs.ensureDir(path.join(mockTheiaSource, 'packages/core/lib/common'));
    await fs.writeFile(path.join(mockTheiaSource, 'packages/core/lib/common/index.js'), '// mock core lib');
    await fs.ensureDir(path.join(mockTheiaSource, 'packages/core/node_modules'));
    await fs.writeFile(path.join(mockTheiaSource, 'packages/core/node_modules/temp.js'), '// temporary');

    await fs.writeJson(path.join(mockTheiaSource, 'packages/monaco/package.json'), {
        name: '@theia/monaco',
        version: '1.68.0-custom',
        main: 'lib/browser/monaco-frontend-module.js'
    });
    await fs.ensureDir(path.join(mockTheiaSource, 'packages/monaco/lib/browser'));
    await fs.writeFile(path.join(mockTheiaSource, 'packages/monaco/lib/browser/monaco-frontend-module.js'), '// mock monaco');

    const manager = new vendorTooling.VendorTheiaManager({
        vendorTargetDir: mockVendorTarget,
        repoRoot: path.join(tempDir, 'scratchbox')
    });

    // Run discovery
    const discovered = await manager.discoverPackages(mockTheiaSource);
    assert.strictEqual(discovered.length, 2, 'Should discover 2 mock packages with package.json');
    assert.ok(discovered.some((p: any) => p.name === '@theia/core'), 'Must discover @theia/core');
    assert.ok(discovered.some((p: any) => p.name === '@theia/monaco'), 'Must discover @theia/monaco');
    console.log('  ✓ Test 4 Passed: Package discovery from local Theia source directory verified');

    // -------------------------------------------------------------
    // Test 5: Ingesting/Vendoring packages into target directory
    // -------------------------------------------------------------
    const importResult = await manager.importPackages({
        sourceDir: mockTheiaSource,
        mode: 'copy'
    });
    assert.strictEqual(importResult.success, true, 'Import must succeed');
    assert.strictEqual(importResult.importedCount, 2, 'Must import 2 packages');

    const coreVendoredDir = path.join(mockVendorTarget, 'core');
    assert.ok(fs.existsSync(path.join(coreVendoredDir, 'package.json')), 'Vendored core package.json must exist');
    assert.ok(fs.existsSync(path.join(coreVendoredDir, 'lib/common/index.js')), 'Vendored core lib files must exist');
    assert.ok(!fs.existsSync(path.join(coreVendoredDir, 'node_modules/temp.js')), 'node_modules must be excluded when vendoring');
    console.log('  ✓ Test 5 Passed: Automated package copying and artifact filtering verified');

    // -------------------------------------------------------------
    // Test 6: Vendor status inspection
    // -------------------------------------------------------------
    const status = await manager.getStatus();
    assert.strictEqual(status.isVendored, true, 'Status should report vendored packages are present');
    assert.strictEqual(status.vendoredPackages.length, 2, 'Status should list 2 vendored packages');
    assert.ok(status.vendoredPackages.includes('@theia/core'), 'Status includes @theia/core');
    assert.ok(status.vendoredPackages.includes('@theia/monaco'), 'Status includes @theia/monaco');
    console.log('  ✓ Test 6 Passed: Vendor status accurately lists vendored packages');

    // -------------------------------------------------------------
    // Test 7: Integrity verification
    // -------------------------------------------------------------
    const verification = await manager.verify();
    assert.strictEqual(verification.valid, true, 'Verification of healthy build should pass');
    assert.strictEqual(verification.issues.length, 0, 'No issues expected in healthy mock');

    // Intentionally corrupt one package by removing its package.json
    await fs.remove(path.join(coreVendoredDir, 'package.json'));
    const corruptedVerification = await manager.verify();
    assert.strictEqual(corruptedVerification.valid, false, 'Corrupted package should fail verification');
    assert.ok(corruptedVerification.issues.length > 0, 'Issues list should contain missing package.json error');
    console.log('  ✓ Test 7 Passed: Integrity verification detects valid and corrupted states');

    // -------------------------------------------------------------
    // Test 8: Clean / un-vendor lifecycle
    // -------------------------------------------------------------
    const cleanResult = await manager.clean();
    assert.strictEqual(cleanResult.success, true, 'Clean should succeed');
    assert.strictEqual(fs.readdirSync(mockVendorTarget).length, 0, 'mockVendorTarget should be empty after clean');
    const postCleanStatus = await manager.getStatus();
    assert.strictEqual(postCleanStatus.isVendored, false, 'Status should be false after clean');
    assert.strictEqual(postCleanStatus.vendoredPackages.length, 0, 'Vendored packages list should be empty');
    console.log('  ✓ Test 8 Passed: Clean and un-vendoring lifecycle verified');

    // Cleanup temp directory
    await fs.remove(tempDir);

    console.log('\n🎉 ALL WORKSPACE VENDORING & AUTOMATED TOOLING TESTS PASSED SUCCESSFULLY!');
}

if (require.main === module) {
    runWorkspaceVendoringTests().catch(err => {
        console.error('❌ Workspace vendoring test failed:', err);
        process.exit(1);
    });
}

export { runWorkspaceVendoringTests };
