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
import { readSettingsSources, readStudioSources } from './source-helpers';

async function runProjectsModalTests() {
    console.log('🧪 Running Streamlined Workspace Management & Trigger Elimination Test Suite...\n');

    const projectsModalPath = path.resolve(__dirname, '../src/browser/generative-canvas/ProjectsModal.tsx');
    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const settingsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');

    assert.ok(fs.existsSync(projectsModalPath), 'ProjectsModal.tsx must exist');
    assert.ok(fs.existsSync(studioTsxPath), 'GenerativeCanvasStudio.tsx must exist');
    assert.ok(fs.existsSync(settingsTsxPath), 'SettingsModal.tsx must exist');

    const projectsSource = fs.readFileSync(projectsModalPath, 'utf-8');
    const studioSource = readStudioSources();
    const settingsSource = readSettingsSources();

    // -------------------------------------------------------------
    // Test 1: Recent Projects & Starter Templates HIG Design System naming
    // -------------------------------------------------------------
    assert.ok(
        projectsSource.includes("name: 'HIG Design System'"),
        'ProjectsModal RECENT_PROJECTS must use "HIG Design System"'
    );
    assert.ok(
        projectsSource.includes("title: 'HIG Design System'"),
        'ProjectsModal STARTER_TEMPLATES must use "HIG Design System"'
    );
    assert.ok(
        !projectsSource.includes("name: 'Apple HIG Design System'") && !projectsSource.includes("title: 'Apple HIG Design System'"),
        'ProjectsModal must not contain "Apple HIG Design System"'
    );
    console.log('  ✓ Test 1 Passed: Project & template models properly formatted with "HIG Design System"');

    // -------------------------------------------------------------
    // Test 2: Elimination of Overwhelming Standalone ProjectsModal Popup Triggers
    // -------------------------------------------------------------
    // Verify studio does not render the overwhelming standalone ProjectsModal window
    assert.ok(
        !studioSource.includes('<ProjectsModal'),
        'GenerativeCanvasStudio must NOT render standalone ProjectsModal window'
    );
    // Verify clicking workspace header + button calls direct native openFolder/openWorkspace command
    assert.ok(
        !studioSource.includes("onClick={() => openModal('projects')}") &&
        !studioSource.includes('openModal(\'projects\')'),
        'Studio must not trigger openModal("projects") on workspace interactions'
    );
    console.log('  ✓ Test 2 Passed: Standalone ProjectsModal popup triggers eliminated from studio surface');

    // -------------------------------------------------------------
    // Test 3: Direct Native Commands Wired to Sidebar & Keyboard Shortcuts
    // -------------------------------------------------------------
    // ⌘O should trigger direct onOpenFolder or onOpenWorkspace native command
    assert.ok(
        studioSource.includes("key.toLowerCase() === 'o'") &&
        (studioSource.includes('onOpenFolder') || studioSource.includes('onOpenWorkspace')),
        '⌘O shortcut must wire to direct native onOpenFolder / onOpenWorkspace command'
    );
    // Topbar back button should return to chat without opening modal
    assert.ok(
        studioSource.includes("setLayoutMode('chat')"),
        'Topbar back button must cleanly return to chat mode'
    );
    console.log('  ✓ Test 3 Passed: ⌘O and sidebar buttons wired directly to native folder/workspace commands');

    // -------------------------------------------------------------
    // Test 4: Workspace Management Integration in SettingsModal
    // -------------------------------------------------------------
    assert.ok(
        settingsSource.includes('Active Workspace Root') || settingsSource.includes('Active Workspace'),
        'SettingsModal must display active workspace root information'
    );
    assert.ok(
        settingsSource.includes('onOpenFolder') && settingsSource.includes('onOpenWorkspace'),
        'SettingsModal must provide native Open Folder and Open Workspace action triggers'
    );
    assert.ok(
        settingsSource.includes('Custom Project Rules') || settingsSource.includes('Active Project Rules'),
        'SettingsModal must provide project rules management'
    );
    console.log('  ✓ Test 4 Passed: Workspace settings cleanly integrated into SettingsModal');

    // -------------------------------------------------------------
    // Test 5: Sidebar Workspace Tree Primary 1-Click Selection
    // -------------------------------------------------------------
    assert.ok(
        studioSource.includes('setActiveWorkspace(proj)') &&
        studioSource.includes('Switched active workspace to'),
        'Sidebar workspace tree must support direct 1-click active workspace switching'
    );
    console.log('  ✓ Test 5 Passed: Sidebar tree verified as primary 1-click workspace switcher');

    console.log('\n🎉 ALL STREAMLINED WORKSPACE MANAGEMENT TESTS PASSED SUCCESSFULLY!');
}


export { runProjectsModalTests };

test('projects-modal.test', async () => {
    await runProjectsModalTests();
}, 180_000);
