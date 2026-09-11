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
export class ProjectArtifactStore {
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

    async save(workspaceRoot: string, graph: ProjectArtifactGraph): Promise<void> {
        const filePath = this.resolvePath(workspaceRoot);
        await fs.ensureDir(path.dirname(filePath));
        const temporaryPath = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(temporaryPath, serializeProjectGraph(graph), 'utf8');
        await fs.rename(temporaryPath, filePath);
    }

    private resolvePath(workspaceRoot: string): string {
        const root = path.resolve(workspaceRoot || process.cwd());
        return path.join(root, '.scratchbox', GRAPH_FILE);
    }
}
