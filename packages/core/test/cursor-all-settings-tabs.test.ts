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

async function runAllCursorSettingsTabsTests() {
    console.log('🧪 Running Comprehensive 12-Tab Cursor Settings Experience Test Suite...\n');

    const settingsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');

    assert.ok(fs.existsSync(settingsTsxPath), 'SettingsModal.tsx must exist');
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist');

    const source = readSettingsSources();
    const css = fs.readFileSync(unifiedCssPath, 'utf-8');

    // Commit 4f4e192 ("refactor(settings): prune unwired tabs and enhance 3D geospatial pipeline")
    // deliberately removed 11 unwired mock tabs (Plan & Usage, Cloud Agents, Worktrees, Tab, Beta,
    // Git & PRs, Code Intelligence, Browser & Network, Profile, Agents, Docs) and rebound Appearance
    // to StudioAppearanceConfig. The checks below verify that deliberate state.
    const tabsDir = path.resolve(__dirname, '../src/browser/generative-canvas/settings/tabs');

    // -------------------------------------------------------------
    // Tab 1: Profile (pruned) -> identity lives in the sidebar footer user row
    // -------------------------------------------------------------
    assert.ok(!fs.existsSync(path.join(tabsDir, 'ProfileTab.tsx')), 'Unwired ProfileTab.tsx must stay pruned (4f4e192)');
    assert.ok(source.includes('sb-cursor-settings-user-row'), 'Settings sidebar footer must render the user row');
    assert.ok(source.includes('initialsOf(activeUserName)'), 'Settings user row must render the active user initials avatar');
    assert.ok(source.includes('sb-cursor-user-name'), 'Settings user row must render the active user name');
    console.log('  ✓ Test 1 Passed: Profile identity rendered in sidebar footer user row (mock Profile tab pruned)');

    // -------------------------------------------------------------
    // Tab 2: Appearance Tab (bound to StudioAppearanceConfig)
    // -------------------------------------------------------------
    const appearanceSource = fs.readFileSync(path.join(tabsDir, 'AppearanceTab.tsx'), 'utf-8');
    assert.ok(appearanceSource.includes('onAppearanceConfigChange'), 'Appearance tab must persist changes through onAppearanceConfigChange');
    assert.ok(appearanceSource.includes('Canvas Density') && appearanceSource.includes('canvasDensity: density'), 'Appearance tab must render a wired "Canvas Density" segmented control');
    assert.ok(appearanceSource.includes('Glass Surface Blur') && appearanceSource.includes('glassBlur: blur'), 'Appearance tab must render a wired "Glass Surface Blur" segmented control');
    assert.ok(appearanceSource.includes('enableSpringMotion: !appearanceConfig.enableSpringMotion'), 'Appearance tab must render a wired spring motion toggle');
    assert.ok(appearanceSource.includes('hapticFeedback: !appearanceConfig.hapticFeedback'), 'Appearance tab must render a wired haptic feedback toggle');
    assert.ok(appearanceSource.includes('showLineNumbersInCode: !appearanceConfig.showLineNumbersInCode'), 'Appearance tab must render a wired line numbers toggle');
    assert.ok(appearanceSource.includes('autoAttachSuperpowers: !appearanceConfig.autoAttachSuperpowers'), 'Appearance tab must render a wired superpowers auto-attach toggle');
    console.log('  ✓ Test 2 Passed: Appearance tab bound to StudioAppearanceConfig (density, blur, motion, haptics, editor toggles) verified');

    // -------------------------------------------------------------
    // Tabs 3-9: Plan & Usage, Agents, Git & PRs, Worktrees, Browser & Network, Tab, Code Intelligence
    // were unwired mocks and are pruned; they must not come back as dead UI.
    // -------------------------------------------------------------
    const prunedTabs: Array<[string, string, string]> = [
        ['PlanTab.tsx', 'plan', 'Monthly Limit'],
        ['AgentsTab.tsx', 'agents', 'Auto-Approve Mode Transitions'],
        ['CloudAgentsTab.tsx', 'cloud-agents', "label: 'Cloud Agents'"],
        ['GitPrsTab.tsx', 'git-prs', 'PR Link Destination'],
        ['WorktreesTab.tsx', 'worktrees', 'Max Worktrees'],
        ['BrowserNetworkTab.tsx', 'browser-network', 'HTTP Compatibility Mode'],
        ['TabTab.tsx', 'tab', 'Whitespace-Only Suggestions'],
        ['CodeIntelligenceTab.tsx', 'code-intelligence', 'Maximum Local LSP Workspaces'],
        ['BetaTab.tsx', 'beta', "label: 'Beta'"],
        ['DocsTab.tsx', 'docs', "label: 'Docs'"]
    ];
    for (const [file, id, marker] of prunedTabs) {
        assert.ok(!fs.existsSync(path.join(tabsDir, file)), `Unwired ${file} must stay pruned (4f4e192)`);
        assert.ok(!source.includes(`activeTab === '${id}'`), `SettingsModal must not render the pruned '${id}' tab`);
        assert.ok(!source.includes(marker), `Settings sources must not contain pruned '${id}' tab UI ("${marker}")`);
    }
    console.log('  ✓ Tests 3-9 Passed: unwired Plan, Agents, Git & PRs, Worktrees, Browser & Network, Tab, Code Intelligence tabs stay pruned');

    // -------------------------------------------------------------
    // Tab 10: CSS Styling Verification for Steppers, Sliders & Diff Box
    // -------------------------------------------------------------
    assert.ok(css.includes('sb-cursor-stepper'), 'unified-ui.css must define sb-cursor-stepper');
    assert.ok(css.includes('sb-cursor-slider'), 'unified-ui.css must define sb-cursor-slider');
    assert.ok(css.includes('sb-cursor-diff-preview'), 'unified-ui.css must define sb-cursor-diff-preview');
    assert.ok(css.includes('sb-cursor-plan-card'), 'unified-ui.css must define sb-cursor-plan-card');
    assert.ok(css.includes('sb-cursor-usage-bar'), 'unified-ui.css must define sb-cursor-usage-bar');
    console.log('  ✓ Test 10 Passed: CSS styles for steppers, sliders, plan cards, usage bars, and diff preview verified');

    console.log('\n🎉 ALL 12-TAB CURSOR SETTINGS PAGE TESTS PASSED SUCCESSFULLY!');
}


export { runAllCursorSettingsTabsTests };

test('cursor-all-settings-tabs.test', async () => {
    await runAllCursorSettingsTabsTests();
}, 180_000);
