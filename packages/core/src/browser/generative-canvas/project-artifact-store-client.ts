/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { stripEmbeddedGlb } from '../../common/strip-embedded-glb';
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
                body: JSON.stringify({ workspaceRoot, graph: stripEmbeddedGlb(graph) })
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
        localStorage.setItem(this.localKey(graph.project.id), serializeProjectGraph(stripEmbeddedGlb(graph)));
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
