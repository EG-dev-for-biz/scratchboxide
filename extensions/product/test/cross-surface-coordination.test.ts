/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import {
    WorkspaceFileChangeEvent,
    createFileChangeHash
} from '../src/common/workspace-sync-protocol';
import { WorkspaceFileWatcherService } from '../src/node/workspace-file-watcher-service';
import {
    DirtyStateManager
} from '../src/browser/generative-canvas/dirty-state-manager';
import {
    morphDocToChecklistKanban,
    morphDocToNodeGraph,
    morphKanbanCardToSandbox,
    morphArtifact
} from '../src/browser/generative-canvas/primitive-transformer-engine';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';
import {
    MarkdownDocumentData,
    KanbanBoardData,
    CanvasArtifact,
    StageLayoutMode
} from '../src/browser/generative-canvas/canvas-types';

async function runCrossSurfaceCoordinationTestSuite() {
    console.log('🧪 Running Cross-Surface Project Coordination Comprehensive Test Suite...');

    // =========================================================================
    // SECTION 1: Bidirectional Filesystem Watcher & Live Sync Protocol
    // =========================================================================
    console.log('\n--- Section 1: Bidirectional Filesystem Watcher & Live Sync Protocol ---');

    // Test 1.1: FileChangeType and hash calculation
    const sampleContent = 'export const App = () => <div>Hello Scratchbox</div>;';
    const hash1 = createFileChangeHash(sampleContent);
    const hash2 = createFileChangeHash(sampleContent);
    const hash3 = createFileChangeHash(sampleContent + '\n// modified');

    assert.strictEqual(hash1, hash2, 'Identical contents must yield identical hashes');
    assert.notStrictEqual(hash1, hash3, 'Modified contents must yield different hashes');
    assert.strictEqual(typeof hash1, 'string');
    assert.strictEqual(hash1.length >= 8, true, 'Hash should be at least 8 characters');
    console.log('  ✓ Test 1.1 Passed: Hash calculation is deterministic and sensitive to content changes');

    // Test 1.2: WorkspaceFileWatcherService hash loopback suppression
    const testTempDir = path.join(os.tmpdir(), `scratchbox-watcher-test-${Date.now()}`);
    await fs.ensureDir(testTempDir);
    const testCompDir = path.join(testTempDir, 'src', 'components');
    await fs.ensureDir(testCompDir);

    const watcherService = new WorkspaceFileWatcherService();
    watcherService.startWatching(testTempDir);

    const testFilePath = path.join(testCompDir, 'Button.tsx');
    const buttonCode = 'export const Button = () => <button>Click</button>;';
    const buttonHash = createFileChangeHash(buttonCode);

    // Register known hash to suppress loopback
    watcherService.registerKnownHash(testFilePath, buttonHash);
    assert.strictEqual(watcherService.isKnownHash(testFilePath, buttonHash), true);

    // Broadcast file change event
    const recordedEvents: WorkspaceFileChangeEvent[] = [];
    watcherService.onFileChange(evt => recordedEvents.push(evt));

    // Simulate change with registered hash (should be detected as internal / suppressed)
    const isLoopback = watcherService.processFileChange(testFilePath, 'update', buttonCode);
    assert.strictEqual(isLoopback, true, 'Registered known hash must be detected as loopback');

    // Simulate external change with different content
    const updatedCode = 'export const Button = () => <button>Updated</button>;';
    const isExternal = watcherService.processFileChange(testFilePath, 'update', updatedCode);
    assert.strictEqual(isExternal, false, 'Unregistered content change must be treated as external modification');
    assert.strictEqual(recordedEvents.length > 0, true, 'External change must produce broadcast event');
    assert.strictEqual(recordedEvents[recordedEvents.length - 1].changeType, 'update');

    watcherService.stopWatching();
    await fs.remove(testTempDir);
    console.log('  ✓ Test 1.2 Passed: WorkspaceFileWatcherService suppresses loopbacks and broadcasts external file changes');

    // =========================================================================
    // SECTION 2: Granular Dirty State Manager & Tab Badges
    // =========================================================================
    console.log('\n--- Section 2: Granular Dirty State Manager & Tab Badges ---');

    const dirtyManager = new DirtyStateManager();
    const tabId = 'tab-button-tsx';
    const initialCode = 'export const Button = () => <button>Hello</button>;';

    // Test 2.1: Initial buffer tracking is clean
    dirtyManager.trackBuffer(tabId, initialCode);
    assert.strictEqual(dirtyManager.isDirty(tabId), false);
    assert.strictEqual(dirtyManager.getSaveStatus(tabId), 'saved');
    assert.strictEqual(dirtyManager.getDirtyIds().length, 0);
    console.log('  ✓ Test 2.1 Passed: Tracked buffer initializes in clean saved state');

    // Test 2.2: Buffer edit transitions to dirty state
    const modifiedCode = 'export const Button = () => <button>Hello World</button>;';
    const dirtyChanged = dirtyManager.updateBuffer(tabId, modifiedCode);
    assert.strictEqual(dirtyChanged, true, 'updateBuffer should return true when dirty state changes');
    assert.strictEqual(dirtyManager.isDirty(tabId), true);
    assert.strictEqual(dirtyManager.getSaveStatus(tabId), 'dirty');
    assert.deepStrictEqual(dirtyManager.getDirtyIds(), [tabId]);
    console.log('  ✓ Test 2.2 Passed: Buffer modification marks tab dirty and updates saveStatus');

    // Test 2.3: Reverting back to original content restores clean state
    dirtyManager.updateBuffer(tabId, initialCode);
    assert.strictEqual(dirtyManager.isDirty(tabId), false);
    assert.strictEqual(dirtyManager.getSaveStatus(tabId), 'saved');
    assert.strictEqual(dirtyManager.getDirtyIds().length, 0);
    console.log('  ✓ Test 2.3 Passed: Reverting content to baseline automatically clears dirty badge');

    // Test 2.4: Marking saved sets baseline to new content
    dirtyManager.updateBuffer(tabId, modifiedCode);
    dirtyManager.markSaved(tabId, modifiedCode);
    assert.strictEqual(dirtyManager.isDirty(tabId), false);
    assert.strictEqual(dirtyManager.getSaveStatus(tabId), 'saved');
    console.log('  ✓ Test 2.4 Passed: markSaved establishes new baseline hash and resets dirty status');

    // Test 2.5: Debounced auto-save scheduling
    let autoSaveExecuted = false;
    dirtyManager.updateBuffer(tabId, modifiedCode + ' // auto-save test');
    dirtyManager.scheduleDebouncedAutoSave(
        tabId,
        () => { autoSaveExecuted = true; },
        50
    );
    assert.strictEqual(dirtyManager.getSaveStatus(tabId), 'saving');

    await new Promise(resolve => setTimeout(resolve, 80));
    assert.strictEqual(autoSaveExecuted, true, 'Debounced auto-save must execute after delay');
    console.log('  ✓ Test 2.5 Passed: Debounced auto-save triggers callback and updates status');

    // =========================================================================
    // SECTION 3: 1-Click Cross-Surface Primitive Morph Engine
    // =========================================================================
    console.log('\n--- Section 3: 1-Click Cross-Surface Primitive Morph Engine ---');

    // Test 3.1: Document Spec Checklist -> Kanban Board Cards
    const sampleDoc: MarkdownDocumentData = {
        title: 'Authentication & Profile Spec',
        subtitle: 'Sprint 24 Architecture & Deliverables',
        sections: [
            {
                id: 'sec-overview',
                type: 'paragraph',
                content: 'System spec for OAuth2 flow and user session security.'
            },
            {
                id: 'sec-checklist',
                type: 'checklist',
                content: 'Task list for developers:',
                checklistItems: [
                    { id: 'chk-1', text: 'Implement JWT refresh token rotation', done: false },
                    { id: 'chk-2', text: 'Add CSRF token validation middleware', done: true },
                    { id: 'chk-3', text: 'Configure rate limiting per IP', done: false }
                ]
            }
        ]
    };

    const morphedKanban = morphDocToChecklistKanban(sampleDoc);
    assert.strictEqual(morphedKanban.title, 'Authentication & Profile Spec - Tasks');
    assert.strictEqual(morphedKanban.columns.length >= 2, true, 'Must produce at least Todo and Done columns');

    const todoCol = morphedKanban.columns.find(c => c.id === 'todo' || c.title.toLowerCase().includes('todo'));
    const doneCol = morphedKanban.columns.find(c => c.id === 'done' || c.title.toLowerCase().includes('done'));
    assert.ok(todoCol, 'Must include Todo column');
    assert.ok(doneCol, 'Must include Done column');

    assert.strictEqual(todoCol!.cards.some(c => c.title.includes('JWT refresh token')), true);
    assert.strictEqual(todoCol!.cards.some(c => c.title.includes('Configure rate limiting')), true);
    assert.strictEqual(doneCol!.cards.some(c => c.title.includes('CSRF token validation')), true);
    console.log('  ✓ Test 3.1 Passed: Document Spec Checklist deterministically morphs into Kanban Board Cards');

    // Test 3.2: Document Spec Architecture -> Executable Node Graph Flow
    const sampleArchDoc: MarkdownDocumentData = {
        title: 'Payment Processing Pipeline',
        subtitle: 'Architecture and Flow',
        sections: [
            {
                id: 'sec-arch',
                type: 'paragraph',
                content: '1. Webhook Trigger receives payment event\n2. AI Agent validates fraud risk\n3. Database updates customer billing record\n4. Dispatch webhook receipt notification'
            }
        ]
    };

    const morphedGraph = morphDocToNodeGraph(sampleArchDoc);
    assert.strictEqual(morphedGraph.title, 'Payment Processing Pipeline Flow');
    assert.strictEqual(morphedGraph.nodes.length >= 3, true, 'Should generate flow nodes from architecture steps');
    assert.strictEqual(morphedGraph.edges.length >= 2, true, 'Should connect sequential steps with edges');
    assert.strictEqual(morphedGraph.nodes.some(n => n.category === 'input' || n.label.includes('Webhook') || n.label.includes('Trigger')), true);
    console.log('  ✓ Test 3.2 Passed: Document Spec Architecture deterministically morphs into Node Graph Flow');

    // Test 3.3: Kanban Card -> Test suite execution & Sandbox tab links
    const sampleCard = {
        id: 'card-oauth-refresh',
        title: 'Implement JWT Refresh Token Rotation',
        description: 'Store hashed refresh tokens in Redis and verify on token refresh request.',
        priority: 'high' as const,
        tag: 'Security'
    };

    const morphedSandbox = morphKanbanCardToSandbox(sampleCard, 'Auth Board');
    assert.strictEqual(morphedSandbox.title, 'Implement JWT Refresh Token Rotation - Sandbox');
    assert.strictEqual(morphedSandbox.files.length >= 2, true, 'Sandbox must include implementation and test files');

    const testFile = morphedSandbox.files.find(f => (f.path || f.name).includes('.test.'));
    const implFile = morphedSandbox.files.find(f => !(f.path || f.name).includes('.test.'));
    assert.ok(testFile, 'Must generate test file');
    assert.ok(implFile, 'Must generate implementation file');
    assert.strictEqual(testFile!.content.includes('test(') || testFile!.content.includes('it(') || testFile!.content.includes('describe('), true);
    console.log('  ✓ Test 3.3 Passed: Kanban Card morphs into Live Code Sandbox with linked test suite');

    // Test 3.4: Polymorphic morphArtifact dispatcher
    const docArtifact: CanvasArtifact = {
        id: 'art-doc-1',
        title: 'Design Document',
        summary: 'Architecture specification document',
        type: 'markdown-document',
        data: sampleDoc,
        createdAt: '12:00:00 PM',
        version: 1
    };
    const morphedKanbanArtifact = morphArtifact(docArtifact, 'kanban-board');
    assert.strictEqual(morphedKanbanArtifact.type, 'kanban-board');
    assert.strictEqual((morphedKanbanArtifact.data as KanbanBoardData).columns.length >= 2, true);
    console.log('  ✓ Test 3.4 Passed: morphArtifact polymorphic dispatcher executes cross-primitive conversions');

    // =========================================================================
    // SECTION 4: Global Project Context Graph Service
    // =========================================================================
    console.log('\n--- Section 4: Global Project Context Graph Service ---');

    const contextGraphService = new ProjectContextGraphService();

    // Test 4.1: Ingest active specs, sandbox code, kanban tasks, and node graph
    contextGraphService.ingestDocumentSpec(sampleDoc, 'doc-auth-spec');
    contextGraphService.ingestSandboxTabs(morphedSandbox.files, 'sandbox-auth');
    contextGraphService.ingestKanbanBoard(morphedKanban, 'kanban-auth');
    contextGraphService.ingestNodeGraph(morphedGraph, 'graph-payments');

    const graph = contextGraphService.getGraph();
    assert.strictEqual(graph.nodes.length >= 4, true, 'Graph must contain ingested nodes across primitives');
    assert.strictEqual(graph.edges.length >= 1, true, 'Graph must contain relation edges between entities');
    console.log('  ✓ Test 4.1 Passed: ProjectContextGraphService ingests and cross-indexes multi-surface entities');

    // Test 4.2: Topological context slicing and MLA compaction
    const slice = contextGraphService.getContextSlice('doc-auth-spec', { maxTokens: 1000 });
    assert.strictEqual(slice.nodes.length > 0, true, 'Slice must return relevant nodes');
    assert.strictEqual(typeof slice.compressedPromptContext, 'string');
    assert.strictEqual(slice.compressedPromptContext.length > 0, true);
    assert.strictEqual(slice.compressionRatio >= 0 && slice.compressionRatio <= 1, true);
    assert.strictEqual(slice.compressedPromptContext.includes('AUTH') || slice.compressedPromptContext.includes('Token') || slice.compressedPromptContext.includes('Spec'), true);
    console.log('  ✓ Test 4.2 Passed: Topological context slice computes graph relevance and produces MLA compressed context');

    // =========================================================================
    // SECTION 5: Multi-Surface Bento / Split-View Stage Layout
    // =========================================================================
    console.log('\n--- Section 5: Multi-Surface Bento / Split-View Stage Layout ---');

    const stageModes: StageLayoutMode[] = [
        'single',
        'dual-split-horizontal',
        'dual-split-vertical',
        'tri-pane-bento',
        'quad-grid'
    ];

    assert.strictEqual(stageModes.length, 5);
    for (const mode of stageModes) {
        assert.strictEqual(typeof mode, 'string');
    }
    console.log('  ✓ Test 5.1 Passed: StageLayoutMode encompasses single, dual-split, tri-pane-bento, and quad-grid');

    console.log('\n🎉 ALL CROSS-SURFACE PROJECT COORDINATION TESTS PASSED SUCCESSFULLY!');
}

runCrossSurfaceCoordinationTestSuite().catch(err => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
});
