/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import { ConversationDiffMemoryService } from '../src/node/conversation-diff-memory-service';

async function runMultiTurnDiffMemoryTestSuite() {
    console.log('🧪 Running Multi-Turn Conversation & Recent Diffs Memory Test Suite...');

    const diffMemory = new ConversationDiffMemoryService();

    // =========================================================================
    // SECTION 1: Turn Recording & Line Diff Calculations
    // =========================================================================
    console.log('\n--- Section 1: Turn Recording & Line Diffs ---');

    const turn1 = diffMemory.recordTurnEdits(
        'turn-1',
        [
            {
                filePath: 'src/components/Header.tsx',
                oldContent: 'export const Header = () => <header>Title</header>;',
                newContent: 'export const Header = () => (\n  <header className="main-header">\n    <h1>Title</h1>\n    <nav />\n  </header>\n);'
            }
        ],
        { userPrompt: 'Add nav and styling to Header component' }
    );

    assert.strictEqual(turn1.turnIndex, 1);
    assert.strictEqual(turn1.filesModified.length, 1);
    assert.strictEqual(turn1.filesModified[0].filePath, 'src/components/Header.tsx');
    assert.strictEqual(turn1.filesModified[0].changeType, 'modified');
    assert.ok(turn1.totalAdditions > 0);
    assert.ok(turn1.filesModified[0].hunks.length > 0);
    console.log('  ✓ Test 1.1 Passed: Turn recorded with structured line diffs and hunks');

    // =========================================================================
    // SECTION 2: Multi-Turn Cumulative File Evolution Lineage
    // =========================================================================
    console.log('\n--- Section 2: Multi-Turn File Evolution Lineage ---');

    // Turn 2 modifies Header again and adds a new file
    const turn2 = diffMemory.recordTurnEdits(
        'turn-2',
        [
            {
                filePath: 'src/components/Header.tsx',
                oldContent: 'export const Header = () => (\n  <header className="main-header">\n    <h1>Title</h1>\n    <nav />\n  </header>\n);',
                newContent: 'export const Header = () => (\n  <header className="main-header">\n    <h1>Scratchbox Studio</h1>\n    <nav className="nav-bar" />\n  </header>\n);'
            },
            {
                filePath: 'src/components/Nav.tsx',
                oldContent: '',
                newContent: 'export const Nav = () => <nav>Links</nav>;'
            }
        ],
        { userPrompt: 'Rename title to Scratchbox Studio and extract Nav component' }
    );

    assert.strictEqual(turn2.turnIndex, 2);
    assert.strictEqual(turn2.filesModified.length, 2);

    const lineage = diffMemory.getFileLineage('src/components/Header.tsx');
    assert.ok(lineage, 'Lineage for Header.tsx should exist');
    assert.strictEqual(lineage?.turnSnapshots.length, 2, 'Header should have 2 turn snapshots');
    assert.ok(lineage?.currentContent.includes('Scratchbox Studio'));
    assert.ok(lineage?.cumulativeAdditions! > 0);
    console.log('  ✓ Test 2.1 Passed: Multi-turn lineage accurately tracks sequential file transformations');

    // =========================================================================
    // SECTION 3: Live Uncommitted Working Changes Tracking
    // =========================================================================
    console.log('\n--- Section 3: Live Uncommitted Changes Tracking ---');

    diffMemory.recordUncommittedChange(
        'src/styles/theme.css',
        ':root { --color-bg: #fff; }',
        ':root { --color-bg: #121212; --color-accent: #007aff; }'
    );

    const uncommitted = diffMemory.getUncommittedDiffs();
    assert.strictEqual(uncommitted.length, 1);
    assert.strictEqual(uncommitted[0].filePath, 'src/styles/theme.css');
    assert.ok(uncommitted[0].additions > 0);
    console.log('  ✓ Test 3.1 Passed: Live uncommitted buffer edits detected and computed');

    // =========================================================================
    // SECTION 4: Prompt Context Block Synthesis
    // =========================================================================
    console.log('\n--- Section 4: Prompt Context Block Synthesis ---');

    const promptContext = diffMemory.buildDiffMemoryPromptContext({ maxTurns: 5 });

    assert.ok(promptContext.fullPromptSection.includes('CONVERSATION_DIFF_MEMORY'));
    assert.ok(promptContext.fullPromptSection.includes('Turn #1'));
    assert.ok(promptContext.fullPromptSection.includes('Turn #2'));
    assert.ok(promptContext.fullPromptSection.includes('Header.tsx'));
    assert.ok(promptContext.fullPromptSection.includes('PENDING UNCOMMITTED WORKING EDITS'));
    assert.ok(promptContext.fullPromptSection.includes('theme.css'));
    assert.ok(promptContext.activeFilesTouched.includes('src/components/Header.tsx'));
    assert.ok(promptContext.activeFilesTouched.includes('src/styles/theme.css'));
    console.log('  ✓ Test 4.1 Passed: Multi-turn diff memory synthesized into structured, high-reasoning prompt context');

    // Test clear
    diffMemory.clear();
    assert.strictEqual(diffMemory.getTurnHistory().length, 0);
    assert.strictEqual(diffMemory.getUncommittedDiffs().length, 0);
    console.log('  ✓ Test 4.2 Passed: Memory reset cleared all records');

    console.log('\n🎉 ALL MULTI-TURN CONVERSATION & DIFF MEMORY TESTS PASSED SUCCESSFULLY!');
}

runMultiTurnDiffMemoryTestSuite().catch(err => {
    console.error('Test Suite Failed:', err);
    process.exit(1);
});
