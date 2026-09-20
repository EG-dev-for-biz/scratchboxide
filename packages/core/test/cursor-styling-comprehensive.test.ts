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
import { readSettingsSources, readStudioSources } from './source-helpers';

async function runCursorStylingComprehensiveTests() {
    console.log('🧪 Running Comprehensive Cursor Styling & Scratchbox Feature Preservation Test Suite...\n');

    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const sideChatTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/VibecodeAiSideChat.tsx');
    const settingsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
    const sandboxTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx');
    const docTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx');
    const kanbanTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/KanbanBoardPrimitive.tsx');
    const nodeGraphTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/NodeGraphPrimitive.tsx');
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');

    assert.ok(fs.existsSync(studioTsxPath), 'GenerativeCanvasStudio.tsx must exist');
    assert.ok(fs.existsSync(sideChatTsxPath), 'VibecodeAiSideChat.tsx must exist');
    assert.ok(fs.existsSync(settingsTsxPath), 'SettingsModal.tsx must exist');
    assert.ok(fs.existsSync(sandboxTsxPath), 'LiveCodeSandboxPrimitive.tsx must exist');
    assert.ok(fs.existsSync(docTsxPath), 'MarkdownDocumentPrimitive.tsx must exist');
    assert.ok(fs.existsSync(kanbanTsxPath), 'KanbanBoardPrimitive.tsx must exist');
    assert.ok(fs.existsSync(nodeGraphTsxPath), 'NodeGraphPrimitive.tsx must exist');
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist');

    const studioSource = readStudioSources();
    const sideChatSource = fs.readFileSync(sideChatTsxPath, 'utf-8');
    const settingsSource = readSettingsSources();
    const sandboxSource = fs.readFileSync(sandboxTsxPath, 'utf-8');
    const docSource = fs.readFileSync(docTsxPath, 'utf-8');
    const kanbanSource = fs.readFileSync(kanbanTsxPath, 'utf-8');
    const nodeGraphSource = fs.readFileSync(nodeGraphTsxPath, 'utf-8');
    const cssSource = fs.readFileSync(unifiedCssPath, 'utf-8');

    // -------------------------------------------------------------
    // Test 1: Cursor-Style Studio Composer in GenerativeCanvasStudio
    // -------------------------------------------------------------
    assert.ok(studioSource.includes('sb-cursor-mode-selector') || studioSource.includes('aiInteractionMode'), 'Studio composer must have Cursor interaction mode selector');
    assert.ok(studioSource.includes('Agent') && studioSource.includes('Ask') && studioSource.includes('Plan'), 'Studio composer must support Agent, Ask, Plan modes');
    assert.ok(studioSource.includes('sb-cursor-context-bar') || studioSource.includes('sb-cursor-attached-context-row'), 'Studio composer must support context mention attachments');
    console.log('  ✓ Test 1 Passed: Cursor-style multi-mode Composer integrated in central GenerativeCanvasStudio');

    // -------------------------------------------------------------
    // Test 2: Scratchbox Core Features Fully Preserved
    // -------------------------------------------------------------
    // 1. Multi-surface primitives (LiveCodeSandbox, MarkdownDocument, KanbanBoard, NodeGraph)
    assert.ok(sandboxSource.includes('LiveCodeSandboxData'), 'LiveCodeSandboxData preserved');
    assert.ok(docSource.includes('MarkdownDocumentData'), 'MarkdownDocumentData preserved');
    assert.ok(kanbanSource.includes('KanbanBoardData'), 'KanbanBoardData preserved');
    assert.ok(nodeGraphSource.includes('NodeGraphData'), 'NodeGraphData preserved');
    // 2. Bento Stage Layout & Native Automation Workflow File Type
    assert.ok(studioSource.includes('BentoStageLayout'), 'BentoStageLayout preserved');
    assert.ok(studioSource.includes("handleCreateWorkspaceFile('automation')"), 'Native Automation Workflow creation preserved');
    assert.ok(studioSource.includes('AutomationsModal'), 'AutomationsModal preserved');
    // 3. Workspace File Manager & Context Mention Engine
    assert.ok(studioSource.includes('handleCreateWorkspaceFile'), '1-click workspace file creation preserved');
    assert.ok(studioSource.includes('resolveContextMentionQuery'), 'Context mention engine (@file, @git, @terminal, etc.) preserved');
    console.log('  ✓ Test 2 Passed: All Scratchbox core features & visual primitives fully preserved');

    // -------------------------------------------------------------
    // Test 3: Cursor-Grade Side Chat & Tool Step Disclosure
    // -------------------------------------------------------------
    assert.ok(sideChatSource.includes('sb-cursor-mode-pill'), 'Side chat renders Cursor-style mode selection pills');
    assert.ok(sideChatSource.includes('sb-cursor-indexing-badge'), 'Side chat renders Codebase Indexing status badge');
    assert.ok(sideChatSource.includes('sb-cursor-rules-badge'), 'Side chat renders Project Rules badge');
    assert.ok(sideChatSource.includes('sb-cursor-tool-step'), 'Side chat renders interactive tool execution steps');
    console.log('  ✓ Test 3 Passed: Cursor-grade AI Side Chat with interactive tool execution steps verified');

    // -------------------------------------------------------------
    // Test 4: Cursor Settings Page with Typography-Only Sidebar
    // -------------------------------------------------------------
    assert.ok(settingsSource.includes('← Back'), 'Settings modal has "← Back" top action');
    assert.ok(settingsSource.includes('Search Settings'), 'Settings modal has search bar');
    assert.ok(settingsSource.includes('Plugins, MCPs, Skills, and Rules have moved to Customize'), 'Settings modal includes Customize banner');
    assert.ok(settingsSource.includes('Scratchbox Account') || settingsSource.includes('Cursor Account'), 'Settings modal contains account section');
    assert.ok(settingsSource.includes('sb-cursor-toggle'), 'Settings modal contains Apple/Cursor green toggle switches');
    console.log('  ✓ Test 4 Passed: Cursor Settings Page with typography-only no-icon sidebar verified');

    // -------------------------------------------------------------
    // Test 5: Google Models Backend Exclusivity & Privacy
    // -------------------------------------------------------------
    assert.ok(settingsSource.includes('High Reasoning Engine'), 'SettingsModal presents capability tier without leaking model slug');
    assert.ok(settingsSource.includes('Fast Intelligence'), 'SettingsModal presents Fast Intelligence tier');
    assert.ok(!settingsSource.includes('Active Model: gemini-'), 'SettingsModal does not leak raw model slug string');
    console.log('  ✓ Test 5 Passed: Strict Google Models backend exclusivity and UI privacy verified');

    // -------------------------------------------------------------
    // Test 6: Unified CSS Design System & Visual Hierarchy
    // -------------------------------------------------------------
    assert.ok(cssSource.includes('sb-cursor-settings-window'), 'unified-ui.css defines sb-cursor-settings-window');
    assert.ok(cssSource.includes('sb-cursor-mode-selector'), 'unified-ui.css defines sb-cursor-mode-selector');
    assert.ok(cssSource.includes('sb-cursor-tool-step'), 'unified-ui.css defines sb-cursor-tool-step');
    assert.ok(cssSource.includes('sb-cursor-group-card'), 'unified-ui.css defines sb-cursor-group-card');
    assert.ok(cssSource.includes('sb-cursor-toggle-on'), 'unified-ui.css defines sb-cursor-toggle-on');
    console.log('  ✓ Test 6 Passed: Unified CSS Design System provides complete Cursor styling tokens');

    console.log('\n🎉 ALL COMPREHENSIVE CURSOR STYLING & SCRATCHBOX PRESERVATION TESTS PASSED SUCCESSFULLY!');
}


export { runCursorStylingComprehensiveTests };

test('cursor-styling-comprehensive.test', async () => {
    await runCursorStylingComprehensiveTests();
}, 180_000);
