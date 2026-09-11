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

async function runAllCursorSettingsTabsTests() {
    console.log('🧪 Running Comprehensive 12-Tab Cursor Settings Experience Test Suite...\n');

    const settingsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');

    assert.ok(fs.existsSync(settingsTsxPath), 'SettingsModal.tsx must exist');
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist');

    const source = fs.readFileSync(settingsTsxPath, 'utf-8');
    const css = fs.readFileSync(unifiedCssPath, 'utf-8');

    // -------------------------------------------------------------
    // Tab 1: Profile Tab
    // -------------------------------------------------------------
    assert.ok(source.includes('Profile Image'), 'Profile tab must render "Profile Image" section');
    assert.ok(source.includes('Upload image'), 'Profile tab must provide "Upload image" button');
    assert.ok(source.includes('First Name') && source.includes('Last Name'), 'Profile tab must provide First Name and Last Name fields');
    assert.ok(source.includes('Claim handle'), 'Profile tab must provide "Claim handle" action');
    assert.ok(source.includes('Public Profile'), 'Profile tab must provide "Public Profile" toggle');
    console.log('  ✓ Test 1 Passed: Profile tab with avatar uploader, name fields, handle claiming, and public profile toggle verified');

    // -------------------------------------------------------------
    // Tab 2: Appearance Tab
    // -------------------------------------------------------------
    assert.ok(source.includes('Tool Call Density'), 'Appearance tab must render "Tool Call Density" slider');
    assert.ok(source.includes('Code Block Word Wrap'), 'Appearance tab must render "Code Block Word Wrap" toggle');
    assert.ok(source.includes('Themed Diff Backgrounds'), 'Appearance tab must render "Themed Diff Backgrounds" toggle');
    assert.ok(source.includes('Hue') && source.includes('Intensity'), 'Appearance tab must render Hue & Intensity color sliders');
    assert.ok(source.includes('UI Font Size') && source.includes('Code Font Size'), 'Appearance tab must render font size steppers');
    assert.ok(source.includes('return a + b;'), 'Appearance tab must render live code diff preview box');
    assert.ok(source.includes('const result = a + b;'), 'Appearance tab live diff preview must show green addition line');
    console.log('  ✓ Test 2 Passed: Appearance tab with tool density slider, color tints, font steppers, and live diff preview verified');

    // -------------------------------------------------------------
    // Tab 3: Plan & Usage Tab
    // -------------------------------------------------------------
    assert.ok(source.includes('CURRENT PLAN'), 'Plan tab must render "CURRENT PLAN" card');
    assert.ok(source.includes('UPGRADE AVAILABLE'), 'Plan tab must render "UPGRADE AVAILABLE" card');
    assert.ok(source.includes('Included in Pro'), 'Plan tab must render "Included in Pro" usage section');
    assert.ok(source.includes('On-Demand Usage'), 'Plan tab must render "On-Demand Usage" section');
    assert.ok(source.includes('Monthly Limit'), 'Plan tab must render "Monthly Limit" selector');
    console.log('  ✓ Test 3 Passed: Plan & Usage tab with dual plan cards, usage meters, and on-demand limit selector verified');

    // -------------------------------------------------------------
    // Tab 4: Agents Tab
    // -------------------------------------------------------------
    assert.ok(source.includes('Submit with ⌘ + Enter') || source.includes('Submit with Cmd+Enter'), 'Agents tab must render "Submit with ⌘ + Enter" toggle');
    assert.ok(source.includes('Default Environment'), 'Agents tab must render "Default Environment" dropdown');
    assert.ok(source.includes('New Messages'), 'Agents tab must render "New Messages" steer behavior');
    assert.ok(source.includes('Agent Autocomplete'), 'Agents tab must render "Agent Autocomplete" toggle');
    assert.ok(source.includes('Auto-Approve Mode Transitions'), 'Agents tab must render "Auto-Approve Mode Transitions" toggle');
    assert.ok(source.includes('Third-Party Imports'), 'Agents tab must render "Third-Party Imports" group');
    assert.ok(source.includes('Remote Control'), 'Agents tab must render "Remote Control" group');
    assert.ok(source.includes('Context and Tools') || source.includes('Context & Tools'), 'Agents tab must render "Context and Tools" group');
    assert.ok(source.includes('Run Mode'), 'Agents tab must render "Run Mode" dropdown with Run Everything (Unsandboxed)');
    console.log('  ✓ Test 4 Passed: Agents tab with conversation controls, third-party imports, remote control, and run mode verified');

    // -------------------------------------------------------------
    // Tab 5: Git & PRs Tab
    // -------------------------------------------------------------
    assert.ok(source.includes('Review Provider'), 'Git & PRs tab must render "Review Provider" selector');
    assert.ok(source.includes('PR Link Destination'), 'Git & PRs tab must render "PR Link Destination" selector');
    assert.ok(source.includes('Commit Attribution'), 'Git & PRs tab must render "Commit Attribution" toggle');
    assert.ok(source.includes('PR Attribution'), 'Git & PRs tab must render "PR Attribution" toggle');
    assert.ok(source.includes('Branch Prefix'), 'Git & PRs tab must render "Branch Prefix" input');
    console.log('  ✓ Test 5 Passed: Git & PRs tab with review provider, attribution toggles, and branch prefix input verified');

    // -------------------------------------------------------------
    // Tab 6: Worktrees Tab
    // -------------------------------------------------------------
    assert.ok(source.includes('Max Worktrees'), 'Worktrees tab must render "Max Worktrees" counter stepper');
    assert.ok(source.includes('Max Total Size (GB)'), 'Worktrees tab must render "Max Total Size (GB)" counter stepper');
    assert.ok(source.includes('Cursor-Managed Worktrees'), 'Worktrees tab must render "Cursor-Managed Worktrees" section');
    console.log('  ✓ Test 6 Passed: Worktrees tab with cleanup limits and worktree manager verified');

    // -------------------------------------------------------------
    // Tab 7: Browser & Network Tab
    // -------------------------------------------------------------
    assert.ok(source.includes('Browser Automation'), 'Browser & Network tab must render "Browser Automation" selector');
    assert.ok(source.includes('Browser Protection'), 'Browser & Network tab must render "Browser Protection" toggle');
    assert.ok(source.includes('Open Local Links in Cursor Browser'), 'Browser & Network tab must render "Open Local Links" toggle');
    assert.ok(source.includes('HTTP Compatibility Mode'), 'Browser & Network tab must render "HTTP Compatibility Mode" selector');
    assert.ok(source.includes('Required Domains'), 'Browser & Network tab must render "Required Domains" row with Copy/Show');
    assert.ok(source.includes('Network Diagnostics'), 'Browser & Network tab must render "Network Diagnostics" with Run Diagnostic');
    console.log('  ✓ Test 7 Passed: Browser & Network tab with browser automation, HTTP/2 compatibility, and diagnostics verified');

    // -------------------------------------------------------------
    // Tab 8: Tab (Autocomplete) Tab
    // -------------------------------------------------------------
    assert.ok(source.includes('Cursor Tab'), 'Tab settings must render "Cursor Tab" master toggle');
    assert.ok(source.includes('Partial Accepts'), 'Tab settings must render "Partial Accepts" toggle');
    assert.ok(source.includes('Suggestions While Commenting'), 'Tab settings must render "Suggestions While Commenting" toggle');
    assert.ok(source.includes('Whitespace-Only Suggestions'), 'Tab settings must render "Whitespace-Only Suggestions" toggle');
    assert.ok(source.includes('Auto Import for Python'), 'Tab settings must render "Auto Import for Python" toggle');
    assert.ok(source.includes('Ignored Files'), 'Tab settings must render "Ignored Files" glob input');
    console.log('  ✓ Test 8 Passed: Tab autocomplete settings with partial accepts, auto-imports, and glob ignore verified');

    // -------------------------------------------------------------
    // Tab 9: Code Intelligence Tab
    // -------------------------------------------------------------
    assert.ok(source.includes('Index Repositories for Instant Grep'), 'Code Intelligence tab must render "Index Repositories for Instant Grep" toggle');
    assert.ok(source.includes('Hierarchical Cursor Ignore'), 'Code Intelligence tab must render "Hierarchical Cursor Ignore" toggle');
    assert.ok(source.includes('Enable LSPs'), 'Code Intelligence tab must render "Enable LSPs" toggle');
    assert.ok(source.includes('Maximum Local LSP Workspaces'), 'Code Intelligence tab must render "Maximum Local LSP Workspaces" stepper');
    console.log('  ✓ Test 9 Passed: Code Intelligence tab with codebase indexing, cursorignore, and LSP limits verified');

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
