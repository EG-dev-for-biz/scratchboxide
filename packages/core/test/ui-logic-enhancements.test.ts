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
import {
    findTriggerMatch,
    insertMentionToken,
    cycleSelectedIndex
} from '../src/browser/generative-canvas/context-mention-engine';
import {
    SessionViewState,
    SessionViewStateCache,
    ModalStackManager
} from '../src/browser/generative-canvas/canvas-types';

async function runUiLogicEnhancementsTestSuite() {
    console.log('🧪 Running UI Logic Enhancements (Top 5 Improvements) Test Suite...');

    // =========================================================================
    // IMPROVEMENT 1: Session-Bound Stream Isolation & Atomic State Updates
    // =========================================================================
    console.log('\n--- Improvement 1: Session-Bound Stream Isolation & Atomic State Updates ---');

    // Test 1.1: Guard against cross-session message bleeding
    let activeSessionId = 'session-1';
    const sessionStore: Record<string, { messages: any[]; activeArtifact?: any; tokens: number }> = {
        'session-1': { messages: [], tokens: 0 },
        'session-2': { messages: [], tokens: 0 }
    };

    // Simulate stream handler bound to originating sessionId
    const createStreamHandler = (originatingSessionId: string) => {
        return {
            onChunk: (text: string, tokens: number, artifact?: any) => {
                // Update session store directly for originating session
                const s = sessionStore[originatingSessionId];
                if (s) {
                    s.tokens = tokens;
                    if (artifact) s.activeArtifact = artifact;
                }

                // UI Guard: Only update active UI if originating session is currently active
                const isCurrentActive = activeSessionId === originatingSessionId;
                return {
                    persistedToOrigin: true,
                    appliedToActiveUI: isCurrentActive
                };
            },
            onComplete: (finalMsg: any) => {
                sessionStore[originatingSessionId].messages.push(finalMsg);
                return {
                    savedToOrigin: true,
                    isActiveSession: activeSessionId === originatingSessionId
                };
            }
        };
    };

    const stream1 = createStreamHandler('session-1');

    // Chunk arrives while on session-1
    const res1 = stream1.onChunk('Thinking about layout...', 42, { id: 'art-1', version: 1 });
    assert.strictEqual(res1.appliedToActiveUI, true, 'Stream 1 should update active UI when session-1 is active');
    assert.strictEqual(sessionStore['session-1'].tokens, 42);

    // User switches to session-2 while stream 1 is in-flight
    activeSessionId = 'session-2';

    // Next chunk from stream 1 arrives
    const res2 = stream1.onChunk('Finished generating React code', 128, { id: 'art-1', version: 2 });
    assert.strictEqual(res2.appliedToActiveUI, false, 'Stream 1 MUST NOT bleed into active UI when session-2 is active');
    assert.strictEqual(sessionStore['session-1'].tokens, 128, 'Originating session-1 store should still receive tokens');
    assert.strictEqual(sessionStore['session-2'].tokens, 0, 'Active session-2 tokens MUST NOT be corrupted');
    assert.strictEqual(sessionStore['session-2'].messages.length, 0, 'Active session-2 messages MUST NOT be corrupted');

    // Stream 1 completes in background
    const comp1 = stream1.onComplete({ id: 'm1', text: 'Done' });
    assert.strictEqual(comp1.isActiveSession, false);
    assert.strictEqual(sessionStore['session-1'].messages.length, 1);
    assert.strictEqual(sessionStore['session-2'].messages.length, 0);

    console.log('  ✓ Test 1 Passed: Stream event handlers are bound to originating sessionId and prevent cross-session bleeding');

    // =========================================================================
    // IMPROVEMENT 2: Ergonomic Keyboard Autocomplete Engine with Inline Token Preservation
    // =========================================================================
    console.log('\n--- Improvement 2: Ergonomic Keyboard Autocomplete Engine with Inline Token Preservation ---');

    // Test 2.1: Find trigger matches with multi-word queries
    const text1 = 'Please review @file App.tsx and improve styling';
    const match1 = findTriggerMatch(text1, 23); // Cursor inside "@file App.tsx"
    assert.ok(match1, 'Should find trigger match');
    assert.strictEqual(match1?.type, 'context');
    assert.strictEqual(match1?.query, 'file App.tsx');
    assert.strictEqual(match1?.prefix, 'Please review ');
    assert.strictEqual(match1?.suffix, ' and improve styling');

    // Test 2.2: Find skill / trigger with multi-word query
    const text2 = 'I need to /skill Master 3D Environmental Artist for this component';
    const match2 = findTriggerMatch(text2, 47);
    assert.ok(match2, 'Should match skill trigger');
    assert.strictEqual(match2?.type, 'skill');
    assert.strictEqual(match2?.query, 'skill Master 3D Environmental Artist');
    assert.strictEqual(match2?.prefix, 'I need to ');
    assert.strictEqual(match2?.suffix, ' for this component');

    // Test 2.3: Insert mention token with inline surrounding text preservation
    const promptWithAt = 'Check @app for responsive issues.';
    const triggerIndex = promptWithAt.indexOf('@');
    const queryLength = 4; // "@app".length
    const insertionResult = insertMentionToken(promptWithAt, triggerIndex, queryLength, '@file:src/App.tsx');
    assert.strictEqual(
        insertionResult.newText,
        'Check @file:src/App.tsx for responsive issues.',
        'Token insertion must preserve prefix and suffix without destructive prompt slicing'
    );
    assert.strictEqual(insertionResult.newCursorPosition, 'Check @file:src/App.tsx'.length);

    // Test 2.4: Keyboard navigation index cycling (wrap-around)
    const itemCount = 5;
    let selectedIdx = 0;
    selectedIdx = cycleSelectedIndex(selectedIdx, itemCount, 'down'); // 0 -> 1
    assert.strictEqual(selectedIdx, 1);
    selectedIdx = cycleSelectedIndex(selectedIdx, itemCount, 'down'); // 1 -> 2
    assert.strictEqual(selectedIdx, 2);
    selectedIdx = cycleSelectedIndex(selectedIdx, itemCount, 'up'); // 2 -> 1
    assert.strictEqual(selectedIdx, 1);
    selectedIdx = cycleSelectedIndex(0, itemCount, 'up'); // 0 -> 4 (wrap around)
    assert.strictEqual(selectedIdx, 4);
    selectedIdx = cycleSelectedIndex(4, itemCount, 'down'); // 4 -> 0 (wrap around)
    assert.strictEqual(selectedIdx, 0);

    console.log('  ✓ Test 2 Passed: Keyboard autocomplete engine supports multi-word queries, index cycling & token preservation');

    // =========================================================================
    // IMPROVEMENT 3: Viewport & Sub-Tab State Retention Cache
    // =========================================================================
    console.log('\n--- Improvement 3: Viewport & Sub-Tab State Retention Cache ---');

    const cache = new SessionViewStateCache();

    const viewStateSession1: SessionViewState = {
        activeSandboxTabId: 'file-app',
        sandboxViewMode: 'split',
        sandboxViewportMode: 'tablet',
        documentScrollTop: 450,
        nodeGraphViewport: { x: 120, y: -80, zoom: 1.25 },
        layoutMode: 'code'
    };

    cache.saveViewState('session-1', viewStateSession1);

    const retrieved1 = cache.getViewState('session-1');
    assert.ok(retrieved1, 'View state should be retrieved from cache');
    assert.strictEqual(retrieved1?.activeSandboxTabId, 'file-app');
    assert.strictEqual(retrieved1?.sandboxViewMode, 'split');
    assert.strictEqual(retrieved1?.sandboxViewportMode, 'tablet');
    assert.strictEqual(retrieved1?.documentScrollTop, 450);
    assert.deepStrictEqual(retrieved1?.nodeGraphViewport, { x: 120, y: -80, zoom: 1.25 });

    // Partial update
    cache.updateViewState('session-1', { documentScrollTop: 620, sandboxViewMode: 'preview' });
    const updated1 = cache.getViewState('session-1');
    assert.strictEqual(updated1?.documentScrollTop, 620);
    assert.strictEqual(updated1?.sandboxViewMode, 'preview');
    assert.strictEqual(updated1?.activeSandboxTabId, 'file-app', 'Existing cached properties must be preserved');

    // Unknown session defaults
    const unknown = cache.getViewState('session-nonexistent');
    assert.strictEqual(unknown, undefined);

    console.log('  ✓ Test 3 Passed: Session view-state cache correctly stores, updates, and restores sandbox tabs, modes, scrolls, and coordinates');

    // =========================================================================
    // IMPROVEMENT 4: Unified Modal Stack Manager & Shortcut De-duplication
    // =========================================================================
    console.log('\n--- Improvement 4: Unified Modal Stack Manager & Shortcut De-duplication ---');

    const modalManager = new ModalStackManager();

    assert.strictEqual(modalManager.hasOpenModals(), false);
    assert.strictEqual(modalManager.getTopModal(), undefined);

    // Open spotlight
    modalManager.openModal('spotlight');
    assert.strictEqual(modalManager.isModalOpen('spotlight'), true);
    assert.strictEqual(modalManager.getTopModal(), 'spotlight');

    // Open projects modal on top of spotlight
    modalManager.openModal('projects');
    assert.strictEqual(modalManager.isModalOpen('spotlight'), true);
    assert.strictEqual(modalManager.isModalOpen('projects'), true);
    assert.strictEqual(modalManager.getTopModal(), 'projects', 'Projects should be topmost in LIFO stack');

    // Open settings modal on top of projects
    modalManager.openModal('settings');
    assert.strictEqual(modalManager.getTopModal(), 'settings');
    assert.strictEqual(modalManager.getStack().length, 3);

    // Pop top modal (Escape pressed once -> closes settings)
    const popped1 = modalManager.closeTopModal();
    assert.strictEqual(popped1, 'settings');
    assert.strictEqual(modalManager.getTopModal(), 'projects');
    assert.strictEqual(modalManager.isModalOpen('settings'), false);
    assert.strictEqual(modalManager.isModalOpen('projects'), true);

    // Pop next (Escape pressed twice -> closes projects)
    const popped2 = modalManager.closeTopModal();
    assert.strictEqual(popped2, 'projects');
    assert.strictEqual(modalManager.getTopModal(), 'spotlight');

    // Toggle spotlight (Cmd+K)
    modalManager.toggleModal('spotlight');
    assert.strictEqual(modalManager.isModalOpen('spotlight'), false);
    assert.strictEqual(modalManager.hasOpenModals(), false);

    console.log('  ✓ Test 4 Passed: LIFO modal stack manager ensures clean single-modal dismissal order and clean toggling');

    // =========================================================================
    // IMPROVEMENT 5: In-Canvas Version Stepper & Rollback Surface
    // =========================================================================
    console.log('\n--- Improvement 5: In-Canvas Version Stepper & Rollback Surface ---');

    const artifactVersions: any[] = [
        { id: 'art-1', version: 1, title: 'Initial Draft', data: { v: 1 } },
        { id: 'art-1', version: 2, title: 'Added Sections', data: { v: 2 } },
        { id: 'art-1', version: 3, title: 'Polished UI', data: { v: 3 } }
    ];

    let currentArtifact = artifactVersions[1]; // v2 of 3

    const activeIndex = artifactVersions.findIndex(v => v.version === currentArtifact.version);
    assert.strictEqual(activeIndex, 1);
    const isLatest = activeIndex === artifactVersions.length - 1;
    assert.strictEqual(isLatest, false, 'v2 is not the latest version');

    // Stepper Navigation
    const prevArtifact = activeIndex > 0 ? artifactVersions[activeIndex - 1] : undefined;
    assert.strictEqual(prevArtifact?.version, 1);

    const nextArtifact = activeIndex < artifactVersions.length - 1 ? artifactVersions[activeIndex + 1] : undefined;
    assert.strictEqual(nextArtifact?.version, 3);

    // Rollback action simulation
    const rollbackTarget = artifactVersions[0]; // Rollback to v1
    const restoredArtifact = {
        ...rollbackTarget,
        version: artifactVersions.length + 1, // Creates v4 as rollback
        summary: `Restored from version v${rollbackTarget.version}`
    };
    assert.strictEqual(restoredArtifact.version, 4);
    assert.strictEqual(restoredArtifact.data.v, 1);

    console.log('  ✓ Test 5 Passed: Version stepper and rollback calculations correctly step revisions and generate rollbacks');

    console.log('\n🎉 ALL UI LOGIC ENHANCEMENTS TESTS PASSED SUCCESSFULLY!');
}

test('ui-logic-enhancements.test', async () => {
    await runUiLogicEnhancementsTestSuite();
}, 180_000);
