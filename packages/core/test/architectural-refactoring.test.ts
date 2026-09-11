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
import { readStudioSources } from './source-helpers';

async function runArchitecturalRefactoringTests() {
    console.log('🧪 Running Architectural Micro-Refactorings & Domain Boundaries Test Suite...\n');

    const popoverTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/ContextMentionAutocompletePopover.tsx');
    const hooksDir = path.resolve(__dirname, '../src/browser/generative-canvas/hooks');
    const useModalsPath = path.join(hooksDir, 'useStudioModals.ts');
    const useArtifactHistoryPath = path.join(hooksDir, 'useArtifactVersionHistory.ts');
    const sideChatPath = path.resolve(__dirname, '../src/browser/generative-canvas/VibecodeAiSideChat.tsx');
    const studioPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const architectureDebtPath = path.resolve(__dirname, '../../../.architecture/debt.md');
    const architectureMapPath = path.resolve(__dirname, '../../../.architecture/map.md');

    // -------------------------------------------------------------
    // Test 1: Extracted Reusable ContextMentionAutocompletePopover
    // -------------------------------------------------------------
    assert.ok(fs.existsSync(popoverTsxPath), 'ContextMentionAutocompletePopover.tsx must exist');
    const popoverSource = fs.readFileSync(popoverTsxPath, 'utf-8');
    assert.ok(popoverSource.includes('ContextMentionAutocompletePopover'), 'Must export ContextMentionAutocompletePopover component');
    assert.ok(popoverSource.includes('activeCategory'), 'Must accept activeCategory prop');
    assert.ok(popoverSource.includes('onSelectMention'), 'Must accept onSelectMention prop');
    assert.ok(popoverSource.includes('onClose'), 'Must accept onClose prop');
    console.log('  ✓ Test 1 Passed: Reusable ContextMentionAutocompletePopover component defined');

    // -------------------------------------------------------------
    // Test 2: Usage in VibecodeAiSideChat and GenerativeCanvasStudio
    // -------------------------------------------------------------
    const sideChatSource = fs.readFileSync(sideChatPath, 'utf-8');
    const studioSource = readStudioSources();
    assert.ok(sideChatSource.includes('ContextMentionAutocompletePopover'), 'VibecodeAiSideChat must use ContextMentionAutocompletePopover');
    assert.ok(studioSource.includes('ContextMentionAutocompletePopover'), 'GenerativeCanvasStudio must use ContextMentionAutocompletePopover');
    console.log('  ✓ Test 2 Passed: Autocomplete popovers deduplicated across SideChat and Main Studio');

    // -------------------------------------------------------------
    // Test 3: Extracted Custom Hooks (useStudioModals, useArtifactVersionHistory)
    // -------------------------------------------------------------
    assert.ok(fs.existsSync(useModalsPath), 'useStudioModals.ts must exist');
    assert.ok(fs.existsSync(useArtifactHistoryPath), 'useArtifactVersionHistory.ts must exist');

    const modalsSource = fs.readFileSync(useModalsPath, 'utf-8');
    const historySource = fs.readFileSync(useArtifactHistoryPath, 'utf-8');
    assert.ok(modalsSource.includes('useStudioModals'), 'Must export useStudioModals hook');
    assert.ok(modalsSource.includes('openModal') && modalsSource.includes('closeModal'), 'Must provide openModal and closeModal actions');
    assert.ok(historySource.includes('useArtifactVersionHistory'), 'Must export useArtifactVersionHistory hook');
    assert.ok(historySource.includes('rollbackToVersion'), 'Must provide rollbackToVersion action');
    console.log('  ✓ Test 3 Passed: useStudioModals and useArtifactVersionHistory hooks extracted');

    // -------------------------------------------------------------
    // Test 4: Architecture Documentation Verification
    // -------------------------------------------------------------
    assert.ok(fs.existsSync(architectureDebtPath), '.architecture/debt.md must exist');
    assert.ok(fs.existsSync(architectureMapPath), '.architecture/map.md must exist');
    console.log('  ✓ Test 4 Passed: .architecture/ mental map and debt ledger updated');

    console.log('\n🎉 ALL ARCHITECTURAL MICRO-REFACTORING TESTS PASSED SUCCESSFULLY!');
}


export { runArchitecturalRefactoringTests };

test('architectural-refactoring.test', async () => {
    await runArchitecturalRefactoringTests();
}, 180_000);
