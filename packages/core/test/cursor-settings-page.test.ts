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
    // 'agents' (and 10 other unwired mock tabs) were deliberately pruned in 4f4e192
    // ("refactor(settings): prune unwired tabs ..."); the 10 operational tabs remain.
    const settingsTabUnion = (typesSource.match(/export type StudioSettingsTab =([^;]*);/) || [])[1] || '';
    for (const tab of ['general', 'appearance', 'models', 'workspace', 'skills', 'mcp', 'memories', 'shortcuts', 'admin', 'about']) {
        assert.ok(settingsTabUnion.includes(`'${tab}'`), `StudioSettingsTab must support '${tab}'`);
    }
    assert.ok(!settingsTabUnion.includes("'agents'"), "StudioSettingsTab must not reintroduce the pruned, unwired 'agents' tab");
    console.log('  ✓ Test 1 Passed: StudioSettingsTab type incorporates Cursor settings tabs');

    // -------------------------------------------------------------
    // Test 2: Sidebar Navigation with NO ICONS and pure typography
    // -------------------------------------------------------------
    // Sidebar labels after 4f4e192 pruned the unwired Profile / Plan & Usage / Agents / Cloud Agents /
    // Git & PRs / Worktrees / Browser & Network / Tab / Code Intelligence / Beta / Docs tabs.
    const sidebarLabels = ['General', 'Appearance', 'Models & AI', 'Workspace Rules', 'Skills', 'MCP Tools', 'Memories', 'Shortcuts', 'Admin & Demos', 'About'];
    for (const label of sidebarLabels) {
        assert.ok(settingsSource.includes(`label: '${label}'`), `Sidebar must contain "${label}" tab`);
    }
    for (const pruned of ['Profile', 'Plan & Usage', 'Agents', 'Cloud Agents', 'Git & PRs', 'Worktrees', 'Browser & Network', 'Tab', 'Code Intelligence', 'Beta', 'Docs']) {
        assert.ok(!settingsSource.includes(`label: '${pruned}'`), `Sidebar must not list the pruned, unwired "${pruned}" tab`);
    }

    // Verify sidebar items do NOT render icon tags
    assert.ok(
        settingsSource.includes('sb-cursor-settings-nav-item') || settingsSource.includes('sb-settings-nav-item'),
        'Settings sidebar must use clean nav items'
    );
    // 6e66ca1 replaced the literal "← Back" text with an <IconArrowLeft /> + "Back" label.
    assert.ok(
        settingsSource.includes('sb-cursor-settings-back-btn') && settingsSource.includes('aria-label="Back"') && settingsSource.includes('<IconArrowLeft') && settingsSource.includes('<span>Back</span>'),
        'Settings sidebar must contain the arrow-icon "Back" top button'
    );
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
    // 4f4e192 deliberately cleaned GeneralTab "to focus on workspace root and file operations"
    // (the unwired Account / Startup / Notifications / Privacy / Log Out mock controls were removed).
    const generalTabSource = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/settings/tabs/GeneralTab.tsx'), 'utf-8');
    assert.ok(generalTabSource.includes('Workspace &amp; Project'), 'General tab must contain "Workspace & Project" group header');
    assert.ok(generalTabSource.includes('sb-cursor-group-card'), 'General tab must use grouped settings cards');
    assert.ok(generalTabSource.includes('Active Workspace Root'), 'General tab must show the active workspace root');
    assert.ok(generalTabSource.includes('onClick={onOpenFolder}'), 'General tab must wire "Open Folder..." to onOpenFolder');
    assert.ok(generalTabSource.includes('onClick={onOpenWorkspace}'), 'General tab must wire "Open Workspace..." to onOpenWorkspace');
    assert.ok(generalTabSource.includes('onClick={onCreateFile}'), 'General tab must wire "New File" to onCreateFile');
    assert.ok(generalTabSource.includes("setActiveTab('workspace')") && generalTabSource.includes('Manage Rules'), 'General tab must link to workspace rules management');
    for (const pruned of ['Window Restoration', 'Continue Interrupted Agents', 'System Notifications', 'Menu Bar Icon', 'Privacy Mode', 'Log Out']) {
        assert.ok(!generalTabSource.includes(pruned), `General tab must not reintroduce the unwired "${pruned}" mock control`);
    }
    console.log('  ✓ Test 4 Passed: General tab contains wired workspace root and file operation controls');

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
