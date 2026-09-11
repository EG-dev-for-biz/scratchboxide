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

async function runCursorDesktopStreamlinedHomeTests() {
    console.log('🧪 Running Unified Main Window Layout & Bottom-Centered Composer Test Suite...\n');

    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');
    const indexCssPath = path.resolve(__dirname, '../src/browser/style/index.css');

    assert.ok(fs.existsSync(studioTsxPath), 'GenerativeCanvasStudio.tsx must exist');
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist');
    assert.ok(fs.existsSync(indexCssPath), 'index.css must exist');

    const studioSource = fs.readFileSync(studioTsxPath, 'utf-8');
    const cssSource = fs.readFileSync(unifiedCssPath, 'utf-8') + '\n' + fs.readFileSync(indexCssPath, 'utf-8');

    // -------------------------------------------------------------
    // Test 1: Sidebar Traffic Lights & Top Actions
    // -------------------------------------------------------------
    assert.ok(studioSource.includes('sb-mac-traffic-lights') || studioSource.includes('sb-traffic-light'), 'Sidebar must render Mac traffic lights');
    assert.ok(studioSource.includes('New Chat'), 'Sidebar must include "New Chat"');
    assert.ok(studioSource.includes('Search'), 'Sidebar must include "Search"');
    assert.ok(studioSource.includes('Customize'), 'Sidebar must include "Customize"');
    assert.ok(!studioSource.includes('title="Open Automations & Workflows Hub"'), 'Sidebar must NOT include deprecated Automations top nav button');
    assert.ok(studioSource.includes('Canvas Workflow'), 'Canvas must be available as a native workspace file type in "+" menu');
    console.log('  ✓ Test 1 Passed: Sidebar traffic lights and primary actions verified');

    // -------------------------------------------------------------
    // Test 2: Sidebar Project Hierarchy & Clean Profile Footer
    // -------------------------------------------------------------
    assert.ok(studioSource.includes('DepthBox') || studioSource.includes('scratchbox-test-workspace') || studioSource.includes('activeWorkspace'), 'Sidebar must include project folders (e.g. scratchbox-test-workspace)');
    assert.ok(studioSource.includes('Agents') || studioSource.includes('Workspaces'), 'Sidebar must include Workspaces or Agents section');
    assert.ok(studioSource.includes('Eli Green'), 'Sidebar footer must render user profile');
    assert.ok(!studioSource.includes('sb-sidebar-update-btn'), 'Sidebar footer must NOT render "Update" button');
    assert.ok(!studioSource.includes('Connect Slack'), 'Sidebar footer must NOT render "Connect Slack" button');
    console.log('  ✓ Test 2 Passed: Grouped project hierarchy and clean profile footer without Update / Connect Slack verified');

    // -------------------------------------------------------------
    // Test 3: Unified Main Window Layout & Empty Hero / Reading Stream
    // -------------------------------------------------------------
    assert.ok(studioSource.includes('sb-chat-stage-wrapper'), 'Main stage must use sb-chat-stage-wrapper');
    assert.ok(studioSource.includes('A canvas for AI work. What can I help you design, build, or analyze today?'), 'Empty state must render unified hero message');
    assert.ok(studioSource.includes('sb-standalone-chat-messages'), 'Chat stream must render centered reading column');
    assert.ok(!studioSource.includes('sb-cursor-dual-pane-stage'), 'Disparate dual-pane stage must be eliminated');
    console.log('  ✓ Test 3 Passed: Unified vertical main stage and centered reading column verified');

    // -------------------------------------------------------------
    // Test 4: Bottom-Centered Composer Dock with Minimalist Floating Capsule
    // -------------------------------------------------------------
    assert.ok(studioSource.includes('sb-bottom-chatgpt-dock'), 'Main stage must pin sb-bottom-chatgpt-dock at bottom center');
    assert.ok(studioSource.includes('sb-unified-composer-capsule'), 'Composer must render floating pill capsule');
    assert.ok(studioSource.includes('sb-composer-attach-btn'), 'Composer must render "+" context attach button');
    assert.ok(studioSource.includes('Agent') && studioSource.includes('Ask') && studioSource.includes('Plan'), 'Composer must render Agent, Ask, Plan mode pills');
    assert.ok(studioSource.includes('getComposerPlaceholder') || studioSource.includes('Ask Scratchbox') || studioSource.includes('/ for skills, @ for context'), 'Composer must render unified placeholder');
    assert.ok(!studioSource.includes('sb-cursor-composer-model-pill'), 'Composer model pill button must be eliminated for clean minimalist UI');
    assert.ok(!studioSource.includes('sb-cursor-indexing-badge'), 'Composer indexed badge must be eliminated for clean minimalist UI');
    assert.ok(!studioSource.includes('sb-composer-enhance-btn'), 'Composer sparkles enhance button must be eliminated for clean minimalist UI');
    assert.ok(studioSource.includes('sb-composer-voice-trigger'), 'Composer must render voice mic 🎙 button');
    assert.ok(studioSource.includes('sb-composer-send-circle'), 'Composer must render send ↑ button');
    console.log('  ✓ Test 4 Passed: Bottom-centered floating composer capsule with clean minimalist controls verified');

    // -------------------------------------------------------------
    // Test 5: CSS Styles for Unified Main Stage, Reading Column, and Bottom Dock
    // -------------------------------------------------------------
    assert.ok(cssSource.includes('sb-chat-stage-wrapper'), 'CSS must define sb-chat-stage-wrapper');
    assert.ok(cssSource.includes('sb-bottom-chatgpt-dock'), 'CSS must define sb-bottom-chatgpt-dock');
    assert.ok(cssSource.includes('sb-unified-composer-capsule'), 'CSS must define sb-unified-composer-capsule');
    assert.ok(cssSource.includes('sb-standalone-chat-messages'), 'CSS must define sb-standalone-chat-messages');
    console.log('  ✓ Test 5 Passed: CSS styling tokens for unified layout, reading column, and bottom dock verified');

    console.log('\n🎉 ALL UNIFIED MAIN WINDOW LAYOUT & BOTTOM-CENTERED COMPOSER TESTS PASSED SUCCESSFULLY!');
}

if (require.main === module) {
    runCursorDesktopStreamlinedHomeTests().catch(err => {
        console.error('❌ Test failed:', err);
        process.exit(1);
    });
}

export { runCursorDesktopStreamlinedHomeTests };
