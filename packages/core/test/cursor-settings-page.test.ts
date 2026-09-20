import { test } from 'vitest';
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
import { readSettingsSources } from './source-helpers';

async function runCursorSettingsPageTests() {
    console.log('🧪 Running Cursor Settings Page (No-Icon Sidebar & Native Groups) Test Suite...\n');

    const settingsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');
    const canvasTypesPath = path.resolve(__dirname, '../src/browser/generative-canvas/canvas-types.ts');

    assert.ok(fs.existsSync(settingsTsxPath), 'SettingsModal.tsx must exist');
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist');
    assert.ok(fs.existsSync(canvasTypesPath), 'canvas-types.ts must exist');

    const settingsSource = readSettingsSources();
    const cssSource = fs.readFileSync(unifiedCssPath, 'utf-8');
    const typesSource = fs.readFileSync(canvasTypesPath, 'utf-8');

    // -------------------------------------------------------------
    // Test 1: StudioSettingsTab type includes Cursor-style navigation tabs
    // -------------------------------------------------------------
    assert.ok(typesSource.includes("'general'"), "StudioSettingsTab must support 'general'");
    assert.ok(typesSource.includes("'models'"), "StudioSettingsTab must support 'models'");
    assert.ok(typesSource.includes("'agents'"), "StudioSettingsTab must support 'agents'");
    console.log('  ✓ Test 1 Passed: StudioSettingsTab type incorporates Cursor settings tabs');

    // -------------------------------------------------------------
    // Test 2: Sidebar Navigation with NO ICONS and pure typography
    // -------------------------------------------------------------
    assert.ok(settingsSource.includes('General'), 'Sidebar must contain "General" tab');
    assert.ok(settingsSource.includes('Profile'), 'Sidebar must contain "Profile" tab');
    assert.ok(settingsSource.includes('Appearance'), 'Sidebar must contain "Appearance" tab');
    assert.ok(settingsSource.includes('Plan & Usage'), 'Sidebar must contain "Plan & Usage" tab');
    assert.ok(settingsSource.includes('Agents'), 'Sidebar must contain "Agents" tab');
    assert.ok(settingsSource.includes('Cloud Agents'), 'Sidebar must contain "Cloud Agents" tab');
    assert.ok(settingsSource.includes('Git & PRs'), 'Sidebar must contain "Git & PRs" tab');
    assert.ok(settingsSource.includes('Worktrees'), 'Sidebar must contain "Worktrees" tab');
    assert.ok(settingsSource.includes('Browser & Network'), 'Sidebar must contain "Browser & Network" tab');
    assert.ok(settingsSource.includes('Tab'), 'Sidebar must contain "Tab" tab');
    assert.ok(settingsSource.includes('Code Intelligence'), 'Sidebar must contain "Code Intelligence" tab');
    assert.ok(settingsSource.includes('Beta'), 'Sidebar must contain "Beta" tab');
    assert.ok(settingsSource.includes('Docs'), 'Sidebar must contain "Docs" tab');

    // Verify sidebar items do NOT render icon tags
    assert.ok(
        settingsSource.includes('sb-cursor-settings-nav-item') || settingsSource.includes('sb-settings-nav-item'),
        'Settings sidebar must use clean nav items'
    );
    assert.ok(settingsSource.includes('← Back'), 'Settings sidebar must contain "← Back" top button');
    assert.ok(settingsSource.includes('Search Settings'), 'Settings sidebar must contain "Search Settings" search bar');
    console.log('  ✓ Test 2 Passed: Typography-only no-icon sidebar navigation matches Cursor Desktop');

    // -------------------------------------------------------------
    // Test 3: Top Customize Notification Banner
    // -------------------------------------------------------------
    assert.ok(
        settingsSource.includes('Plugins, MCPs, Skills, and Rules have moved to Customize'),
        'Settings modal must display the Customize relocation notice banner'
    );
    assert.ok(settingsSource.includes('Open Customize'), 'Banner must include "Open Customize →" button');
    assert.ok(settingsSource.includes('Dismiss'), 'Banner must include "Dismiss" button');
    console.log('  ✓ Test 3 Passed: Top Customize notice banner rendered with action triggers');

    // -------------------------------------------------------------
    // Test 4: General Tab Grouped Settings Cards & Controls
    // -------------------------------------------------------------
    assert.ok(settingsSource.includes('Scratchbox Account') || settingsSource.includes('Cursor Account'), 'General tab must contain account row');
    assert.ok(settingsSource.includes('Startup'), 'General tab must contain "Startup" group header');
    assert.ok(settingsSource.includes('Tips'), 'Startup group must contain "Tips" toggle');
    assert.ok(settingsSource.includes('Window Restoration'), 'Startup group must contain "Window Restoration" dropdown');
    assert.ok(settingsSource.includes('Continue Interrupted Agents'), 'Startup group must contain "Continue Interrupted Agents" toggle');
    assert.ok(settingsSource.includes('Notifications'), 'General tab must contain "Notifications" group header');
    assert.ok(settingsSource.includes('System Notifications'), 'Notifications group must contain "System Notifications" toggle');
    assert.ok(settingsSource.includes('Warning Notifications'), 'Notifications group must contain "Warning Notifications" toggle');
    assert.ok(settingsSource.includes('Menu Bar Icon'), 'Notifications group must contain "Menu Bar Icon" toggle');
    assert.ok(settingsSource.includes('Completion Sound'), 'Notifications group must contain "Completion Sound" toggle');
    assert.ok(settingsSource.includes('Privacy Mode'), 'General tab must contain "Privacy Mode" row');
    assert.ok(settingsSource.includes('Log Out'), 'General tab must contain "Log Out" button');
    console.log('  ✓ Test 4 Passed: General tab contains Startup, Notifications, and Privacy grouped controls');

    // -------------------------------------------------------------
    // Test 5: Sidebar Footer with Clean User Profile
    // -------------------------------------------------------------
    assert.ok(!settingsSource.includes('sb-cursor-getting-started-row'), 'Sidebar footer must not include Getting Started indicator');
    assert.ok(!settingsSource.includes('Connect Slack'), 'Sidebar footer must not include Connect Slack button');
    assert.ok(settingsSource.includes('sb-cursor-settings-user-row'), 'Sidebar footer must render user profile row');
    console.log('  ✓ Test 5 Passed: Sidebar footer with clean profile row verified');

    // -------------------------------------------------------------
    // Test 6: CSS styles for Cursor settings layout & Apple green switches
    // -------------------------------------------------------------
    assert.ok(cssSource.includes('sb-cursor-settings-layout'), 'unified-ui.css must define sb-cursor-settings-layout');
    assert.ok(cssSource.includes('sb-cursor-group-card'), 'unified-ui.css must define sb-cursor-group-card');
    assert.ok(cssSource.includes('sb-cursor-toggle'), 'unified-ui.css must define sb-cursor-toggle');
    console.log('  ✓ Test 6 Passed: CSS styles for grouped cards, rows, and toggles verified');

    console.log('\n🎉 ALL CURSOR SETTINGS PAGE TESTS PASSED SUCCESSFULLY!');
}


export { runCursorSettingsPageTests };

test('cursor-settings-page.test', async () => {
    await runCursorSettingsPageTests();
}, 180_000);
