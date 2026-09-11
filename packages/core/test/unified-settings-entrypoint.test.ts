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

async function runUnifiedSettingsEntrypointTests() {
    console.log('🧪 Running Unified Settings Entry Points & Trigger Elimination Test Suite...\n');

    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const settingsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');
    const indexCssPath = path.resolve(__dirname, '../src/browser/style/index.css');

    assert.ok(fs.existsSync(studioTsxPath), 'GenerativeCanvasStudio.tsx must exist');
    assert.ok(fs.existsSync(settingsTsxPath), 'SettingsModal.tsx must exist');
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist');
    assert.ok(fs.existsSync(indexCssPath), 'index.css must exist');

    const studioSource = fs.readFileSync(studioTsxPath, 'utf-8');
    const settingsSource = fs.readFileSync(settingsTsxPath, 'utf-8');
    const unifiedCss = fs.readFileSync(unifiedCssPath, 'utf-8');
    const indexCss = fs.readFileSync(indexCssPath, 'utf-8');

    // -------------------------------------------------------------
    // Test 1: Single Canonical Settings Gear Button at Bottom-Left Sidebar
    // -------------------------------------------------------------
    assert.ok(
        studioSource.includes('sb-profile-settings-btn') &&
        studioSource.includes("openSettingsToTab('general')"),
        'Canonical Settings gear button in bottom-left sidebar must open settings to general tab'
    );
    assert.ok(
        studioSource.includes('<IconSettings') || studioSource.includes('IconSettings'),
        'Sidebar settings trigger must render the IconSettings gear icon'
    );
    console.log('  ✓ Test 1 Passed: Single canonical Gear Icon (⚙) button at bottom-left sidebar verified');

    // -------------------------------------------------------------
    // Test 2: Standard ⌘, Shortcut & Settings Dismissal (← Back & Esc)
    // -------------------------------------------------------------
    assert.ok(
        studioSource.includes("e.key === ','") &&
        (studioSource.includes("openSettingsToTab('general')") || studioSource.includes("openModal('settings')")),
        'Standard ⌘, shortcut must trigger Settings modal'
    );
    assert.ok(
        settingsSource.includes('← Back'),
        'Settings modal must retain "← Back" top button for dismissal'
    );
    assert.ok(
        settingsSource.includes("e.key === 'Escape'") || settingsSource.includes('Escape'),
        'Settings modal must support Esc key dismissal'
    );
    assert.ok(
        studioSource.includes("e.key === 'Escape'") && studioSource.includes('closeTopModal'),
        'Studio keyboard handler must close top modal on Esc'
    );
    console.log('  ✓ Test 2 Passed: ⌘, shortcut, ← Back button, and Esc dismissal verified');

    // -------------------------------------------------------------
    // Test 3: Elimination of Accidental Trigger from Profile Avatar/Name Row
    // -------------------------------------------------------------
    // Profile avatar/name row should NOT have an onClick calling openSettingsToTab('profile') or openModal
    const profileRowMatch = /<div className="sb-profile-avatar-info"([^>]*)>/s.exec(studioSource);
    assert.ok(profileRowMatch, 'Profile avatar info row must exist');
    const profileRowAttrs = profileRowMatch[1];
    assert.ok(
        !profileRowAttrs.includes('openSettingsToTab') && !profileRowAttrs.includes('openModal'),
        'Profile avatar/name row must NOT contain an onClick jumping to settings modal'
    );
    console.log('  ✓ Test 3 Passed: Profile avatar/name row converted to pure display without settings jump');

    // -------------------------------------------------------------
    // Test 4: Elimination of Accidental Trigger from Topbar "This Mac ▾" Pill & Breadcrumb Removal
    // -------------------------------------------------------------
    assert.ok(
        !studioSource.includes('sb-topbar-breadcrumb'),
        'Topbar breadcrumb pill must be eliminated for clean minimalist header'
    );
    assert.ok(
        !studioSource.includes('sb-cursor-this-mac-pill'),
        'Topbar "This Mac" pill must be eliminated'
    );
    console.log('  ✓ Test 4 Passed: Topbar "This Mac ▾" breadcrumb pill completely eliminated');

    // -------------------------------------------------------------
    // Test 5: Elimination of Accidental Trigger from Composer Model Pill
    // -------------------------------------------------------------
    assert.ok(
        !studioSource.includes('sb-cursor-composer-model-pill'),
        'Composer model pill must be eliminated entirely from composer'
    );
    console.log('  ✓ Test 5 Passed: Composer model pill eliminated entirely');

    // -------------------------------------------------------------
    // Test 6: Elimination of Accidental Trigger from Token HUD Popover
    // -------------------------------------------------------------
    assert.ok(
        !studioSource.includes("setIsTokenHudOpen(false);\n                                                openSettingsToTab('workspace')") &&
        !studioSource.includes("openSettingsToTab('workspace');\n                                            }}"),
        'Token HUD popover must NOT contain stray settings modal link'
    );
    console.log('  ✓ Test 6 Passed: Token HUD popover stray settings trigger eliminated');

    // -------------------------------------------------------------
    // Test 7: Topbar 3-Dots Button Converted to Conversation Actions Menu
    // -------------------------------------------------------------
    assert.ok(
        !studioSource.includes("onClick={() => openSettingsToTab('guide')}"),
        'Topbar 3-dots button must NOT jump into Settings guide tab'
    );
    assert.ok(
        studioSource.includes('isConversationMenuOpen') || studioSource.includes('showConversationMenu'),
        'Topbar 3-dots button must control dedicated conversation actions menu state'
    );
    assert.ok(
        studioSource.includes('Conversation Actions') || studioSource.includes('Export Chat') || studioSource.includes('Clear Conversation'),
        'Topbar 3-dots menu must provide conversation-specific actions'
    );
    console.log('  ✓ Test 7 Passed: Topbar 3-dots button dedicated to conversation actions menu');

    // -------------------------------------------------------------
    // Test 8: CSS Cursor & Interaction Audit
    // -------------------------------------------------------------
    assert.ok(
        indexCss.includes('.sb-profile-avatar-info') && indexCss.includes('cursor: default'),
        'index.css must set cursor: default on .sb-profile-avatar-info'
    );
    assert.ok(
        unifiedCss.includes('.sb-cursor-this-mac-pill') && unifiedCss.includes('cursor: default'),
        'unified-ui.css must set cursor: default on .sb-cursor-this-mac-pill'
    );
    assert.ok(
        unifiedCss.includes('.sb-topbar-conversation-menu') || indexCss.includes('.sb-topbar-conversation-menu'),
        'CSS styles must define .sb-topbar-conversation-menu'
    );
    console.log('  ✓ Test 8 Passed: CSS non-interactive cursor tokens and conversation menu styles verified');

    console.log('\n🎉 ALL UNIFIED SETTINGS ENTRY POINT TESTS PASSED SUCCESSFULLY!');
}


export { runUnifiedSettingsEntrypointTests };

test('unified-settings-entrypoint.test', async () => {
    await runUnifiedSettingsEntrypointTests();
}, 180_000);
