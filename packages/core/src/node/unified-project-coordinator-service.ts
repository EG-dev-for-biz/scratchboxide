/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import * as path from 'path';
import * as fs from 'fs-extra';
import { ProjectContextGraphService } from './project-context-graph-service';
import { WorkspaceConfigService } from './workspace-config-service';
import {
    CanonicalProjectState,
    CanonicalProjectSnapshot,
    ProjectAgentTransaction,
    ProjectMutationListener,
    UnifiedProjectCoordinator
} from '../browser/generative-canvas/unified-project-coordinator';
export class UnifiedProjectCoordinatorService {
    private coordinator: UnifiedProjectCoordinator;
    private workspaceRoot: string = process.cwd();

    constructor(
        private readonly contextGraphService?: ProjectContextGraphService,
        private readonly workspaceConfigService?: WorkspaceConfigService
    ) {
        this.coordinator = new UnifiedProjectCoordinator({
            projectId: 'workspace-canonical',
            workspaceRoot: this.workspaceRoot
        });
    }

    getCanonicalState(): CanonicalProjectState {
        return this.coordinator.getCanonicalState();
    }

    onProjectChanged(listener: ProjectMutationListener): () => void {
        return this.coordinator.onProjectChanged(listener);
    }

    /**
     * Hydrates in-memory canonical state from an existing state object.
     */
    hydrateState(state: CanonicalProjectState): void {
        const snapshot: CanonicalProjectSnapshot = {
            projectId: state.projectId,
            workspaceRoot: state.workspaceRoot,
            version: state.version,
            lastUpdated: state.lastUpdated,
            files: {},
            specs: {},
            scenes: {},
            kanbanBoards: {},
            nodeGraphs: {},
            tasks: {},
            dashboards: {}
        };

        for (const [p, f] of Object.entries(state.codeAndAssets.files)) {
            snapshot.files[p] = f.content;
        }
        for (const [p, s] of state.documentsAndSpecs.specs.entries()) {
            snapshot.specs[p] = s;
        }
        for (const [p, sc] of state.spatialAnd3DWorlds.scenes.entries()) {
            snapshot.scenes[p] = sc;
        }
        for (const [p, kb] of state.workflowsAndTasks.kanbanBoards.entries()) {
            snapshot.kanbanBoards[p] = kb;
        }
        for (const [p, ng] of state.workflowsAndTasks.nodeGraphs.entries()) {
            snapshot.nodeGraphs[p] = ng;
        }
        for (const [p, t] of state.workflowsAndTasks.tasks.entries()) {
            snapshot.tasks[p] = t;
        }
        for (const [p, d] of state.metricsAndDashboards.dashboards.entries()) {
            snapshot.dashboards[p] = d;
        }

        this.coordinator.importSnapshot(snapshot);

        // Ingest into context graph service if available
        if (this.contextGraphService) {
            for (const [p, f] of Object.entries(state.codeAndAssets.files)) {
                this.contextGraphService.indexSourceFile(p, f.content, f.language);
            }
            for (const spec of state.documentsAndSpecs.specs.values()) {
                this.contextGraphService.ingestDocumentSpec(spec);
            }
            for (const board of state.workflowsAndTasks.kanbanBoards.values()) {
                this.contextGraphService.ingestKanbanBoard(board);
            }
            for (const graph of state.workflowsAndTasks.nodeGraphs.values()) {
                this.contextGraphService.ingestNodeGraph(graph);
            }
        }
    }

    /**
     * Scans and hydrates canonical project state directly from a workspace root on disk.
     */
    async hydrateWorkspace(workspaceRoot: string): Promise<CanonicalProjectState> {
        this.workspaceRoot = workspaceRoot;
        const files: Record<string, string> = {};

        const walk = async (dir: string): Promise<void> => {
            if (!(await fs.pathExists(dir))) return;
            const entries = await fs.readdir(dir);

            for (const entry of entries) {
                if (['node_modules', '.git', 'dist', 'lib', 'build', '.cache'].includes(entry)) {
                    continue;
                }
                const fullPath = path.join(dir, entry);
                const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
                const stat = await fs.stat(fullPath);

                if (stat.isDirectory()) {
                    await walk(fullPath);
                } else if (stat.isFile()) {
                    try {
                        const content = await fs.readFile(fullPath, 'utf8');
                        files[relPath] = content;
                    } catch {
                        // Skip binary or unreadable files
                    }
                }
            }
        };

        await walk(workspaceRoot);

        this.coordinator = new UnifiedProjectCoordinator({
            projectId: path.basename(workspaceRoot) || 'workspace-project',
            workspaceRoot
        });

        this.coordinator.hydrateFromDisk(files);

        // Index in context graph service
        if (this.contextGraphService) {
            await this.contextGraphService.indexWorkspaceDirectory(workspaceRoot);
            for (const spec of this.coordinator.getCanonicalState().documentsAndSpecs.specs.values()) {
                this.contextGraphService.ingestDocumentSpec(spec);
            }
            for (const board of this.coordinator.getCanonicalState().workflowsAndTasks.kanbanBoards.values()) {
                this.contextGraphService.ingestKanbanBoard(board);
            }
        }

        return this.coordinator.getCanonicalState();
    }

    /**
     * Commits a transactional agent mutation to the canonical project state
     * and persists modified files atomically to disk.
     */
    async commitTransaction(
        workspaceRoot: string,
        transaction: ProjectAgentTransaction
    ): Promise<{ success: boolean; writtenFiles: string[]; error?: string }> {
        const mutationResult = this.coordinator.executeAgentTransaction(transaction);
        if (!mutationResult.success) {
            return {
                success: false,
                writtenFiles: [],
                error: mutationResult.error
            };
        }

        const filesToWrite: Record<string, string> = {};
        for (const mut of transaction.mutations) {
            if ((mut.target === 'code' || mut.target === 'raw-file') && mut.filePath && mut.content !== undefined) {
                filesToWrite[mut.filePath] = mut.content;
            }
        }

        if (Object.keys(filesToWrite).length > 0 && this.workspaceConfigService) {
            return this.workspaceConfigService.writeLensFiles(workspaceRoot, filesToWrite);
        }

        return {
            success: true,
            writtenFiles: Object.keys(filesToWrite)
        };
    }

    /**
     * Indexes single file into project state and context graph.
     */
    indexFile(filePath: string, content: string, language?: string): void {
        this.coordinator.mutateFromDisk(filePath, content);
        if (this.contextGraphService) {
            this.contextGraphService.indexSourceFile(filePath, content, language);
        }
    }

    /**
     * Queries the underlying semantic and topological project context graph.
     */
    queryProjectContext(query: string): any {
        if (this.contextGraphService) {
            return this.contextGraphService.getContextSlice(undefined, { query });
        }
        return undefined;
    }

    /**
     * Gets a summary of the contextual symbol graph.
     */
    getContextGraphSummary(): { nodeCount: number; edgeCount: number; symbolCount: number } {
        if (this.contextGraphService) {
            const graph = this.contextGraphService.getGraph();
            return {
                nodeCount: graph.nodes.length,
                edgeCount: graph.edges.length,
                symbolCount: this.contextGraphService.getAllSymbols().length
            };
        }
        return { nodeCount: 0, edgeCount: 0, symbolCount: 0 };
    }
}
