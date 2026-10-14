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
    UnifiedProjectCoordinator,
    CanonicalProjectState,
    ProjectAgentTransaction,
    ProjectMutationEvent
} from '../src/browser/generative-canvas/unified-project-coordinator';
import { UnifiedProjectCoordinatorService } from '../src/node/unified-project-coordinator-service';
import { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import { CodebaseLensController } from '../src/browser/generative-canvas/lenses/CodebaseLensController';
import { CodebaseLensRegistry } from '../src/browser/generative-canvas/lenses/CodebaseLensRegistry';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';
import { WorkspaceConfigService } from '../src/node/workspace-config-service';
import {
    CanvasArtifact,
    KanbanBoardData,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    Scene3DData
} from '../src/browser/generative-canvas/canvas-types';

async function runUnifiedProjectCoordinationTests() {
    console.log('🧪 Running Unified Project Coordination Architecture Test Suite...\n');

    // Setup Shared Infrastructure
    const registry = CodebaseLensRegistry.createDefaultRegistry();
    const lensController = new CodebaseLensController(registry);
    const artifactController = new ProjectArtifactController(
        'project-unified-test',
        { id: 'test-user', displayName: 'Test User', kind: 'user' }
    );

    // =========================================================================
    // Test 1: Canonical Project State Registration and Disk Hydration
    // =========================================================================
    console.log('  1. Testing Canonical Project State Registration & Disk Hydration...');
    const coordinator = new UnifiedProjectCoordinator({
        projectId: 'project-unified-test',
        workspaceRoot: '/workspace/project-unified-test',
        projectController: artifactController,
        lensController: lensController
    });

    const initialWorkspaceFiles: Record<string, string> = {
        'src/components/App.tsx': `import React from 'react';
import { PhysicsEngine } from './PhysicsEngine';

export interface AppProps {
    title: string;
    gravity?: number;
}

export class AppController {
    run(gravity = 9.8): void {
        console.log("Starting simulation with gravity", gravity);
    }
}`,
        'docs/PRD.md': `# Unified Architecture Spec
Roadmap and technical deliverables.

## 1. Deliverables
- [x] Design canonical coordinator
- [ ] Implement multi-lens reactivity
- [ ] Support transactional agent mutations
`,
        'scenes/world.3d.json': JSON.stringify({
            title: 'Simulation World',
            engine: 'three',
            environment: { preset: 'sunset', background: '#0a0e1a' },
            objects: [
                {
                    id: 'obj_cube_1',
                    content: {
                        type: '3d-model',
                        durableUri: 'media://models/cube.glb',
                        mimeType: 'model/gltf-binary',
                        metadata: { label: 'Interactive Cube' }
                    },
                    space: {
                        spatial3d: { x: 0, y: 1, z: 0, pitch: 0, yaw: 0, roll: 0 }
                    }
                }
            ]
        }, null, 2),
        'tasks/sprint.kanban.json': JSON.stringify({
            title: 'Sprint 1',
            columns: [
                {
                    id: 'col-todo',
                    title: 'To Do',
                    color: 'amber',
                    cards: [
                        { id: 'task-1', title: 'Implement multi-lens reactivity', priority: 'high', completedSubtasks: 0, totalSubtasks: 2 },
                        { id: 'task-2', title: 'Support transactional agent mutations', priority: 'urgent', completedSubtasks: 0, totalSubtasks: 1 }
                    ]
                },
                {
                    id: 'col-done',
                    title: 'Done',
                    color: 'emerald',
                    cards: [
                        { id: 'task-0', title: 'Design canonical coordinator', priority: 'medium', completedSubtasks: 1, totalSubtasks: 1 }
                    ]
                }
            ]
        }, null, 2)
    };

    // Hydrate disk files into canonical coordinator state
    coordinator.hydrateFromDisk(initialWorkspaceFiles);
    const canonicalState: CanonicalProjectState = coordinator.getCanonicalState();

    assert.strictEqual(canonicalState.projectId, 'project-unified-test');
    assert.strictEqual(canonicalState.codeAndAssets.files['src/components/App.tsx']?.path, 'src/components/App.tsx');
    assert.ok(canonicalState.codeAndAssets.files['src/components/App.tsx']?.content.includes('AppController'));
    assert.strictEqual(canonicalState.documentsAndSpecs.specs.size, 1);
    assert.strictEqual(canonicalState.spatialAnd3DWorlds.scenes.size, 1);
    assert.strictEqual(canonicalState.workflowsAndTasks.kanbanBoards.size, 1);
    assert.strictEqual(canonicalState.workflowsAndTasks.tasks.size, 3);
    console.log('    ✓ Canonical project state accurately hydrated across Code, Specs, 3D, and Kanban.');

    // =========================================================================
    // Test 2: Multi-Lens Bidirectional Propagation Across 3D, Sandbox, Docs, & Kanban
    // =========================================================================
    console.log('  2. Testing Reactive Multi-Lens Bidirectional Propagation...');

    const capturedEvents: ProjectMutationEvent[] = [];
    const unsubscribe = coordinator.onProjectChanged(event => {
        capturedEvents.push(event);
    });

    // 2a. Kanban Task Mutation -> Propagates to Markdown Spec Checklist and Node Graph
    console.log('    • Mutating Kanban task status -> cross-propagating to Docs & Workflows...');
    const kanbanBoard = Array.from(canonicalState.workflowsAndTasks.kanbanBoards.values())[0];
    assert.ok(kanbanBoard, 'Kanban board must exist');

    // Move task-1 to Done
    const updatedTodoCards = kanbanBoard.columns[0].cards.filter(c => c.id !== 'task-1');
    const updatedDoneCards = [...kanbanBoard.columns[1].cards, {
        ...kanbanBoard.columns[0].cards.find(c => c.id === 'task-1')!,
        completedSubtasks: 2
    }];

    const updatedBoard: KanbanBoardData = {
        ...kanbanBoard,
        columns: [
            { ...kanbanBoard.columns[0], cards: updatedTodoCards },
            { ...kanbanBoard.columns[1], cards: updatedDoneCards }
        ]
    };

    const kanbanMutation = coordinator.mutateFromLens('kanban-board', 'artifact-kanban-sprint', updatedBoard);
    assert.strictEqual(kanbanMutation.success, true);
    assert.ok(kanbanMutation.affectedLenses.includes('kanban-board'));
    assert.ok(kanbanMutation.affectedLenses.includes('markdown-document'));

    // Verify Markdown Spec was reactively updated to reflect checked item
    const projectedDoc = coordinator.projectLens('markdown-document') as CanvasArtifact;
    const docData = projectedDoc.data as MarkdownDocumentData;
    const checklist = docData.sections.find(s => s.type === 'checklist');
    assert.ok(checklist, 'Checklist section must exist in projected spec');
    const multiLensItem = checklist?.checklistItems?.find(i => i.text.includes('Implement multi-lens reactivity'));
    assert.strictEqual(multiLensItem?.done, true, 'Checklist item in Markdown spec must be marked done reactively');
    console.log('    ✓ Kanban task completion reactively checked Markdown Spec deliverable.');

    // 2b. 3D Scene Viewport Object Mutation -> Propagates to Spatial World and Sandbox Binding
    console.log('    • Repositioning 3D object in Scene -> cross-propagating to Spatial World & Code...');
    const scene = Array.from(coordinator.getCanonicalState().spatialAnd3DWorlds.scenes.values())[0];
    assert.ok(scene, 'Scene must exist');
    const existingObjects = scene.objects || [];
    const firstObj = existingObjects[0];
    const updatedScene: Scene3DData = {
        ...scene,
        objects: [
            {
                ...firstObj,
                space: {
                    ...firstObj.space,
                    spatial3d: { x: 5, y: 10, z: -2, pitch: 0, yaw: 1.57, roll: 0 }
                }
            }
        ]
    };

    const sceneMutation = coordinator.mutateFromLens('3d-scene', 'artifact-scene-sim', updatedScene);
    assert.strictEqual(sceneMutation.success, true);
    assert.ok(sceneMutation.affectedLenses.includes('3d-scene'));

    const reprojectedScene = coordinator.projectLens('3d-scene') as CanvasArtifact;
    const reprojectedSceneData = reprojectedScene.data as Scene3DData;
    assert.ok(reprojectedSceneData.objects && reprojectedSceneData.objects.length > 0);
    assert.deepStrictEqual(reprojectedSceneData.objects[0].space.spatial3d, { x: 5, y: 10, z: -2, pitch: 0, yaw: 1.57, roll: 0 });
    console.log('    ✓ 3D Scene object mutation safely updated canonical spatial world state.');

    // 2c. Sandbox Code Editing -> Propagates to Code & Assets AST and File Maps
    console.log('    • Editing Live Code Sandbox -> updating canonical AST and file representations...');
    const updatedSandboxCode = `import React from 'react';

export interface AppProps {
    title: string;
    gravity?: number;
}

export class AppController {
    private isRunning = false;

    run(gravity = 15.0): void {
        this.isRunning = true;
        console.log("High-precision physics simulation started with gravity", gravity);
    }

    stop(): void {
        this.isRunning = false;
    }
}`;

    const sandboxData: LiveCodeSandboxData = {
        title: 'App Component Sandbox',
        files: [
            { id: 'tab-app', name: 'App.tsx', content: updatedSandboxCode, language: 'typescript' }
        ],
        activeFileId: 'tab-app'
    };

    const codeMutation = coordinator.mutateFromLens('live-code-sandbox', 'artifact-sandbox-app', sandboxData);
    assert.strictEqual(codeMutation.success, true);
    assert.ok(coordinator.getCanonicalState().codeAndAssets.files['src/components/App.tsx']?.content.includes('High-precision physics'));
    console.log('    ✓ Sandbox code mutation updated canonical project files and contracts.');

    // =========================================================================
    // Test 3: Transactional AI Agent State Mutations (Gemini / DeepWrite)
    // =========================================================================
    console.log('  3. Testing Transactional AI Agent State Mutations & Zero-Drift Synchronization...');

    const initialVersion = coordinator.getCanonicalState().version;

    const agentTransaction: ProjectAgentTransaction = {
        transactionId: 'tx-gemini-scaffold-001',
        actor: { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', kind: 'agent' },
        description: 'Scaffold Neural Network Simulator component and add tasks',
        mutations: [
            {
                target: 'code',
                filePath: 'src/components/NeuralSim.tsx',
                content: `export class NeuralSim {
    train(epochs = 100): number {
        return epochs * 0.95;
    }
}`
            },
            {
                target: 'task',
                task: {
                    id: 'task-ai-neural',
                    title: 'Calibrate Neural Network Weights',
                    priority: 'high',
                    column: 'To Do',
                    status: 'todo'
                }
            },
            {
                target: '3d-object',
                sceneId: scene.title || 'Simulation World',
                object: {
                    id: 'obj_neural_node_1',
                    content: {
                        type: '3d-model',
                        durableUri: 'media://models/neural.glb',
                        mimeType: 'model/gltf-binary',
                        metadata: { label: 'Neural Cluster Center' }
                    },
                    space: {
                        spatial3d: { x: 0, y: 5, z: 0, pitch: 0, yaw: 0, roll: 0 }
                    }
                }
            }
        ]
    };

    const txResult = coordinator.executeAgentTransaction(agentTransaction);
    assert.strictEqual(txResult.success, true);
    assert.strictEqual(coordinator.getCanonicalState().version, initialVersion + 1);
    assert.ok(coordinator.getCanonicalState().codeAndAssets.files['src/components/NeuralSim.tsx']);
    assert.ok(coordinator.getCanonicalState().workflowsAndTasks.tasks.has('task-ai-neural'));

    const neuralScene = coordinator.projectLens('3d-scene')?.data as Scene3DData;
    assert.ok(neuralScene.objects && neuralScene.objects.some(o => o.id === 'obj_neural_node_1'));

    // Rollback test on invalid transaction
    const failingTransaction: ProjectAgentTransaction = {
        transactionId: 'tx-fail-002',
        actor: { id: 'test-agent', kind: 'agent' },
        description: 'Corrupt transaction that must roll back',
        mutations: [
            {
                target: 'code',
                filePath: 'src/valid.ts',
                content: 'export const valid = true;'
            },
            {
                target: 'code',
                filePath: '', // Invalid empty path triggers validation error
                content: 'invalid'
            }
        ]
    };

    const failResult = coordinator.executeAgentTransaction(failingTransaction);
    assert.strictEqual(failResult.success, false);
    assert.strictEqual(coordinator.getCanonicalState().codeAndAssets.files['src/valid.ts'], undefined, 'Failed transaction must roll back completely');
    console.log('    ✓ Transactional agent mutations executed atomically with rollback safety.');

    // =========================================================================
    // Test 4: Node-side UnifiedProjectCoordinatorService Integration
    // =========================================================================
    console.log('  4. Testing Node-side UnifiedProjectCoordinatorService Integration...');
    const contextGraphService = new ProjectContextGraphService();
    const workspaceConfigService = new WorkspaceConfigService();
    const nodeCoordinatorService = new UnifiedProjectCoordinatorService(contextGraphService, workspaceConfigService);

    nodeCoordinatorService.hydrateState(coordinator.getCanonicalState());

    const graphSummary = nodeCoordinatorService.getContextGraphSummary();
    assert.ok(graphSummary.nodeCount >= 1, 'Context graph should have indexed canonical project nodes');
    assert.strictEqual(nodeCoordinatorService.getCanonicalState().projectId, 'project-unified-test');

    unsubscribe();
    console.log('\n🎉 All Unified Project Coordination Architecture tests passed successfully!\n');
}

test('unified-project-coordination.test', async () => {
    await runUnifiedProjectCoordinationTests();
}, 180_000);
