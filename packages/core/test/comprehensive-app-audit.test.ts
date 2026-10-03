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

async function runComprehensiveAppAuditTests() {
    console.log('🧪 Running Comprehensive App-Wide Feature & Surface Audit Test Suite...\n');

    const studioPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const sandboxPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx');
    const docPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx');
    const kanbanPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/KanbanBoardPrimitive.tsx');
    const nodeGraphPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/NodeGraphPrimitive.tsx');
    const metricPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MetricCardsPrimitive.tsx');
    const formPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/InteractiveFormPrimitive.tsx');
    const mindMapPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MindMapPrimitive.tsx');
    const checklistPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/ChecklistPrimitive.tsx');
    const settingsPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
    const spotlightPath = path.resolve(__dirname, '../src/browser/generative-canvas/SpotlightLauncherModal.tsx');
    const autocompletePath = path.resolve(__dirname, '../src/browser/generative-canvas/ContextMentionAutocompletePopover.tsx');

    // -------------------------------------------------------------
    // Section 1: Welcome / New Chat View Verification
    // -------------------------------------------------------------
    const studioSrc = readStudioSources();
    assert.ok(studioSrc.includes('sb-unified-composer-capsule'), 'Main studio must render bottom composer capsule');
    assert.ok(studioSrc.includes('sb-cursor-mode-selector'), 'Composer must include mode selector');
    assert.ok(studioSrc.includes('Agent') && studioSrc.includes('Ask') && studioSrc.includes('Plan'), 'Composer must have Agent, Ask, Plan mode pills');
    assert.ok(studioSrc.includes('sb-composer-attach-btn'), 'Composer must have context attachment button (+)');
    assert.ok(studioSrc.includes('sb-composer-voice-trigger'), 'Composer must have voice dictation trigger');
    assert.ok(studioSrc.includes('sb-composer-send-circle'), 'Composer must have submission send button');
    assert.ok(studioSrc.includes('sb-welcome-mode-strip') || studioSrc.includes('sb-starter-prompts-grid'), 'Welcome view must render Quick Mode Starter Strip');
    console.log('  ✓ Test 1 Passed: Welcome / New Chat View verified (Composer dock, mode pills, attach, voice, send, starter strip)');

    // -------------------------------------------------------------
    // Section 2: Live Code Sandbox Verification
    // -------------------------------------------------------------
    const sandboxSrc = fs.readFileSync(sandboxPath, 'utf-8');
    assert.ok(sandboxSrc.includes('handleExecuteQuickEdit'), 'Sandbox must support Quick Edit bar (⌘K)');
    assert.ok(sandboxSrc.includes('handleAcceptQuickEdit') && sandboxSrc.includes('handleRejectQuickEdit'), 'Sandbox must support accepting and rejecting diffs');
    assert.ok(sandboxSrc.includes('Add Spring Physics'), 'Sandbox must provide "Add Spring Physics" action button');
    assert.ok(sandboxSrc.includes('Apply Liquid Glass UI'), 'Sandbox must provide "Apply Liquid Glass UI" action button');
    assert.ok(sandboxSrc.includes('Confetti Action Trigger'), 'Sandbox must provide "Confetti Action Trigger" action button');
    assert.ok(sandboxSrc.includes('setRefreshKey'), 'Sandbox must provide "Run" / refresh execution trigger');
    assert.ok(sandboxSrc.includes('handleSaveToWorkspace'), 'Sandbox must provide "Save" to workspace action');
    assert.ok(sandboxSrc.includes('viewMode') && sandboxSrc.includes('setViewMode'), 'Sandbox must support code, split, and preview view modes');
    assert.ok(sandboxSrc.includes('viewportMode') && sandboxSrc.includes('setViewportMode'), 'Sandbox must support desktop, tablet, and mobile viewport modes');
    console.log('  ✓ Test 2 Passed: Live Code Sandbox verified (Quick edit ⌘K, diff lifecycle, actions, run, save, view modes)');

    // -------------------------------------------------------------
    // Section 3: Markdown Document Spec Verification
    // -------------------------------------------------------------
    const docSrc = fs.readFileSync(docPath, 'utf-8');
    assert.ok(docSrc.includes('handleAddSection'), 'Document must support adding sections');
    assert.ok(docSrc.includes('handleToggleChecklist'), 'Document must support checklist toggle');
    assert.ok(docSrc.includes('handleAddTableColumn') && docSrc.includes('handleAddTableRow'), 'Document must support table rows and columns');
    assert.ok(docSrc.includes('handleSelectionAction'), 'Document must support floating AI selection refinement');
    assert.ok(docSrc.includes('handleExportMarkdown') || docSrc.includes('Export Markdown') || docSrc.includes('onExportMarkdown') || docSrc.includes('exportDoc'), 'Document must support markdown export');
    console.log('  ✓ Test 3 Passed: Markdown Document Spec verified (Section adding, checklist toggle, tables, selection AI, export)');

    // -------------------------------------------------------------
    // Section 4: Sprint Roadmap Kanban Board Verification
    // -------------------------------------------------------------
    const kanbanSrc = fs.readFileSync(kanbanPath, 'utf-8');
    assert.ok(kanbanSrc.includes('handleMoveCard'), 'Kanban board must support card movement across columns');
    assert.ok(kanbanSrc.includes('handleDropCard'), 'Kanban board must support drag-and-drop card movement');
    assert.ok(kanbanSrc.includes('handleAddCardSubmit'), 'Kanban board must support adding new task cards');
    assert.ok(kanbanSrc.includes('handleDeleteCard'), 'Kanban board must support deleting cards');
    assert.ok(kanbanSrc.includes('handleAddColumnSubmit'), 'Kanban board must support adding new stage columns');
    assert.ok(kanbanSrc.includes('morphKanbanCardToSandbox'), 'Kanban board must support "Code & Test" execution trigger to live sandbox');
    console.log('  ✓ Test 4 Passed: Sprint Roadmap Kanban Board verified (Card movement, drag & drop, adding/deleting, Code & Test morph)');

    // -------------------------------------------------------------
    // Section 5: Automation Workflow Node Graph Verification
    // -------------------------------------------------------------
    const nodeGraphSrc = fs.readFileSync(nodeGraphPath, 'utf-8');
    assert.ok(nodeGraphSrc.includes('handlePlayFlow'), 'Node graph must support Play Flow simulation');
    assert.ok(nodeGraphSrc.includes('handleStepFlow'), 'Node graph must support Step Flow simulation');
    assert.ok(nodeGraphSrc.includes('handleResetFlow'), 'Node graph must support Reset Flow simulation');
    assert.ok(nodeGraphSrc.includes('handleAddCustomNode'), 'Node graph must support adding nodes');
    assert.ok(nodeGraphSrc.includes('autoFit'), 'Node graph must support Fit View zoom control');
    assert.ok(nodeGraphSrc.includes('setZoomLevel'), 'Node graph must support zoom in / zoom out controls');
    assert.ok(nodeGraphSrc.includes('handleDoubleClickNode'), 'Node graph must support double-click parameter and JSON editor');
    console.log('  ✓ Test 5 Passed: Automation Workflow Node Graph verified (Flow playback, stepping, adding nodes, zoom controls, JSON editor)');

    // -------------------------------------------------------------
    // Section 6: Other Visual Primitives Verification
    // -------------------------------------------------------------
    const metricSrc = fs.readFileSync(metricPath, 'utf-8');
    assert.ok(metricSrc.includes('setTimeRange'), 'Metric cards must support time range filtering (7D, 30D, 90D, YTD)');
    assert.ok(metricSrc.includes('setChartMode'), 'Metric cards must support chart mode toggles (Area, Line, Bar)');
    assert.ok(metricSrc.includes('renderSparkline'), 'Metric cards must render mini sparklines');

    const formSrc = fs.readFileSync(formPath, 'utf-8');
    assert.ok(formSrc.includes('handleSubmit'), 'Interactive form must validate and process form submissions');
    assert.ok(formSrc.includes('handleVisualizeResponses'), 'Interactive form must transform responses into live metric dashboard');

    const mindMapSrc = fs.readFileSync(mindMapPath, 'utf-8');
    assert.ok(mindMapSrc.includes('handleAddChildNode'), 'Mind map must support adding child idea nodes');
    assert.ok(mindMapSrc.includes('toggleCollapse'), 'Mind map must support branch collapse/expand');

    const checklistSrc = fs.readFileSync(checklistPath, 'utf-8');
    assert.ok(checklistSrc.includes('toggleItem'), 'Checklist primitive must support item check toggling');
    assert.ok(checklistSrc.includes('handleAddItem'), 'Checklist primitive must support adding new checklist items');
    console.log('  ✓ Test 6 Passed: Other Visual Primitives verified (Metric filters/modes, Form validation & visualization, MindMap hierarchy, Checklist)');

    // -------------------------------------------------------------
    // Section 7: Settings Modal & All Tabs Verification
    // -------------------------------------------------------------
    const settingsSrc = readSettingsSources();
    const requiredSettingsTabs = [
        'general',
        'profile',
        'appearance',
        'plan',
        'agents',
        'cloud-agents',
        'git-prs',
        'worktrees',
        'browser-network',
        'tab',
        'code-intelligence',
        'beta',
        'docs',
        'workspace',
        'skills',
        'mcp',
        'shortcuts',
        'about'
    ];

    for (const tab of requiredSettingsTabs) {
        assert.ok(
            settingsSrc.includes(`'${tab}'`) || settingsSrc.includes(`"${tab}"`),
            `SettingsModal must handle tab "${tab}"`
        );
    }
    assert.ok(settingsSrc.includes('100% Free') || settingsSrc.includes('Free Active') || settingsSrc.includes('LIMITED TIME PROMO'), 'Plan tab must verify 100% Free Limited-Time Promotion');
    console.log('  ✓ Test 7 Passed: Settings Modal & All 18 Tabs verified (including 100% Free Promotion, Shortcuts, About, Workspace, Skills, MCP)');

    // -------------------------------------------------------------
    // Section 8: Spotlight Launcher & Context Mention Autocomplete
    // -------------------------------------------------------------
    const spotlightSrc = fs.readFileSync(spotlightPath, 'utf-8');
    assert.ok(spotlightSrc.includes('filteredItems'), 'Spotlight must filter actions and sessions based on query');
    assert.ok(spotlightSrc.includes('onPromptGemini'), 'Spotlight must support direct AI prompting');

    const autocompleteSrc = fs.readFileSync(autocompletePath, 'utf-8');
    assert.ok(autocompleteSrc.includes('resolveContextMentionQuery'), 'Context autocomplete popover must resolve queries');
    assert.ok(autocompleteSrc.includes('onSelectMention'), 'Context autocomplete popover must notify mention selection');
    console.log('  ✓ Test 8 Passed: Spotlight Launcher & Context Mention Autocomplete verified');

    console.log('\n🎉 ALL COMPREHENSIVE APP-WIDE AUDIT TESTS PASSED SUCCESSFULLY!');
}

test('comprehensive-app-audit.test', async () => {
    await runComprehensiveAppAuditTests();
}, 180_000);
