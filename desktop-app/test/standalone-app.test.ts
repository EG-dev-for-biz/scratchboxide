/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

async function runStandaloneAppTests() {
    console.log('🧪 Running Standalone Vite + React Architecture & Purity Tests...\n');

    const appDir = path.resolve(__dirname, '..');
    const pkgJsonPath = path.join(appDir, 'package.json');
    const indexHtmlPath = path.join(appDir, 'index.html');
    const viteConfigPath = path.join(appDir, 'vite.config.ts');
    const mainTsxPath = path.join(appDir, 'src/main.tsx');
    const appTsxPath = path.join(appDir, 'src/App.tsx');
    const electronMainPath = path.join(appDir, 'electron/main.ts');

    // 1. package.json exists and has no @theia dependencies
    console.log('  Testing desktop-app/package.json purity...');
    assert.ok(fs.existsSync(pkgJsonPath), 'package.json must exist in desktop-app');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const allDeps = {
        ...(pkgJson.dependencies || {}),
        ...(pkgJson.devDependencies || {})
    };

    const theiaDeps = Object.keys(allDeps).filter(dep => dep.startsWith('@theia/'));
    assert.strictEqual(theiaDeps.length, 0, `desktop-app must not depend on any @theia packages, but found: ${theiaDeps.join(', ')}`);
    assert.ok(allDeps.vite, 'vite must be in dependencies/devDependencies');
    assert.ok(allDeps.react, 'react must be in dependencies/devDependencies');
    assert.ok(allDeps.express, 'express must be in dependencies/devDependencies');
    assert.ok(allDeps.electron, 'electron must be in dependencies/devDependencies');
    console.log('  ✓ Test 1 Passed: Zero @theia dependencies in desktop-app package.json');

    // 2. index.html does not have Theia DOM nodes or classes
    console.log('  Testing index.html structure...');
    assert.ok(fs.existsSync(indexHtmlPath), 'index.html must exist');
    const htmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');
    assert.ok(htmlContent.includes('<div id="root"></div>'), 'index.html must have clean #root mount');
    assert.ok(!htmlContent.includes('theia-app-shell'), 'index.html must not contain theia-app-shell');
    assert.ok(!htmlContent.includes('theia-top-panel'), 'index.html must not contain theia-top-panel');
    assert.ok(!htmlContent.includes('theia-statusBar'), 'index.html must not contain theia-statusBar');
    console.log('  ✓ Test 2 Passed: index.html mounts clean #root without Theia DOM artifacts');

    // 3. vite.config.ts configures proxy and React plugin
    console.log('  Testing vite.config.ts configuration...');
    assert.ok(fs.existsSync(viteConfigPath), 'vite.config.ts must exist');
    const viteConfig = fs.readFileSync(viteConfigPath, 'utf-8');
    assert.ok(viteConfig.includes('@vitejs/plugin-react'), 'vite.config.ts must use react plugin');
    assert.ok(viteConfig.includes('/gemini'), 'vite.config.ts must proxy /gemini');
    assert.ok(viteConfig.includes('/workspace'), 'vite.config.ts must proxy /workspace');
    assert.ok(viteConfig.includes('/media'), 'vite.config.ts must proxy /media');
    assert.ok(viteConfig.includes('/api/browser'), 'vite.config.ts must proxy /api/browser');
    console.log('  ✓ Test 3 Passed: vite.config.ts configures dev server & backend proxies');

    // 4. src/main.tsx and src/App.tsx mount clean GenerativeCanvasStudio
    console.log('  Testing src/main.tsx and src/App.tsx...');
    assert.ok(fs.existsSync(mainTsxPath), 'src/main.tsx must exist');
    assert.ok(fs.existsSync(appTsxPath), 'src/App.tsx must exist');
    const appTsx = fs.readFileSync(appTsxPath, 'utf-8');
    assert.ok(appTsx.includes('GenerativeCanvasStudio'), 'App.tsx must render GenerativeCanvasStudio');
    console.log('  ✓ Test 4 Passed: App.tsx directly hosts GenerativeCanvasStudio');

    // 5. electron/main.ts launches Electron cleanly
    console.log('  Testing electron/main.ts...');
    assert.ok(fs.existsSync(electronMainPath), 'electron/main.ts must exist');
    const electronMain = fs.readFileSync(electronMainPath, 'utf-8');
    assert.ok(electronMain.includes('BrowserWindow'), 'electron/main.ts must create BrowserWindow');
    assert.ok(electronMain.includes('hiddenInset'), 'electron/main.ts must configure modern titleBarStyle hiddenInset');
    console.log('  ✓ Test 5 Passed: Electron main process configured for modern desktop container');

    console.log('\n🎉 ALL STANDALONE APP ARCHITECTURE TESTS PASSED SUCCESSFULLY!\n');
}

runStandaloneAppTests().catch(err => {
    console.error('❌ Standalone App Test Suite Failed:', err);
    process.exit(1);
});
