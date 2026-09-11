/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    ArtifactActor
} from '../../common/project-artifact-graph-protocol';
import {
    CanvasArtifact,
    InteractiveBrowserData,
    KanbanBoardData,
    KanbanCard,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    MetricDashboardData,
    NodeGraphData,
    PrimitiveType,
    Scene3DData
} from './canvas-types';
import { CodebaseLensController } from './lenses/CodebaseLensController';
import { ProjectArtifactController } from './project-artifact-controller';
import { computeMultiFileHash, LensContext } from '../../common/codebase-lens-protocol';

export interface CanonicalCodeFile {
    path: string;
    content: string;
    language?: string;
    hash: string;
    modifiedAt: number;
}

export interface CanonicalTask {
    id: string;
    title: string;
    status: 'todo' | 'in_progress' | 'done' | 'blocked';
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    column?: string;
    description?: string;
    completedSubtasks?: number;
    totalSubtasks?: number;
    sourceType?: 'kanban' | 'markdown' | 'node-graph' | 'agent';
    tag?: string;
}

export interface CanonicalProjectState {
    projectId: string;
    workspaceRoot: string;
    version: number;
    lastUpdated: number;
    codeAndAssets: {
        files: Record<string, CanonicalCodeFile>;
        moduleContracts: Record<string, { exports: string[]; imports: string[] }>;
        astSymbols: Array<{ id: string; name: string; kind: string; filePath: string; signature?: string }>;
    };
    documentsAndSpecs: {
        specs: Map<string, MarkdownDocumentData>;
        rfcs: Map<string, any>;
        requirements: Array<{ id: string; title: string; completed: boolean; sourceSection?: string }>;
    };
    spatialAnd3DWorlds: {
        scenes: Map<string, Scene3DData>;
        geoAnchors: Map<string, any>;
    };
    workflowsAndTasks: {
        kanbanBoards: Map<string, KanbanBoardData>;
        nodeGraphs: Map<string, NodeGraphData>;
        tasks: Map<string, CanonicalTask>;
    };
    metricsAndDashboards: {
        dashboards: Map<string, MetricDashboardData>;
    };
    browsers: {
        sessions: Map<string, InteractiveBrowserData>;
    };
}

export interface ProjectMutationEvent {
    type:
        | 'file_changed'
        | 'primitive_mutated'
        | 'agent_transaction'
        | 'state_hydrated'
        | 'task_updated'
        | 'scene_updated'
        | 'code_updated'
        | 'doc_updated';
    source: 'lens' | 'disk' | 'agent' | 'user' | 'system';
    sourcePrimitiveType?: PrimitiveType;
    sourceArtifactId?: string;
    affectedLenses: PrimitiveType[];
    affectedArtifactIds: string[];
    modifiedFiles: string[];
    timestamp: number;
    transactionId?: string;
    version: number;
}

export type ProjectMutationListener = (event: ProjectMutationEvent) => void;

export interface ProjectAgentMutation {
    target: 'code' | 'task' | '3d-object' | 'spec' | 'node-step' | 'raw-file';
    filePath?: string;
    content?: string;
    language?: string;
    task?: CanonicalTask;
    sceneId?: string;
    object?: any;
    specId?: string;
    doc?: MarkdownDocumentData;
    graphId?: string;
    node?: any;
}

export interface ProjectAgentTransaction {
    transactionId: string;
    actor: ArtifactActor;
    description?: string;
    mutations: ProjectAgentMutation[];
}

export interface ProjectMutationResult {
    success: boolean;
    affectedLenses: PrimitiveType[];
    affectedArtifacts: string[];
    version: number;
    error?: string;
}

export interface CanonicalProjectSnapshot {
    projectId: string;
    workspaceRoot: string;
    version: number;
    lastUpdated: number;
    files: Record<string, string>;
    specs: Record<string, MarkdownDocumentData>;
    scenes: Record<string, Scene3DData>;
    kanbanBoards: Record<string, KanbanBoardData>;
    nodeGraphs: Record<string, NodeGraphData>;
    tasks: Record<string, CanonicalTask>;
    dashboards: Record<string, MetricDashboardData>;
}

export class UnifiedProjectCoordinator {
    readonly projectId: string;
    readonly workspaceRoot: string;

    private state: CanonicalProjectState;
    private listeners: Set<ProjectMutationListener> = new Set();
    private projectController?: ProjectArtifactController;
    private lensController?: CodebaseLensController;

    constructor(options: {
        projectId: string;
        workspaceRoot?: string;
        projectController?: ProjectArtifactController;
        lensController?: CodebaseLensController;
    }) {
        this.projectId = options.projectId;
        this.workspaceRoot = options.workspaceRoot || `/workspace/${options.projectId}`;
        this.projectController = options.projectController;
        this.lensController = options.lensController;

        this.state = this.createEmptyCanonicalState();
    }

    private createEmptyCanonicalState(): CanonicalProjectState {
        return {
            projectId: this.projectId,
            workspaceRoot: this.workspaceRoot,
            version: 1,
            lastUpdated: Date.now(),
            codeAndAssets: {
                files: {},
                moduleContracts: {},
                astSymbols: []
            },
            documentsAndSpecs: {
                specs: new Map(),
                rfcs: new Map(),
                requirements: []
            },
            spatialAnd3DWorlds: {
                scenes: new Map(),
                geoAnchors: new Map()
            },
            workflowsAndTasks: {
                kanbanBoards: new Map(),
                nodeGraphs: new Map(),
                tasks: new Map()
            },
            metricsAndDashboards: {
                dashboards: new Map()
            },
            browsers: {
                sessions: new Map()
            }
        };
    }

