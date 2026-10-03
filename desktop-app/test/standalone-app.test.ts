import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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

    // 1. package.json exists and has no external legacy dependencies
    console.log('  Testing desktop-app/package.json purity...');
    assert.ok(fs.existsSync(pkgJsonPath), 'package.json must exist in desktop-app');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const allDeps = {
        ...(pkgJson.dependencies || {}),
        ...(pkgJson.devDependencies || {})
    };

    const legacyPrefix = ['@', 'the', 'ia'].join('');
    const legacyDeps = Object.keys(allDeps).filter(dep => dep.startsWith(`${legacyPrefix}/`));
    assert.strictEqual(legacyDeps.length, 0, `desktop-app must not depend on legacy packages, but found: ${legacyDeps.join(', ')}`);
    assert.ok(allDeps.vite, 'vite must be in dependencies/devDependencies');
    assert.ok(allDeps.react, 'react must be in dependencies/devDependencies');
    assert.ok(allDeps.express, 'express must be in dependencies/devDependencies');
    assert.ok(allDeps.electron, 'electron must be in dependencies/devDependencies');
    console.log('  ✓ Test 1 Passed: Zero legacy dependencies in desktop-app package.json');

    // 2. index.html does not have legacy shell DOM nodes or classes
    console.log('  Testing index.html structure...');
    assert.ok(fs.existsSync(indexHtmlPath), 'index.html must exist');
    const htmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');
    assert.ok(htmlContent.includes('<div id="root"></div>'), 'index.html must have clean #root mount');
    assert.ok(!htmlContent.toLowerCase().includes(['the', 'ia'].join('')), 'index.html must not contain legacy classes or DOM artifacts');
    console.log('  ✓ Test 2 Passed: index.html mounts clean #root without legacy DOM artifacts');

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

test('standalone-app.test', async () => {
    await runStandaloneAppTests();
}, 180_000);
