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
import { MarkdownDocumentLens } from '../src/browser/generative-canvas/lenses/MarkdownDocumentLens';
import { LiveCodeSandboxLens } from '../src/browser/generative-canvas/lenses/LiveCodeSandboxLens';
import { KanbanTaskLens } from '../src/browser/generative-canvas/lenses/KanbanTaskLens';
import { NodeGraphWorkflowLens } from '../src/browser/generative-canvas/lenses/NodeGraphWorkflowLens';
import { Scene3DWorldLens } from '../src/browser/generative-canvas/lenses/Scene3DWorldLens';
import { MetricDashboardLens } from '../src/browser/generative-canvas/lenses/MetricDashboardLens';
import { InteractiveBrowserLens } from '../src/browser/generative-canvas/lenses/InteractiveBrowserLens';
import { CodebaseLensRegistry } from '../src/browser/generative-canvas/lenses/CodebaseLensRegistry';
import { CodebaseLensController } from '../src/browser/generative-canvas/lenses/CodebaseLensController';
import {
    InteractiveBrowserData,
    KanbanBoardData,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    MetricDashboardData,
    NodeGraphData,
    Scene3DData
} from '../src/browser/generative-canvas/canvas-types';

async function runCodebaseLensArchitectureTests() {
    console.log('🧪 Running Complete 7-Lens Codebase Architecture Test Suite...\n');

    // =========================================================================
    // Test 1: MarkdownDocumentLens - Projecting & Unprojecting Live .md files
    // =========================================================================
    console.log('  1. Testing MarkdownDocumentLens (Disk Markdown <-> Visual Document Primitive)...');
    const mdLens = new MarkdownDocumentLens();
    assert.strictEqual(mdLens.primitiveType, 'markdown-document');
    assert.strictEqual(mdLens.canHandle('docs/architecture.md'), true);
    assert.strictEqual(mdLens.canHandle('README.md'), true);
    assert.strictEqual(mdLens.canHandle('SPECS.md'), true);
    assert.strictEqual(mdLens.canHandle('src/index.ts'), false);

    const initialMarkdown = `# Scratchbox Engine Architecture
Comprehensive system design and execution roadmap.

> [!NOTE]
> All services run with zero trust boundaries.

## 1. Core Runtime Services
The engine connects through high-throughput IPC pipes.

| Component | Status | Latency |
| :--- | :--- | :--- |
| Workspace Engine | Active | 4ms |
| Gemini Gateway | Active | 18ms |

## 2. Sprint Deliverables
- [x] Design lens protocol
- [ ] Implement bi-directional unprojection
- [ ] Connect SSE file watcher
`;

    // 1a. Project Markdown -> Visual Document
    const projResult = mdLens.project(initialMarkdown, { targetSubdirectory: 'docs' });
    const docData: MarkdownDocumentData = projResult.data;

    assert.strictEqual(docData.title, 'Scratchbox Engine Architecture');
    assert.strictEqual(docData.subtitle, 'Comprehensive system design and execution roadmap.');
    assert.ok(docData.sections.length >= 4, 'Should parse headings, callouts, tables, and checklists');

    const calloutSection = docData.sections.find(s => s.type === 'callout');
    assert.ok(calloutSection, 'Callout section must be parsed');
    assert.strictEqual(calloutSection?.calloutType, 'info');
    assert.strictEqual(calloutSection?.content?.trim(), 'All services run with zero trust boundaries.');

    const tableSection = docData.sections.find(s => s.type === 'table');
    assert.ok(tableSection, 'Table section must be parsed');
    assert.deepStrictEqual(tableSection?.tableHeaders, ['Component', 'Status', 'Latency']);
    assert.strictEqual(tableSection?.tableRows?.length, 2);

    const checklistSection = docData.sections.find(s => s.type === 'checklist');
    assert.ok(checklistSection, 'Checklist section must be parsed');
    assert.strictEqual(checklistSection?.checklistItems?.length, 3);
    assert.strictEqual(checklistSection?.checklistItems?.[0].done, true);
    assert.strictEqual(checklistSection?.checklistItems?.[1].done, false);

    // 1b. Mutate in Visual Primitive and Unproject back to Markdown
    const updatedChecklist = checklistSection?.checklistItems?.map((item, idx) =>
        idx === 1 ? { ...item, done: true } : item
    );
    const updatedSections = docData.sections.map(s => {
        if (s.id === checklistSection?.id) {
            return { ...s, checklistItems: updatedChecklist };
        }
        return s;
    });

    const modifiedDocData: MarkdownDocumentData = {
        ...docData,
        subtitle: 'Updated live from visual canvas lens.',
        sections: updatedSections
    };

    const unprojResult = mdLens.unproject(modifiedDocData, initialMarkdown);
    const generatedMarkdown = unprojResult.files['document.md'] || Object.values(unprojResult.files)[0];

    assert.ok(generatedMarkdown.includes('# Scratchbox Engine Architecture'));
    assert.ok(generatedMarkdown.includes('Updated live from visual canvas lens.'));
    assert.ok(generatedMarkdown.includes('> [!NOTE]'));
    assert.ok(generatedMarkdown.includes('- [x] Implement bi-directional unprojection'), 'Checked item must unproject to - [x]');
    assert.ok(generatedMarkdown.includes('- [ ] Connect SSE file watcher'), 'Unchecked item must remain - [ ]');
    assert.ok(unprojResult.contentHash.startsWith('h_'));
    console.log('    ✓ MarkdownDocumentLens projected and unprojected with AST/format fidelity.');

    // =========================================================================
    // Test 2: LiveCodeSandboxLens - Projecting & Unprojecting Workspace Source Files
    // =========================================================================
    console.log('  2. Testing LiveCodeSandboxLens (Workspace Source Tree <-> Live Code Sandbox)...');
    const sandboxLens = new LiveCodeSandboxLens();
    assert.strictEqual(sandboxLens.primitiveType, 'live-code-sandbox');
    assert.strictEqual(sandboxLens.canHandle({ 'src/components/Button.tsx': 'export const Button = () => null;' }), true);

    const rawWorkspaceFiles: Record<string, string> = {
        'src/components/PricingTable.tsx': `import React from 'react';
export const PricingTable = () => <div>Pricing</div>;`,
        'src/components/PricingTable.test.tsx': `import { PricingTable } from './PricingTable';
test('renders', () => { expect(PricingTable).toBeDefined(); });`,
        'src/components/PricingTable.css': `.pricing-card { background: #18181b; }`,
        'README.md': `# Pricing Component\nReusable React Pricing Table.`
    };

    // 2a. Project files into Sandbox
    const sandboxProj = sandboxLens.project(rawWorkspaceFiles);
    const sandboxData: LiveCodeSandboxData = sandboxProj.data;

    assert.strictEqual(sandboxData.files.length, 4);
    const mainTab = sandboxData.files.find(f => f.path === 'src/components/PricingTable.tsx');
    assert.ok(mainTab);
    assert.strictEqual(mainTab?.language, 'typescript');
    assert.strictEqual(mainTab?.isEntry, true);

    // 2b. Edit a file in Sandbox and add a new helper file
    const editedFiles = sandboxData.files.map(f => {
        if (f.path === 'src/components/PricingTable.tsx') {
            return { ...f, content: f.content + '\n// Enhanced with Lens support' };
        }
        return f;
    });
    editedFiles.push({
        id: 'tab-types',
        name: 'types.ts',
        path: 'src/components/types.ts',
        language: 'typescript',
        content: `export interface PricingTier { id: string; price: number; }`
    });

    const modifiedSandbox: LiveCodeSandboxData = {
        ...sandboxData,
        files: editedFiles
    };

    const sandboxUnproj = sandboxLens.unproject(modifiedSandbox, rawWorkspaceFiles);
    assert.strictEqual(Object.keys(sandboxUnproj.files).length, 5);
    assert.ok(sandboxUnproj.files['src/components/PricingTable.tsx'].includes('// Enhanced with Lens support'));
    assert.ok(sandboxUnproj.files['src/components/types.ts'].includes('export interface PricingTier'));
    assert.strictEqual(sandboxUnproj.files['README.md'], rawWorkspaceFiles['README.md']);
    assert.ok(sandboxUnproj.modifiedFilePaths.includes('src/components/PricingTable.tsx'));
    assert.ok(sandboxUnproj.modifiedFilePaths.includes('src/components/types.ts'));
    console.log('    ✓ LiveCodeSandboxLens bidirectional source mapping verified.');

    // =========================================================================
    // Test 3: KanbanTaskLens - Projecting & Unprojecting ROADMAP / Tasks Markdown
    // =========================================================================
    console.log('  3. Testing KanbanTaskLens (ROADMAP.md / Task Lists <-> Kanban Board Primitive)...');
    const kanbanLens = new KanbanTaskLens();
    assert.strictEqual(kanbanLens.primitiveType, 'kanban-board');
    assert.strictEqual(kanbanLens.canHandle('ROADMAP.md'), true);
    assert.strictEqual(kanbanLens.canHandle('TODO.md'), true);
    assert.strictEqual(kanbanLens.canHandle('.scratchbox/tasks.md'), true);

    const initialRoadmap = `# Product Engineering Roadmap
Sprint 42 deliverables and backlog.

## To Do
- [ ] [urgent] Deploy Multi-Surface Bento Layout <!-- id:task-101 -->
- [ ] [medium] Add dark mode theme overrides <!-- id:task-102 -->

## In Progress
- [ ] [high] Implement Bi-Directional Codebase Lens <!-- id:task-201 -->

## Done
- [x] [low] Polish terminal debug bridge <!-- id:task-301 -->
`;

    // 3a. Project ROADMAP into Kanban Board
    const kanbanProj = kanbanLens.project(initialRoadmap);
    const boardData: KanbanBoardData = kanbanProj.data;

    assert.strictEqual(boardData.columns.length, 3);
    assert.strictEqual(boardData.columns[0].id, 'to-do');
    assert.strictEqual(boardData.columns[0].cards.length, 2);
    assert.strictEqual(boardData.columns[0].cards[0].priority, 'urgent');
    assert.strictEqual(boardData.columns[0].cards[0].title, 'Deploy Multi-Surface Bento Layout');

    assert.strictEqual(boardData.columns[1].id, 'in-progress');
    assert.strictEqual(boardData.columns[1].cards[0].id, 'task-201');

    assert.strictEqual(boardData.columns[2].id, 'done');
    assert.strictEqual(boardData.columns[2].cards.length, 1);

    // 3b. Move card from "In Progress" to "Done" in visual Kanban and unproject
    const cardToMove = boardData.columns[1].cards[0];
    const modifiedBoard: KanbanBoardData = {
        ...boardData,
        columns: [
            { ...boardData.columns[0] }, // To Do
            { ...boardData.columns[1], cards: [] }, // In Progress (empty)
            { ...boardData.columns[2], cards: [...boardData.columns[2].cards, { ...cardToMove, completedSubtasks: 1, totalSubtasks: 1 }] } // Done
        ]
    };

    const kanbanUnproj = kanbanLens.unproject(modifiedBoard, initialRoadmap);
    const updatedRoadmap = kanbanUnproj.files['ROADMAP.md'] || Object.values(kanbanUnproj.files)[0];

    assert.ok(updatedRoadmap.includes('- [x] [high] Implement Bi-Directional Codebase Lens'));
    assert.ok(updatedRoadmap.includes('# Product Engineering Roadmap'));
    console.log('    ✓ KanbanTaskLens successfully synced column movements and checkboxes back to markdown.');

    // =========================================================================
    // Test 4: NodeGraphWorkflowLens - Projecting & Unprojecting Workflow DAGs
    // =========================================================================
    console.log('  4. Testing NodeGraphWorkflowLens (Workflow DAG <-> Node Graph Primitive)...');
    const nodeLens = new NodeGraphWorkflowLens();
    assert.strictEqual(nodeLens.primitiveType, 'node-graph');
    assert.strictEqual(nodeLens.canHandle('workflows/deploy.workflow.json'), true);
    assert.strictEqual(nodeLens.canHandle('automations/pipeline.automation'), true);

    const initialWorkflowJson = JSON.stringify({
        title: 'CI/CD Deployment Pipeline',
        nodes: [
            { id: 'n1', label: 'Git Push Event', category: 'input', x: 100, y: 150 },
            { id: 'n2', label: 'Run Automated Tests', category: 'cli', x: 350, y: 150 },
            { id: 'n3', label: 'Deploy to Cloud', category: 'output', x: 600, y: 150 }
        ],
        edges: [
            { id: 'e1-2', source: 'n1', target: 'n2', style: 'solid' },
            { id: 'e2-3', source: 'n2', target: 'n3', style: 'solid' }
        ]
    }, null, 2);

    const workflowProj = nodeLens.project(initialWorkflowJson);
    const graphData: NodeGraphData = workflowProj.data;

    assert.strictEqual(graphData.nodes.length, 3);
    assert.strictEqual(graphData.edges.length, 2);

    const modifiedGraph: NodeGraphData = {
        ...graphData,
        nodes: [
            ...graphData.nodes.map(n => n.id === 'n2' ? { ...n, label: 'Run Vitest & TypeCheck' } : n),
            { id: 'n4', label: 'Notify Slack', category: 'output', x: 600, y: 300 }
        ],
        edges: [
            ...graphData.edges,
            { id: 'e2-4', source: 'n2', target: 'n4', style: 'dashed' }
        ]
    };

    const workflowUnproj = nodeLens.unproject(modifiedGraph, initialWorkflowJson);
    const updatedWorkflowObj = JSON.parse(workflowUnproj.files['workflow.json'] || Object.values(workflowUnproj.files)[0]);
    assert.strictEqual(updatedWorkflowObj.nodes.length, 4);
    assert.strictEqual(updatedWorkflowObj.nodes.find((n: any) => n.id === 'n2').label, 'Run Vitest & TypeCheck');
    assert.strictEqual(updatedWorkflowObj.edges.length, 3);
    console.log('    ✓ NodeGraphWorkflowLens roundtrip pipeline serialization verified.');

    // =========================================================================
    // Test 5: Scene3DWorldLens - Projecting & Unprojecting 3D Spatial Scenes
    // =========================================================================
    console.log('  5. Testing Scene3DWorldLens (.scene.json / 3D State <-> 3D Scene Primitive)...');
    const sceneLens = new Scene3DWorldLens();
    assert.strictEqual(sceneLens.primitiveType, '3d-scene');
    assert.strictEqual(sceneLens.canHandle('scenes/sf-financial-hub.scene.json'), true);
    assert.strictEqual(sceneLens.canHandle('models/drone.3d'), true);

    const initialSceneJson = JSON.stringify({
        title: 'San Francisco Financial Hub',
        worldBranch: 'feature/spatial-anchor',
        renderMode: 'shaded',
        camera: { position: [0, 15, 30], target: [0, 0, 0], fov: 60 },
        geoAnchor: { lat: 37.7900, lng: -122.4000, elevation: 18.5, active: true },
        objects: [
            {
                id: 'obj-tower-1',
                content: { type: '3d-model', durableUri: 'media://models/tower.glb', mimeType: 'model/gltf-binary', metadata: {} },
                space: { spatial3d: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 } },
                time: { startMs: 0, durationMs: 5000 },
                lineage: { version: 1 }
            }
        ]
    }, null, 2);

    const sceneProj = sceneLens.project(initialSceneJson);
    const sceneData: Scene3DData = sceneProj.data;
    assert.strictEqual(sceneData.title, 'San Francisco Financial Hub');
    assert.strictEqual(sceneData.worldBranch, 'feature/spatial-anchor');
    assert.strictEqual((sceneData.objects || []).length, 1);
    assert.strictEqual(sceneData.geoAnchor?.elevation, 18.5);

    // Modify scene in canvas (add drone camera)
    const modifiedSceneData: Scene3DData = {
        ...sceneData,
        title: 'San Francisco Financial Hub (Enhanced)',
        objects: [
            ...(sceneData.objects || []),
            {
                id: 'obj-drone-camera',
                content: { type: '3d-model', durableUri: 'media://models/drone-camera.glb', mimeType: 'model/gltf-binary', metadata: {} },
                space: { spatial3d: { x: 5, y: 12, z: 8, pitch: -15, yaw: 45, roll: 0 } },
                time: { startMs: 0, durationMs: 5000 },
                lineage: { version: 2 }
            }
        ]
    };

    const sceneUnproj = sceneLens.unproject(modifiedSceneData, initialSceneJson);
    const updatedSceneObj = JSON.parse(sceneUnproj.files['world.scene.json'] || Object.values(sceneUnproj.files)[0]);
    assert.strictEqual(updatedSceneObj.title, 'San Francisco Financial Hub (Enhanced)');
    assert.strictEqual(updatedSceneObj.objects.length, 2);
    assert.strictEqual(updatedSceneObj.objects[1].id, 'obj-drone-camera');

    // Test C++ Procedural Engine source file projection into Scene3DWorldLens
    const cppCode = `#include "scratchbox_engine.hpp"\nint main() { return 0; }`;
    assert.strictEqual(sceneLens.canHandle('scenes/world_generator.3d.cpp'), true);
    assert.strictEqual(sceneLens.canHandle('3d/city.cpp'), true);
    assert.strictEqual(sceneLens.canHandle('model.glb'), true);
    const cppProj = sceneLens.project({ 'scenes/world_generator.3d.cpp': cppCode });
    assert.strictEqual(cppProj.data.cppGenerator?.enabled, true);
    assert.strictEqual(cppProj.data.cppGenerator?.sourceCode, cppCode);

    const cppUnproj = sceneLens.unproject(cppProj.data, { 'scenes/world_generator.3d.cpp': cppCode });
    assert.strictEqual(cppUnproj.files['scenes/world_generator.3d.cpp'], cppCode);
    console.log('    ✓ Scene3DWorldLens C++20 engine source projection verified.');
    console.log('    ✓ Scene3DWorldLens 4D spatial composition roundtrip verified.');

    // =========================================================================
    // Test 6: MetricDashboardLens - Projecting & Unprojecting CSV & JSON Analytics
    // =========================================================================
    console.log('  6. Testing MetricDashboardLens (.csv / metrics.json <-> Metric Dashboard Primitive)...');
    const metricLens = new MetricDashboardLens();
    assert.strictEqual(metricLens.primitiveType, 'metric-dashboard');
    assert.strictEqual(metricLens.canHandle('analytics/q3-performance.csv'), true);
    assert.strictEqual(metricLens.canHandle('telemetry/kpi.dashboard.json'), true);

    const initialCsv = `Date,Throughput,Latency,ErrorRate
2026-09-01,1420,24,0.02
2026-09-02,1580,22,0.01
2026-09-03,1890,21,0.01
2026-09-04,2100,26,0.03
`;

    const csvProj = metricLens.project({ 'analytics/q3-performance.csv': initialCsv });
    const metricData: MetricDashboardData = csvProj.data;

    assert.ok(metricData.metrics.length >= 2);
    assert.strictEqual(metricData.metrics[0].value, 4, 'Should parse 4 rows');
    assert.ok(metricData.chart);
    assert.strictEqual(metricData.chart?.data.length, 4);

    // Unproject back to CSV
    const csvUnproj = metricLens.unproject(metricData, { 'analytics/q3-performance.csv': initialCsv });
    const generatedCsv = csvUnproj.files['analytics/q3-performance.csv'];
    assert.ok(generatedCsv.includes('Label,Value') || generatedCsv.includes('2026-09-01'));
    console.log('    ✓ MetricDashboardLens CSV parsing & KPI summary projection verified.');

    // =========================================================================
    // Test 7: InteractiveBrowserLens - Projecting & Unprojecting Web Sessions
    // =========================================================================
    console.log('  7. Testing InteractiveBrowserLens (.browser.json / .url <-> Interactive Browser Primitive)...');
    const browserLens = new InteractiveBrowserLens();
    assert.strictEqual(browserLens.primitiveType, 'interactive-browser');
    assert.strictEqual(browserLens.canHandle('sessions/app.browser.json'), true);
    assert.strictEqual(browserLens.canHandle('links/scratchbox.url'), true);
    assert.strictEqual(browserLens.canHandle('https://scratchbox.dev'), true);

    const initialBrowserSession = JSON.stringify({
        url: 'https://scratchbox.dev/docs',
        title: 'Scratchbox Documentation Hub',
        viewportMode: 'desktop',
        history: ['https://scratchbox.dev', 'https://scratchbox.dev/docs'],
        historyIndex: 1,
        inspectMode: false,
        consoleLogs: [{ type: 'info', text: 'Page loaded in 28ms', timestamp: '12:00:00' }]
    }, null, 2);

    const browserProj = browserLens.project(initialBrowserSession);
    const browserData: InteractiveBrowserData = browserProj.data;

    assert.strictEqual(browserData.url, 'https://scratchbox.dev/docs');
    assert.strictEqual(browserData.history?.length, 2);
    assert.strictEqual(browserData.consoleLogs?.length, 1);

    // Navigate to new URL in visual browser
    const modifiedBrowserData: InteractiveBrowserData = {
        ...browserData,
        url: 'https://scratchbox.dev/docs/lenses',
        history: [...(browserData.history || []), 'https://scratchbox.dev/docs/lenses'],
        historyIndex: 2
    };

    const browserUnproj = browserLens.unproject(modifiedBrowserData, initialBrowserSession);
    const updatedBrowserObj = JSON.parse(browserUnproj.files['session.browser.json'] || Object.values(browserUnproj.files)[0]);
    assert.strictEqual(updatedBrowserObj.url, 'https://scratchbox.dev/docs/lenses');
    assert.strictEqual(updatedBrowserObj.history.length, 3);
    console.log('    ✓ InteractiveBrowserLens session navigation & serialization verified.');

    // =========================================================================
    // Test 8: CodebaseLensRegistry & CodebaseLensController - 7-Lens Coordination
    // =========================================================================
    console.log('  8. Testing CodebaseLensRegistry & Controller (Dirty state tracking, sync, loopback suppression)...');
    const registry = CodebaseLensRegistry.createDefaultRegistry();
    assert.strictEqual(registry.getAll().length, 7, 'All 7 lenses must be registered in default registry');

    assert.strictEqual(registry.resolveByPath('docs/spec.md')?.primitiveType, 'markdown-document');
    assert.strictEqual(registry.resolveByPath('ROADMAP.md')?.primitiveType, 'kanban-board');
    assert.strictEqual(registry.resolveByPath('workflows/build.workflow.json')?.primitiveType, 'node-graph');
    assert.strictEqual(registry.resolveByPath('scenes/world.scene.json')?.primitiveType, '3d-scene');
    assert.strictEqual(registry.resolveByPath('analytics/growth.csv')?.primitiveType, 'metric-dashboard');
    assert.strictEqual(registry.resolveByPath('sessions/web.browser.json')?.primitiveType, 'interactive-browser');
    assert.strictEqual(registry.resolveByType('live-code-sandbox')?.primitiveType, 'live-code-sandbox');

    const controller = new CodebaseLensController(registry);

    // 8a. Create binding
    const binding = controller.createBinding({
        artifactId: 'art-arch-doc',
        lensType: 'markdown-document',
        primaryFilePath: 'docs/architecture.md',
        syncMode: 'live-bidirectional',
        initialContent: initialMarkdown
    });

    assert.strictEqual(binding.status, 'synced');
    assert.ok(binding.lastSyncHash.startsWith('h_'));

    // 8b. Dirty tracking
    controller.markDirty('art-arch-doc', 'ui');
    assert.strictEqual(controller.getBinding('art-arch-doc')?.status, 'dirty-ui');

    controller.markDirty('art-arch-doc', 'disk');
    assert.strictEqual(controller.getBinding('art-arch-doc')?.status, 'dirty-disk');

    // 8c. Unproject UI modifications -> Generates unprojected disk file payload
    const unprojectedMutation = controller.unprojectUiChanges(
        'art-arch-doc',
        modifiedDocData,
        initialMarkdown
    );

    assert.ok(unprojectedMutation);
    assert.strictEqual(controller.getBinding('art-arch-doc')?.status, 'synced');
    assert.strictEqual(controller.isKnownInternalHash(unprojectedMutation.contentHash), true, 'Hash must be registered to suppress echo watcher loopback');

    // 8d. Test sync() method
    const syncOutRes = controller.sync('art-arch-doc', 'out', {
        primitiveData: modifiedDocData,
        diskContent: initialMarkdown
    });
    assert.strictEqual(syncOutRes.success, true);
    assert.ok(syncOutRes.result);

    const syncInRes = controller.sync('art-arch-doc', 'in', {
        diskContent: initialMarkdown
    });
    assert.strictEqual(syncInRes.success, true);
    assert.ok(syncInRes.result);

    console.log('    ✓ CodebaseLensController cleanly managed 7-lens registry, dirty states, and loopback suppression.');

    console.log('\n🎉 ALL 8 BI-DIRECTIONAL CODEBASE LENS ARCHITECTURE & LIFECYCLE TESTS PASSED SUCCESSFULLY!');
}

test('codebase-lens-architecture.test', async () => {
    await runCodebaseLensArchitectureTests();
}, 180_000);
