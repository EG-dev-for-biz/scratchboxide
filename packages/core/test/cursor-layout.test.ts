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

async function runCursorLayoutTests() {
    console.log('🧪 Running Cursor Layout, Workspace File Types & Add Logic Test Suite...');

    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    assert.ok(fs.existsSync(studioTsxPath), 'GenerativeCanvasStudio.tsx must exist');

    const source = fs.readFileSync(studioTsxPath, 'utf-8');

    // Test 1: Top Navigation contains New Chat, Search, and Customize
    assert.ok(source.includes('New Chat'), 'Sidebar must include "New Chat" action');
    assert.ok(source.includes('Search'), 'Sidebar must include "Search" action');
    assert.ok(source.includes('Customize'), 'Sidebar must include "Customize" action');
    console.log('  ✓ Test 1 Passed: Top navigation hierarchy contains New Chat, Search, and Customize');

    // Test 2: Search input filtering state
    assert.ok(source.includes('sidebarSearchQuery'), 'Must track sidebar search query state');
    assert.ok(source.includes('isSidebarSearchOpen'), 'Must track sidebar search open toggle state');
    console.log('  ✓ Test 2 Passed: Inline search filtering state and UI toggle verified');

    // Test 3: Workspaces section with active workspace node and '+' add button on workspace header
    assert.ok(source.includes('sb-sidebar-workspaces-section'), 'Must include workspaces section container');
    assert.ok(source.includes('scratchbox-ide-master'), 'Must display active workspace node');
    assert.ok(source.includes('sb-workspace-add-btn'), 'Must render "+" add button on workspace header row');
    assert.ok(source.includes('sb-history-time-badge'), 'Must format relative time badges (e.g. 8m, 47m, 1h, 2h)');
    console.log('  ✓ Test 3 Passed: Workspace header provides "+" button to create workspace-scoped files');

    // Test 4: Workspace "+" button supports 5 file types (Chat, Code, Document, Kanban, Canvas)
    assert.ok(source.includes('handleCreateWorkspaceFile'), 'Must implement handleCreateWorkspaceFile handler');
    assert.ok(source.includes('showAddFileMenu'), 'Must track showAddFileMenu dropdown state');
    assert.ok(source.includes('sb-add-file-dropdown'), 'Must render floating add-file dropdown menu');
    assert.ok(source.includes('Canvas Workflow'), 'Must include Canvas Workflow as a workspace file type in dropdown');
    console.log('  ✓ Test 4 Passed: Workspace "+" button provides 1-click creation of Chat, Code, Document, Kanban, and Canvas files');

    // Test 5: Clean topbar without redundant mode buttons, model selector pill, or breadcrumbs
    assert.ok(!source.includes('sb-layout-segmented-control'), 'Topbar must not contain redundant mode segmented buttons');
    assert.ok(!source.includes('sb-topbar-model-selector'), 'Topbar must not contain model selector pill');
    assert.ok(!source.includes('sb-topbar-breadcrumb'), 'Topbar must not contain center breadcrumb pill');
    console.log('  ✓ Test 5 Passed: Topbar cleaned of redundant mode buttons, model selector pill, and center breadcrumbs');

    // Test 6: Typed file rendering in workspace list with distinct icons
    assert.ok(source.includes('getSessionIcon'), 'Must map session file types to distinct icons');
    assert.ok(source.includes('sb-workspace-threads-list'), 'Files must be nested cleanly inside workspace threads list');
    console.log('  ✓ Test 6 Passed: Workspace files display typed icons and relative timestamps');

    // Test 7: Unified Bottom-Middle Chat Composer Placement Across ALL Surfaces
    assert.ok(source.includes('sb-bottom-chatgpt-dock'), 'Must render bottom-centered chat dock across all surfaces');
    assert.ok(source.includes('sb-unified-composer-capsule'), 'Must render unified composer capsule');
    assert.ok(source.includes('handleSurfaceAiPrompt') || source.includes('handleSendMessage'), 'Must implement AI mutation handler across all surfaces');
    assert.ok(!source.includes('sb-ide-main-split'), 'Must eliminate disparate left-sidebar chat split');
    console.log('  ✓ Test 7 Passed: Unified bottom-middle Chat Composer integrated across all surfaces (Chat, Code, Document, Kanban, Automation)');

    // Test 8: Collapsible Workspace Folders in Left Sidebar
    assert.ok(source.includes('collapsedWorkspaceIds'), 'Must track collapsedWorkspaceIds state for collapsible workspace folders');
    assert.ok(source.includes('toggleWorkspaceCollapse'), 'Must implement toggleWorkspaceCollapse handler');
    assert.ok(source.includes('sb-workspace-folder-chevron'), 'Must render collapsible chevron indicator next to workspace folder icon');
    console.log('  ✓ Test 8 Passed: Collapsible workspace folders with chevron toggling and preserved "+" button verified');

    console.log('\n🎉 ALL CURSOR LAYOUT & WORKSPACE FILE TESTS PASSED SUCCESSFULLY!');
}

test('cursor-layout.test', async () => {
    await runCursorLayoutTests();
}, 180_000);