    getCanonicalState(): CanonicalProjectState {
        return this.state;
    }

    setProjectController(controller: ProjectArtifactController): void {
        this.projectController = controller;
    }

    setLensController(controller: CodebaseLensController): void {
        this.lensController = controller;
    }

    onProjectChanged(listener: ProjectMutationListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private notify(event: ProjectMutationEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error('[UnifiedProjectCoordinator] Listener error:', err);
            }
        }
    }

    /**
     * Hydrates the entire canonical project state from disk files.
     */
    hydrateFromDisk(files: Record<string, string>): void {
        const modifiedFiles: string[] = [];

        for (const [filePath, content] of Object.entries(files)) {
            const cleanPath = filePath.replace(/\\/g, '/');
            const hash = computeMultiFileHash(content);

            // 1. Code and Source Assets
            if (
                cleanPath.endsWith('.ts') ||
                cleanPath.endsWith('.tsx') ||
                cleanPath.endsWith('.js') ||
                cleanPath.endsWith('.jsx') ||
                cleanPath.endsWith('.py') ||
                cleanPath.endsWith('.rs') ||
                cleanPath.endsWith('.go') ||
                cleanPath.endsWith('.css') ||
                cleanPath.endsWith('.html') ||
                cleanPath.endsWith('.json')
            ) {
                this.state.codeAndAssets.files[cleanPath] = {
                    path: cleanPath,
                    content,
                    language: this.inferLanguage(cleanPath),
                    hash,
                    modifiedAt: Date.now()
                };
                modifiedFiles.push(cleanPath);
            }

            // 2. Documents and Markdown Specs
            if (cleanPath.endsWith('.md') || cleanPath.endsWith('.markdown')) {
                const specData = this.parseMarkdownToSpec(cleanPath, content);
                this.state.documentsAndSpecs.specs.set(cleanPath, specData);
                this.syncSpecChecklistToTasks(specData);
                modifiedFiles.push(cleanPath);
            }

            // 3. 3D and Spatial Scenes
            if (cleanPath.includes('.3d.') || cleanPath.endsWith('scene.json')) {
                try {
                    const parsedScene = typeof content === 'string' ? JSON.parse(content) : content;
                    const sceneId = parsedScene.id || cleanPath;
                    this.state.spatialAnd3DWorlds.scenes.set(sceneId, parsedScene);
                    modifiedFiles.push(cleanPath);
                } catch {
                    // Ignore parse error
                }
            }

            // 4. Kanban Boards
            if (cleanPath.includes('.kanban.') || cleanPath.endsWith('kanban.json')) {
                try {
                    const parsedBoard: KanbanBoardData = typeof content === 'string' ? JSON.parse(content) : content;
                    const boardId = (parsedBoard as any).id || cleanPath;
                    this.state.workflowsAndTasks.kanbanBoards.set(boardId, parsedBoard);
                    this.syncKanbanCardsToTasks(parsedBoard);
                    modifiedFiles.push(cleanPath);
                } catch {
                    // Ignore parse error
                }
            }

            // 5. Node Graphs
            if (cleanPath.includes('.workflow.') || cleanPath.endsWith('workflow.json')) {
                try {
                    const parsedGraph: NodeGraphData = typeof content === 'string' ? JSON.parse(content) : content;
                    const graphId = (parsedGraph as any).id || cleanPath;
                    this.state.workflowsAndTasks.nodeGraphs.set(graphId, parsedGraph);
                    modifiedFiles.push(cleanPath);
                } catch {
                    // Ignore parse error
                }
            }
        }

        this.extractCodeContracts();

        this.state.version += 1;
        this.state.lastUpdated = Date.now();

        this.notify({
            type: 'state_hydrated',
            source: 'disk',
            affectedLenses: [
                'live-code-sandbox',
                'markdown-document',
                '3d-scene',
                'kanban-board',
                'node-graph',
                'metric-dashboard',
                'interactive-browser'
            ],
            affectedArtifactIds: [],
            modifiedFiles,
            timestamp: Date.now(),
            version: this.state.version
        });
    }

    /**
     * Mutates the canonical project state from an active visual lens primitive,
     * and reactively propagates changes to all associated lens views.
     */
    mutateFromLens(
        lensType: PrimitiveType,
        artifactId: string,
        primitiveData: any,
        options?: { correlationId?: string; actor?: ArtifactActor }
    ): ProjectMutationResult {
        const correlationId = options?.correlationId || `lens-mut-${Date.now()}`;
        const affectedLenses: Set<PrimitiveType> = new Set([lensType]);
        const affectedArtifactIds: Set<string> = new Set([artifactId]);
        const modifiedFiles: string[] = [];

        try {
            switch (lensType) {
                case 'kanban-board': {
                    const board = primitiveData as KanbanBoardData;
                    let boardKey: string | undefined;
                    if (artifactId && this.state.workflowsAndTasks.kanbanBoards.has(artifactId)) {
                        boardKey = artifactId;
                    } else if (board.title) {
                        for (const [k, b] of this.state.workflowsAndTasks.kanbanBoards.entries()) {
                            if (b.title === board.title) {
                                boardKey = k;
                                break;
                            }
                        }
                    }
                    if (!boardKey && this.state.workflowsAndTasks.kanbanBoards.size === 1) {
                        boardKey = Array.from(this.state.workflowsAndTasks.kanbanBoards.keys())[0];
                    }
                    if (!boardKey) {
                        boardKey = artifactId || 'default-board';
                    }
                    this.state.workflowsAndTasks.kanbanBoards.set(boardKey, board);
                    this.syncKanbanCardsToTasks(board);

                    // Cross-propagate task updates to Markdown spec checklist items
                    const docUpdated = this.crossSyncTasksToMarkdownSpecs();
                    if (docUpdated) {
                        affectedLenses.add('markdown-document');
                    }

                    // Cross-propagate to Node Graph workflow steps
                    const nodeUpdated = this.crossSyncTasksToNodeGraphs();
                    if (nodeUpdated) {
                        affectedLenses.add('node-graph');
                    }
                    break;
                }

                case 'markdown-document': {
                    const doc = primitiveData as MarkdownDocumentData;
                    let specKey: string | undefined;
                    if (artifactId && this.state.documentsAndSpecs.specs.has(artifactId)) {
                        specKey = artifactId;
                    } else if (doc.title) {
                        for (const [k, s] of this.state.documentsAndSpecs.specs.entries()) {
                            if (s.title === doc.title) {
                                specKey = k;
                                break;
                            }
                        }
                    }
                    if (!specKey && this.state.documentsAndSpecs.specs.size === 1) {
                        specKey = Array.from(this.state.documentsAndSpecs.specs.keys())[0];
                    }
                    if (!specKey) {
                        specKey = artifactId || 'default-spec';
                    }
                    this.state.documentsAndSpecs.specs.set(specKey, doc);
                    this.syncSpecChecklistToTasks(doc);

                    // Cross-propagate to Kanban boards
                    const kanbanUpdated = this.crossSyncTasksToKanbanBoards();
                    if (kanbanUpdated) {
                        affectedLenses.add('kanban-board');
                    }
                    break;
                }

                case '3d-scene': {
                    const scene = primitiveData as Scene3DData;
                    let sceneKey: string | undefined;
                    if (artifactId && this.state.spatialAnd3DWorlds.scenes.has(artifactId)) {
                        sceneKey = artifactId;
                    } else if (scene.title) {
                        for (const [k, s] of this.state.spatialAnd3DWorlds.scenes.entries()) {
                            if (s.title === scene.title) {
                                sceneKey = k;
                                break;
                            }
                        }
                    }
                    if (!sceneKey && this.state.spatialAnd3DWorlds.scenes.size === 1) {
                        sceneKey = Array.from(this.state.spatialAnd3DWorlds.scenes.keys())[0];
                    }
                    if (!sceneKey) {
                        sceneKey = artifactId || scene.title || 'default-scene';
                    }
                    this.state.spatialAnd3DWorlds.scenes.set(sceneKey, scene);

                    // Update scene file in canonical code files
                    const sceneFilePath = `scenes/${(scene.title || 'world').toLowerCase().replace(/\s+/g, '-')}.3d.json`;
                    const sceneJson = JSON.stringify(scene, null, 2);
                    this.state.codeAndAssets.files[sceneFilePath] = {
                        path: sceneFilePath,
                        content: sceneJson,
                        language: 'json',
                        hash: computeMultiFileHash(sceneJson),
                        modifiedAt: Date.now()
                    };
                    modifiedFiles.push(sceneFilePath);
                    break;
                }

                case 'live-code-sandbox': {
                    const sandbox = primitiveData as LiveCodeSandboxData;
                    for (const file of sandbox.files || []) {
                        // Find matching canonical file or create one
                        let canonicalPath = file.path || `src/components/${file.name}`;
                        if (!this.state.codeAndAssets.files[canonicalPath]) {
                            // Find by filename
                            const existing = Object.keys(this.state.codeAndAssets.files).find(p => p.endsWith(`/${file.name}`) || p === file.name);
                            if (existing) {
                                canonicalPath = existing;
                            }
                        }

                        this.state.codeAndAssets.files[canonicalPath] = {
                            path: canonicalPath,
                            content: file.content,
                            language: file.language || this.inferLanguage(file.name),
                            hash: computeMultiFileHash(file.content),
                            modifiedAt: Date.now()
                        };
                        modifiedFiles.push(canonicalPath);
                    }
                    this.extractCodeContracts();
                    break;
                }

                case 'node-graph': {
                    const graph = primitiveData as NodeGraphData;
                    const graphKey = artifactId || (graph as any).id || 'default-graph';
                    this.state.workflowsAndTasks.nodeGraphs.set(graphKey, graph);

                    // Cross-sync node steps with tasks
                    for (const node of graph.nodes || []) {
                        const title = node.label || (node as any).title;
                        if (title) {
                            const task = this.findTaskByTitle(title);
                            if (task) {
                                task.status = node.status === 'completed' ? 'done' : 'in_progress';
                            }
                        }
                    }
                    break;
                }

                case 'metric-dashboard': {
                    const dash = primitiveData as MetricDashboardData;
                    this.state.metricsAndDashboards.dashboards.set(artifactId || 'default-dashboard', dash);
                    break;
                }

                case 'interactive-browser':
                case 'browser': {
                    const browser = primitiveData as InteractiveBrowserData;
                    this.state.browsers.sessions.set(artifactId || 'default-browser', browser);
                    break;
                }
            }

            // Sync with lens controller if available
            if (this.lensController) {
                this.lensController.markDirty(artifactId, 'ui');
            }

            // Sync with project artifact controller if available
            if (this.projectController) {
                const canvasArtifact: CanvasArtifact = {
                    id: artifactId,
                    type: lensType,
                    title: primitiveData.title || `${lensType} Primitive`,
                    summary: `Canonical projection of ${lensType}`,
                    data: primitiveData,
                    createdAt: new Date().toISOString(),
                    version: this.state.version
                };
                this.projectController.registerArtifact(canvasArtifact, correlationId);
            }

            this.state.version += 1;
            this.state.lastUpdated = Date.now();

            const affectedLensesArray = Array.from(affectedLenses);
            const affectedArtifactsArray = Array.from(affectedArtifactIds);

            this.notify({
                type: 'primitive_mutated',
                source: 'lens',
                sourcePrimitiveType: lensType,
                sourceArtifactId: artifactId,
                affectedLenses: affectedLensesArray,
                affectedArtifactIds: affectedArtifactsArray,
                modifiedFiles,
                timestamp: Date.now(),
                version: this.state.version
            });

            return {
                success: true,
                affectedLenses: affectedLensesArray,
                affectedArtifacts: affectedArtifactsArray,
                version: this.state.version
            };
        } catch (err: any) {
            return {
                success: false,
                affectedLenses: [],
                affectedArtifacts: [],
                version: this.state.version,
                error: err.message || 'Failed to mutate from lens'
            };
        }
    }

    /**
     * Mutates canonical project state when a file on disk changes.
     */
    mutateFromDisk(filePath: string, content: string): ProjectMutationResult {
        const cleanPath = filePath.replace(/\\/g, '/');
        const hash = computeMultiFileHash(content);
        const affectedLenses: Set<PrimitiveType> = new Set();
        const affectedArtifactIds: Set<string> = new Set();

        this.state.codeAndAssets.files[cleanPath] = {
            path: cleanPath,
            content,
            language: this.inferLanguage(cleanPath),
            hash,
            modifiedAt: Date.now()
        };

        if (cleanPath.endsWith('.ts') || cleanPath.endsWith('.tsx') || cleanPath.endsWith('.js')) {
            affectedLenses.add('live-code-sandbox');
            this.extractCodeContracts();
        }

        if (cleanPath.endsWith('.md')) {
            const spec = this.parseMarkdownToSpec(cleanPath, content);
            this.state.documentsAndSpecs.specs.set(cleanPath, spec);
            this.syncSpecChecklistToTasks(spec);
            affectedLenses.add('markdown-document');
            affectedLenses.add('kanban-board');
        }

        if (cleanPath.includes('.3d.')) {
            try {
                const scene = JSON.parse(content);
                this.state.spatialAnd3DWorlds.scenes.set(cleanPath, scene);
                affectedLenses.add('3d-scene');
            } catch {
                // Ignore
            }
        }

        if (cleanPath.includes('.kanban.')) {
            try {
                const board = JSON.parse(content);
                this.state.workflowsAndTasks.kanbanBoards.set(cleanPath, board);
                this.syncKanbanCardsToTasks(board);
                affectedLenses.add('kanban-board');
            } catch {
                // Ignore
            }
        }

        this.state.version += 1;
        this.state.lastUpdated = Date.now();

        const affectedLensesArray = Array.from(affectedLenses);

        this.notify({
            type: 'file_changed',
            source: 'disk',
            affectedLenses: affectedLensesArray,
            affectedArtifactIds: Array.from(affectedArtifactIds),
            modifiedFiles: [cleanPath],
            timestamp: Date.now(),
            version: this.state.version
        });

        return {
            success: true,
            affectedLenses: affectedLensesArray,
            affectedArtifacts: Array.from(affectedArtifactIds),
            version: this.state.version
        };
    }

    /**
     * Executes atomic, transactional AI agent mutations (Gemini / DeepWrite)
     * across code, tasks, specs, and 3D scenes with rollback safety.
     */
    executeAgentTransaction(transaction: ProjectAgentTransaction): ProjectMutationResult {
        // Validation step
        for (const mut of transaction.mutations) {
            if (mut.target === 'code' || mut.target === 'raw-file') {
                if (!mut.filePath || mut.filePath.trim() === '') {
                    return {
                        success: false,
                        affectedLenses: [],
                        affectedArtifacts: [],
                        version: this.state.version,
                        error: `Invalid transaction: Empty filePath in code mutation (transaction: ${transaction.transactionId})`
                    };
                }
            }
            if (mut.target === 'task') {
                if (!mut.task || !mut.task.id || !mut.task.title) {
                    return {
                        success: false,
                        affectedLenses: [],
                        affectedArtifacts: [],
                        version: this.state.version,
                        error: `Invalid transaction: Task must have an id and title (transaction: ${transaction.transactionId})`
                    };
                }
            }
        }

        // Take snapshot for rollback capability
        const snapshot = this.exportSnapshot();
        const affectedLenses: Set<PrimitiveType> = new Set();
        const affectedArtifactIds: Set<string> = new Set();
        const modifiedFiles: string[] = [];

        try {
            for (const mut of transaction.mutations) {
                switch (mut.target) {
                    case 'code':
                    case 'raw-file': {
                        const filePath = mut.filePath!.replace(/\\/g, '/');
                        const content = mut.content || '';
                        this.state.codeAndAssets.files[filePath] = {
                            path: filePath,
                            content,
                            language: mut.language || this.inferLanguage(filePath),
                            hash: computeMultiFileHash(content),
                            modifiedAt: Date.now()
                        };
                        modifiedFiles.push(filePath);
                        affectedLenses.add('live-code-sandbox');
                        break;
                    }

                    case 'task': {
                        const task = mut.task!;
                        this.state.workflowsAndTasks.tasks.set(task.id, task);

                        // Add or update task in Kanban board
                        this.applyTaskToKanbanBoards(task);
                        affectedLenses.add('kanban-board');
                        break;
                    }

                    case '3d-object': {
                        let targetScene = Array.from(this.state.spatialAnd3DWorlds.scenes.values())[0];
                        if (mut.sceneId && this.state.spatialAnd3DWorlds.scenes.has(mut.sceneId)) {
                            targetScene = this.state.spatialAnd3DWorlds.scenes.get(mut.sceneId)!;
                        }
                        if (!targetScene) {
                            targetScene = {
                                title: mut.sceneId || 'Simulation World',
                                objects: []
                            };
                            this.state.spatialAnd3DWorlds.scenes.set(targetScene.title, targetScene);
                        }

                        targetScene.objects = targetScene.objects || [];
                        const existingIdx = targetScene.objects.findIndex((o: any) => o.id === mut.object.id);
                        if (existingIdx >= 0) {
                            targetScene.objects[existingIdx] = mut.object;
                        } else {
                            targetScene.objects.push(mut.object);
                        }

                        affectedLenses.add('3d-scene');
                        break;
                    }

                    case 'spec': {
                        const specId = mut.specId || 'docs/agent-spec.md';
                        if (mut.doc) {
                            this.state.documentsAndSpecs.specs.set(specId, mut.doc);
                            this.syncSpecChecklistToTasks(mut.doc);
                            affectedLenses.add('markdown-document');
                        }
                        break;
                    }

                    case 'node-step': {
                        affectedLenses.add('node-graph');
                        break;
                    }
                }
            }

            this.extractCodeContracts();

            this.state.version += 1;
            this.state.lastUpdated = Date.now();

            const affectedLensesArray = Array.from(affectedLenses);
            const affectedArtifactsArray = Array.from(affectedArtifactIds);

            this.notify({
                type: 'agent_transaction',
                source: 'agent',
                affectedLenses: affectedLensesArray,
                affectedArtifactIds: affectedArtifactsArray,
                modifiedFiles,
                timestamp: Date.now(),
                transactionId: transaction.transactionId,
                version: this.state.version
            });

            return {
                success: true,
                affectedLenses: affectedLensesArray,
                affectedArtifacts: affectedArtifactsArray,
                version: this.state.version
            };
        } catch (err: any) {
            // Roll back snapshot
            this.importSnapshot(snapshot);
            return {
                success: false,
                affectedLenses: [],
                affectedArtifacts: [],
                version: this.state.version,
                error: err.message || 'Transaction execution failed, rolled back to prior snapshot.'
            };
        }
    }

    /**
     * Projects canonical project state into any requested visual canvas primitive lens.
     */
    projectLens(primitiveType: PrimitiveType, artifactId?: string, options?: LensContext): CanvasArtifact | undefined {
        const id = artifactId || `lens-proj-${primitiveType}-${this.projectId}`;
        let data: any;
        let title = `${primitiveType} Lens`;
        const summary = `Reactive projection of ${primitiveType} from canonical project state`;

        switch (primitiveType) {
            case 'markdown-document': {
                const firstSpec = Array.from(this.state.documentsAndSpecs.specs.values())[0];
                if (firstSpec) {
                    data = JSON.parse(JSON.stringify(firstSpec));
                    title = data.title || 'Project Specification';
                } else {
                    data = this.synthesizeDefaultSpec();
                    title = data.title;
                }
                break;
            }

            case 'live-code-sandbox': {
                const files = Object.values(this.state.codeAndAssets.files).map(f => ({
                    id: f.path,
                    name: f.path.split('/').pop() || f.path,
                    path: f.path,
                    content: f.content,
                    language: f.language as any
                }));
                const sandboxData: LiveCodeSandboxData = {
                    title: `${this.projectId} Codebase`,
                    files: files.length > 0 ? files : [{ id: 'index.ts', name: 'index.ts', content: '// Empty project', language: 'typescript' }],
                    activeFileId: files[0]?.id || 'index.ts'
                };
                data = sandboxData;
                title = sandboxData.title;
                break;
            }

            case '3d-scene': {
                const firstScene = Array.from(this.state.spatialAnd3DWorlds.scenes.values())[0];
                if (firstScene) {
                    data = JSON.parse(JSON.stringify(firstScene));
                    title = data.title || '3D Scene Viewport';
                } else {
                    data = {
                        title: 'Default 3D World',
                        environment: { skybox: 'city' },
                        objects: []
                    };
                    title = data.title;
                }
                break;
            }

            case 'kanban-board': {
                const firstBoard = Array.from(this.state.workflowsAndTasks.kanbanBoards.values())[0];
                if (firstBoard) {
                    data = JSON.parse(JSON.stringify(firstBoard));
                    title = data.title || 'Sprint Board';
                } else {
                    data = this.synthesizeKanbanBoardFromTasks();
                    title = data.title;
                }
                break;
            }

            case 'node-graph': {
                const firstGraph = Array.from(this.state.workflowsAndTasks.nodeGraphs.values())[0];
                if (firstGraph) {
                    data = JSON.parse(JSON.stringify(firstGraph));
                    title = data.title || 'Workflow DAG';
                } else {
                    data = this.synthesizeNodeGraphFromTasks();
                    title = data.title;
                }
                break;
            }

            case 'metric-dashboard': {
                const firstDash = Array.from(this.state.metricsAndDashboards.dashboards.values())[0];
                if (firstDash) {
                    data = JSON.parse(JSON.stringify(firstDash));
                    title = data.title;
                } else {
                    data = {
                        title: 'Project Performance Metrics',
                        metrics: [
                            { id: 'm1', label: 'Canonical Version', value: `v${this.state.version}`, trend: 'up' },
                            { id: 'm2', label: 'Source Files', value: Object.keys(this.state.codeAndAssets.files).length, trend: 'neutral' },
                            { id: 'm3', label: 'Total Tasks', value: this.state.workflowsAndTasks.tasks.size, trend: 'up' }
                        ]
                    };
                    title = data.title;
                }
                break;
            }

            case 'interactive-browser':
            case 'browser': {
                const firstBrowser = Array.from(this.state.browsers.sessions.values())[0];
                if (firstBrowser) {
                    data = JSON.parse(JSON.stringify(firstBrowser));
                    title = data.title || 'Web Browser';
                } else {
                    data = {
                        url: 'http://localhost:3000',
                        title: 'Live Preview',
                        viewportMode: 'desktop'
                    };
                    title = data.title;
                }
                break;
            }

            default:
                return undefined;
        }

        const artifact: CanvasArtifact = {
            id,
            type: primitiveType,
            title,
            summary,
            data,
            createdAt: new Date().toISOString(),
            version: this.state.version
        };

        if (this.projectController) {
            this.projectController.registerArtifact(artifact, `project-lens-${Date.now()}`);
        }

        return artifact;
    }

    /**
     * Exports full canonical project state snapshot.
     */
    exportSnapshot(): CanonicalProjectSnapshot {
        const files: Record<string, string> = {};
        for (const [p, f] of Object.entries(this.state.codeAndAssets.files)) {
            files[p] = f.content;
        }

        const specs: Record<string, MarkdownDocumentData> = {};
        for (const [p, s] of this.state.documentsAndSpecs.specs.entries()) {
            specs[p] = JSON.parse(JSON.stringify(s));
        }

        const scenes: Record<string, Scene3DData> = {};
        for (const [p, s] of this.state.spatialAnd3DWorlds.scenes.entries()) {
            scenes[p] = JSON.parse(JSON.stringify(s));
        }

        const kanbanBoards: Record<string, KanbanBoardData> = {};
        for (const [p, b] of this.state.workflowsAndTasks.kanbanBoards.entries()) {
            kanbanBoards[p] = JSON.parse(JSON.stringify(b));
        }

        const nodeGraphs: Record<string, NodeGraphData> = {};
        for (const [p, g] of this.state.workflowsAndTasks.nodeGraphs.entries()) {
            nodeGraphs[p] = JSON.parse(JSON.stringify(g));
        }

        const tasks: Record<string, CanonicalTask> = {};
        for (const [p, t] of this.state.workflowsAndTasks.tasks.entries()) {
            tasks[p] = { ...t };
        }

        const dashboards: Record<string, MetricDashboardData> = {};
        for (const [p, d] of this.state.metricsAndDashboards.dashboards.entries()) {
            dashboards[p] = JSON.parse(JSON.stringify(d));
        }

        return {
            projectId: this.projectId,
            workspaceRoot: this.workspaceRoot,
            version: this.state.version,
            lastUpdated: this.state.lastUpdated,
            files,
            specs,
            scenes,
            kanbanBoards,
            nodeGraphs,
            tasks,
            dashboards
        };
    }

    /**
     * Imports snapshot into canonical state.
     */
    importSnapshot(snapshot: CanonicalProjectSnapshot): void {
        this.state = this.createEmptyCanonicalState();
        this.state.projectId = snapshot.projectId || this.projectId;
        this.state.workspaceRoot = snapshot.workspaceRoot || this.workspaceRoot;
        this.state.version = snapshot.version;
        this.state.lastUpdated = snapshot.lastUpdated;

        for (const [p, content] of Object.entries(snapshot.files || {})) {
            this.state.codeAndAssets.files[p] = {
                path: p,
                content,
                language: this.inferLanguage(p),
                hash: computeMultiFileHash(content),
                modifiedAt: Date.now()
            };
        }

        for (const [p, s] of Object.entries(snapshot.specs || {})) {
            this.state.documentsAndSpecs.specs.set(p, s);
        }

        for (const [p, s] of Object.entries(snapshot.scenes || {})) {
            this.state.spatialAnd3DWorlds.scenes.set(p, s);
        }

        for (const [p, b] of Object.entries(snapshot.kanbanBoards || {})) {
            this.state.workflowsAndTasks.kanbanBoards.set(p, b);
        }

        for (const [p, g] of Object.entries(snapshot.nodeGraphs || {})) {
            this.state.workflowsAndTasks.nodeGraphs.set(p, g);
        }

        for (const [p, t] of Object.entries(snapshot.tasks || {})) {
            this.state.workflowsAndTasks.tasks.set(p, t);
        }

        for (const [p, d] of Object.entries(snapshot.dashboards || {})) {
            this.state.metricsAndDashboards.dashboards.set(p, d);
        }

        this.extractCodeContracts();
    }

    // =========================================================================
    // Cross-Synchronization Helper Methods
    // =========================================================================

    private syncKanbanCardsToTasks(board: KanbanBoardData): void {
        for (const col of board.columns || []) {
            const isDoneCol = col.title.toLowerCase().includes('done') || col.title.toLowerCase().includes('complete');
            const isProgressCol = col.title.toLowerCase().includes('progress') || col.title.toLowerCase().includes('doing');

            for (const card of col.cards || []) {
                const status = isDoneCol ? 'done' : isProgressCol ? 'in_progress' : 'todo';
                const existingTask = this.findTaskByTitle(card.title);
                if (existingTask) {
                    if (existingTask.id !== card.id) {
                        this.state.workflowsAndTasks.tasks.delete(existingTask.id);
                    }
                    existingTask.id = card.id;
                    existingTask.status = status;
                    existingTask.priority = card.priority || existingTask.priority;
                    existingTask.column = col.title;
                    existingTask.description = card.description || existingTask.description;
                    existingTask.completedSubtasks = card.completedSubtasks;
                    existingTask.totalSubtasks = card.totalSubtasks;
                    existingTask.sourceType = 'kanban';
                    existingTask.tag = card.tag || existingTask.tag;
                    this.state.workflowsAndTasks.tasks.set(card.id, existingTask);
                } else {
                    this.state.workflowsAndTasks.tasks.set(card.id, {
                        id: card.id,
                        title: card.title,
                        status,
                        priority: card.priority,
                        column: col.title,
                        description: card.description,
                        completedSubtasks: card.completedSubtasks,
                        totalSubtasks: card.totalSubtasks,
                        sourceType: 'kanban',
                        tag: card.tag
                    });
                }
            }
        }
    }

    private syncSpecChecklistToTasks(doc: MarkdownDocumentData): void {
        (doc.sections || []).forEach((sec, sIdx) => {
            if (sec.type === 'checklist' && Array.isArray(sec.checklistItems)) {
                sec.checklistItems.forEach((item, cIdx) => {
                    const taskId = `task-spec-${sIdx}-${cIdx}`;
                    // Check if already exists with another ID
                    let existingTask = this.findTaskByTitle(item.text);
                    if (!existingTask) {
                        existingTask = {
                            id: taskId,
                            title: item.text,
                            status: item.done ? 'done' : 'todo',
                            sourceType: 'markdown'
                        };
                        this.state.workflowsAndTasks.tasks.set(taskId, existingTask);
                    } else {
                        existingTask.status = item.done ? 'done' : existingTask.status;
                    }
                });
            }
        });
    }

    private crossSyncTasksToMarkdownSpecs(): boolean {
        let updated = false;
        for (const [specPath, spec] of this.state.documentsAndSpecs.specs.entries()) {
            let specModified = false;
            const updatedSections = (spec.sections || []).map(sec => {
                if (sec.type === 'checklist' && Array.isArray(sec.checklistItems)) {
                    const updatedItems = sec.checklistItems.map(item => {
                        const matchingTask = this.findTaskByTitle(item.text);
                        if (matchingTask) {
                            const shouldBeDone = matchingTask.status === 'done';
                            if (item.done !== shouldBeDone) {
                                specModified = true;
                                return { ...item, done: shouldBeDone };
                            }
                        }
                        return item;
                    });
                    return { ...sec, checklistItems: updatedItems };
                }
                return sec;
            });

            if (specModified) {
                this.state.documentsAndSpecs.specs.set(specPath, {
                    ...spec,
                    sections: updatedSections
                });
                updated = true;
            }
        }
        return updated;
    }

    private crossSyncTasksToNodeGraphs(): boolean {
        let updated = false;
        for (const [graphPath, graph] of this.state.workflowsAndTasks.nodeGraphs.entries()) {
            let graphModified = false;
            const updatedNodes = (graph.nodes || []).map(node => {
                const title = node.label || (node as any).title;
                if (title) {
                    const matchingTask = this.findTaskByTitle(title);
                    if (matchingTask) {
                        const newStatus = matchingTask.status === 'done' ? 'completed' : 'pending';
                        if (node.status !== newStatus) {
                            graphModified = true;
                            return { ...node, status: newStatus as any };
                        }
                    }
                }
                return node;
            });

            if (graphModified) {
                this.state.workflowsAndTasks.nodeGraphs.set(graphPath, {
                    ...graph,
                    nodes: updatedNodes
                });
                updated = true;
            }
        }
        return updated;
    }

    private crossSyncTasksToKanbanBoards(): boolean {
        let updated = false;
        for (const [boardPath, board] of this.state.workflowsAndTasks.kanbanBoards.entries()) {
            let boardModified = false;
            for (const col of board.columns || []) {
                const isDoneCol = col.title.toLowerCase().includes('done');
                for (const card of col.cards || []) {
                    const task = this.state.workflowsAndTasks.tasks.get(card.id) || this.findTaskByTitle(card.title);
                    if (task) {
                        const isTaskDone = task.status === 'done';
                        if (isTaskDone !== isDoneCol) {
                            boardModified = true;
                        }
                    }
                }
            }

            if (boardModified) {
                // Synthesize updated board
                const newBoard = this.synthesizeKanbanBoardFromTasks();
                newBoard.title = board.title;
                this.state.workflowsAndTasks.kanbanBoards.set(boardPath, newBoard);
                updated = true;
            }
        }
        return updated;
    }

    private applyTaskToKanbanBoards(task: CanonicalTask): void {
        let targetBoard = Array.from(this.state.workflowsAndTasks.kanbanBoards.values())[0];
        if (!targetBoard) {
            targetBoard = this.synthesizeKanbanBoardFromTasks();
            this.state.workflowsAndTasks.kanbanBoards.set('sprint-board', targetBoard);
            return;
        }

        const targetColTitle = task.column || (task.status === 'done' ? 'Done' : 'To Do');
        let col = targetBoard.columns.find(c => c.title.toLowerCase() === targetColTitle.toLowerCase());
        if (!col) {
            col = targetBoard.columns[0];
        }

        if (col) {
            // Remove existing card from other columns if present
            for (const c of targetBoard.columns) {
                c.cards = c.cards.filter(card => card.id !== task.id);
            }
            col.cards.push({
                id: task.id,
                title: task.title,
                priority: task.priority || 'medium',
                description: task.description,
                tag: task.tag,
                completedSubtasks: task.status === 'done' ? (task.totalSubtasks || 1) : 0,
                totalSubtasks: task.totalSubtasks || 1
            });
        }
    }

    private findTaskByTitle(title: string): CanonicalTask | undefined {
        const cleanTitle = title.trim().toLowerCase();
        for (const task of this.state.workflowsAndTasks.tasks.values()) {
            if (task.title.trim().toLowerCase() === cleanTitle) {
                return task;
            }
        }
        return undefined;
    }

    private parseMarkdownToSpec(filePath: string, content: string): MarkdownDocumentData {
        const lines = content.split('\n');
        let title = filePath.split('/').pop()?.replace(/\.md$/i, '') || 'Spec';
        let subtitle: string | undefined;
        const sections: any[] = [];
        let currentChecklist: { id: string; text: string; done: boolean }[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('# ') && !subtitle) {
                title = trimmed.slice(2).trim();
            } else if (trimmed.startsWith('> ') && !subtitle) {
                subtitle = trimmed.slice(2).trim();
            } else if (trimmed.startsWith('- [ ] ') || trimmed.startsWith('- [x] ') || trimmed.startsWith('- [X] ')) {
                const done = trimmed.startsWith('- [x] ') || trimmed.startsWith('- [X] ');
                const text = trimmed.slice(6).trim();
                currentChecklist.push({ id: `chk_${currentChecklist.length}`, text, done });
            } else if (trimmed.startsWith('## ')) {
                if (currentChecklist.length > 0) {
                    sections.push({
                        id: `sec_chk_${sections.length}`,
                        type: 'checklist',
                        checklistItems: [...currentChecklist]
                    });
                    currentChecklist = [];
                }
                sections.push({
                    id: `sec_head_${sections.length}`,
                    type: 'heading',
                    level: 2,
                    content: trimmed.slice(3).trim()
                });
            }
        }

        if (currentChecklist.length > 0) {
            sections.push({
                id: `sec_chk_${sections.length}`,
                type: 'checklist',
                checklistItems: [...currentChecklist]
            });
        }

        return {
            title,
            subtitle,
            sections: sections.length > 0 ? sections : [{ id: 'sec_0', type: 'paragraph', content }]
        };
    }

    private synthesizeDefaultSpec(): MarkdownDocumentData {
        return {
            title: `${this.projectId} Specification`,
            subtitle: 'Canonical Project Specification and Requirements',
            sections: [
                {
                    id: 'sec_1',
                    type: 'heading',
                    level: 2,
                    content: '1. Architecture & Deliverables'
                },
                {
                    id: 'sec_2',
                    type: 'checklist',
                    checklistItems: Array.from(this.state.workflowsAndTasks.tasks.values()).map((t, idx) => ({
                        id: `chk_${idx}`,
                        text: t.title,
                        done: t.status === 'done'
                    }))
                }
            ]
        };
    }

    private synthesizeKanbanBoardFromTasks(): KanbanBoardData {
        const todoCards: KanbanCard[] = [];
        const inProgressCards: KanbanCard[] = [];
        const doneCards: KanbanCard[] = [];

        for (const task of this.state.workflowsAndTasks.tasks.values()) {
            const card: KanbanCard = {
                id: task.id,
                title: task.title,
                priority: task.priority || 'medium',
                description: task.description,
                tag: task.tag,
                completedSubtasks: task.status === 'done' ? 1 : 0,
                totalSubtasks: 1
            };

            if (task.status === 'done') {
                doneCards.push(card);
            } else if (task.status === 'in_progress') {
                inProgressCards.push(card);
            } else {
                todoCards.push(card);
            }
        }

        return {
            title: 'Sprint Board',
            columns: [
                { id: 'col-todo', title: 'To Do', color: 'amber', cards: todoCards },
                { id: 'col-progress', title: 'In Progress', color: 'blue', cards: inProgressCards },
                { id: 'col-done', title: 'Done', color: 'emerald', cards: doneCards }
            ]
        };
    }

    private synthesizeNodeGraphFromTasks(): NodeGraphData {
        const nodes: any[] = [];
        const edges: any[] = [];

        let prevNodeId: string | undefined;
        let index = 0;

        for (const task of this.state.workflowsAndTasks.tasks.values()) {
            const nodeId = `node_${task.id}`;
            nodes.push({
                id: nodeId,
                label: task.title,
                category: 'process',
                status: task.status === 'done' ? 'completed' : 'pending',
                position: { x: 100 + index * 200, y: 150 }
            });

            if (prevNodeId) {
                edges.push({
                    id: `edge_${prevNodeId}_${nodeId}`,
                    source: prevNodeId,
                    target: nodeId
                });
            }

            prevNodeId = nodeId;
            index++;
        }

        return {
            title: 'Project Workflow Graph',
            nodes,
            edges
        };
    }

    private extractCodeContracts(): void {
        for (const [filePath, file] of Object.entries(this.state.codeAndAssets.files)) {
            const exports: string[] = [];
            const imports: string[] = [];

            const exportMatches = file.content.matchAll(/export\s+(?:class|interface|type|function|const|let|enum)\s+([a-zA-Z0-9_]+)/g);
            for (const match of exportMatches) {
                exports.push(match[1]);
            }

            const importMatches = file.content.matchAll(/import\s+(?:\{[^}]+\}|\w+)\s+from\s+['"]([^'"]+)['"]/g);
            for (const match of importMatches) {
                imports.push(match[1]);
            }

            this.state.codeAndAssets.moduleContracts[filePath] = {
                exports,
                imports
            };
        }
    }

    private inferLanguage(filePath: string): string {
        const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
        switch (ext) {
            case '.ts':
            case '.tsx': return 'typescript';
            case '.js':
            case '.jsx': return 'javascript';
            case '.py': return 'python';
            case '.rs': return 'rust';
            case '.go': return 'go';
            case '.css': return 'css';
            case '.html': return 'html';
            case '.json': return 'json';
            case '.md': return 'markdown';
            default: return 'plaintext';
        }
    }
}
