/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    ProjectArtifactGraph,
    createEmptyProjectGraph,
    parseProjectGraph,
    serializeProjectGraph
} from '../../common/project-artifact-graph-protocol';

export class ProjectArtifactStoreClient {
    private static readonly LOCAL_PREFIX = 'scratchbox_project_artifacts:';

    async load(projectId: string, workspaceRoot?: string): Promise<ProjectArtifactGraph> {
        try {
            const query = new URLSearchParams({ projectId });
            if (workspaceRoot) {
                query.set('root', workspaceRoot);
            }
            const response = await fetch(`/workspace/project-artifacts?${query.toString()}`, {
                headers: { Accept: 'application/json' }
            });
            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            console.warn('Project graph backend unavailable; using local fallback', error);
        }
        return this.loadLocal(projectId) || createEmptyProjectGraph(projectId);
    }

    async save(graph: ProjectArtifactGraph, workspaceRoot?: string): Promise<'backend' | 'localStorage'> {
        try {
            const response = await fetch('/workspace/project-artifacts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({ workspaceRoot, graph })
            });
            if (response.ok) {
                this.removeLocal(graph.project.id);
                return 'backend';
            }
        } catch (error) {
            console.warn('Project graph backend unavailable; persisting local fallback', error);
        }
        if (typeof localStorage === 'undefined') {
            throw new Error('Project graph persistence unavailable');
        }
        localStorage.setItem(this.localKey(graph.project.id), serializeProjectGraph(graph));
        return 'localStorage';
    }

    private loadLocal(projectId: string): ProjectArtifactGraph | undefined {
        if (typeof localStorage === 'undefined') {
            return undefined;
        }
        const serialized = localStorage.getItem(this.localKey(projectId));
        return serialized ? parseProjectGraph(serialized) : undefined;
    }

    private removeLocal(projectId: string): void {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(this.localKey(projectId));
        }
    }

    private localKey(projectId: string): string {
        return `${ProjectArtifactStoreClient.LOCAL_PREFIX}${projectId}`;
    }
}
