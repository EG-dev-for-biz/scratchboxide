/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import {
    ProjectArtifactGraph,
    createEmptyProjectGraph,
    parseProjectGraph,
    serializeProjectGraph
} from '../common/project-artifact-graph-protocol';

const GRAPH_FILE = 'project-artifacts.json';

let tempCounter = 0;

export class ProjectArtifactStore {
    /** Pending write per graph file; saves to the same file are chained so renames never race. */
    private readonly writeQueues = new Map<string, Promise<void>>();

    async load(workspaceRoot: string, projectId: string): Promise<ProjectArtifactGraph | undefined> {
        const filePath = this.resolvePath(workspaceRoot);
        if (!await fs.pathExists(filePath)) {
            return undefined;
        }
        const graph = parseProjectGraph(await fs.readFile(filePath, 'utf8'));
        if (graph.project.id !== projectId) {
            throw new Error(`Stored graph belongs to ${graph.project.id}, not ${projectId}`);
        }
        return graph;
    }

    async loadOrCreate(workspaceRoot: string, projectId: string): Promise<ProjectArtifactGraph> {
        return (await this.load(workspaceRoot, projectId)) || createEmptyProjectGraph(projectId);
    }

    /**
     * Atomically replaces the graph file. Concurrent saves to the same workspace
     * are serialised in call order (last caller wins) and each write uses a unique
     * temp file, so two writers can never clobber each other's temp or rename.
     */
    save(workspaceRoot: string, graph: ProjectArtifactGraph): Promise<void> {
        const filePath = this.resolvePath(workspaceRoot);
        const serialized = serializeProjectGraph(graph);
        const previous = this.writeQueues.get(filePath) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined) // a failed predecessor must not poison the queue
            .then(() => this.writeAtomic(filePath, serialized));
        this.writeQueues.set(filePath, next);
        next.finally(() => {
            if (this.writeQueues.get(filePath) === next) {
                this.writeQueues.delete(filePath);
            }
        }).catch(() => undefined);
        return next;
    }

    private async writeAtomic(filePath: string, content: string): Promise<void> {
        await fs.ensureDir(path.dirname(filePath));
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`;
        try {
            await fs.writeFile(temporaryPath, content, 'utf8');
            await fs.rename(temporaryPath, filePath);
        } catch (err) {
            await fs.remove(temporaryPath).catch(() => undefined);
            throw err;
        }
    }

    private resolvePath(workspaceRoot: string): string {
        const root = path.resolve(workspaceRoot || process.cwd());
        return path.join(root, '.scratchbox', GRAPH_FILE);
    }
}
