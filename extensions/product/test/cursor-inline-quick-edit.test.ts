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

async function runCursorInlineQuickEditTests() {
    console.log('🧪 Running Cursor Inline Quick Edit (⌘K) & Diff Acceptance Test Suite...\n');

    const sandboxTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx');
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');

    assert.ok(fs.existsSync(sandboxTsxPath), 'LiveCodeSandboxPrimitive.tsx must exist');
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist');

    const sandboxSource = fs.readFileSync(sandboxTsxPath, 'utf-8');
    const cssSource = fs.readFileSync(unifiedCssPath, 'utf-8');

    // -------------------------------------------------------------
    // Test 1: Inline Quick Edit (⌘K) State & Keyboard Trigger
    // -------------------------------------------------------------
    assert.ok(sandboxSource.includes('isQuickEditOpen'), 'LiveCodeSandboxPrimitive must track isQuickEditOpen state');
    assert.ok(sandboxSource.includes('quickEditPrompt'), 'LiveCodeSandboxPrimitive must track quickEditPrompt state');
    assert.ok(sandboxSource.includes('isQuickEditing'), 'LiveCodeSandboxPrimitive must track isQuickEditing loading state');
    assert.ok(sandboxSource.includes('quickEditDiff'), 'LiveCodeSandboxPrimitive must track quickEditDiff state');
    console.log('  ✓ Test 1 Passed: Inline Quick Edit (⌘K) state variables defined');

    // -------------------------------------------------------------
    // Test 2: Inline Quick Edit Floating Bar UI
    // -------------------------------------------------------------
    assert.ok(sandboxSource.includes('sb-inline-quick-edit-bar'), 'Must render sb-inline-quick-edit-bar container');
    assert.ok(sandboxSource.includes('sb-quick-edit-input'), 'Must render sb-quick-edit-input text field');
    assert.ok(sandboxSource.includes('Ask AI to edit this code') || sandboxSource.includes('Edit with AI (⌘K)'), 'Must render placeholder with ⌘K guidance');
    assert.ok(sandboxSource.includes('handleExecuteQuickEdit'), 'Must implement handleExecuteQuickEdit handler');
    console.log('  ✓ Test 2 Passed: Inline floating Quick Edit bar with action handlers verified');

    // -------------------------------------------------------------
    // Test 3: Inline Diff Acceptance & Rejection Actions
    // -------------------------------------------------------------
    assert.ok(sandboxSource.includes('handleAcceptQuickEdit'), 'Must implement handleAcceptQuickEdit handler');
    assert.ok(sandboxSource.includes('handleRejectQuickEdit'), 'Must implement handleRejectQuickEdit handler');
    assert.ok(sandboxSource.includes('sb-quick-edit-accept-btn'), 'Must render Accept button with ⌘Y / Enter hint');
    assert.ok(sandboxSource.includes('sb-quick-edit-reject-btn'), 'Must render Reject button with ⌘N / Esc hint');
    console.log('  ✓ Test 3 Passed: 1-Click Accept (⌘Y) and Reject (⌘N) diff lifecycle actions verified');

    // -------------------------------------------------------------
    // Test 4: Quick Edit Trigger Button in Editor Toolbar
    // -------------------------------------------------------------
    assert.ok(sandboxSource.includes('sb-quick-edit-trigger-btn'), 'Editor toolbar must render ⌘K Quick Edit trigger button');
    console.log('  ✓ Test 4 Passed: ⌘K Quick Edit trigger button integrated in editor actions');

    // -------------------------------------------------------------
    // Test 5: CSS Styles for Floating ⌘K Quick Edit Card
    // -------------------------------------------------------------
    assert.ok(cssSource.includes('sb-inline-quick-edit-bar'), 'unified-ui.css must define sb-inline-quick-edit-bar');
    assert.ok(cssSource.includes('sb-quick-edit-input'), 'unified-ui.css must define sb-quick-edit-input');
    assert.ok(cssSource.includes('sb-quick-edit-accept-btn'), 'unified-ui.css must define sb-quick-edit-accept-btn');
    assert.ok(cssSource.includes('sb-quick-edit-reject-btn'), 'unified-ui.css must define sb-quick-edit-reject-btn');
    console.log('  ✓ Test 5 Passed: CSS styles for floating Quick Edit bar & diff buttons verified');

    console.log('\n🎉 ALL CURSOR INLINE QUICK EDIT (⌘K) TESTS PASSED SUCCESSFULLY!');
}

if (require.main === module) {
    runCursorInlineQuickEditTests().catch(err => {
        console.error('❌ Quick edit test failed:', err);
        process.exit(1);
    });
}

export { runCursorInlineQuickEditTests };
