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

/** Raised on window when the project could not be loaded from or saved to the server (detail: { projectId, message }). */
export const PROJECT_SAVE_FAILED_EVENT = 'scratchbox:project-save-failed';

export class ProjectArtifactStoreClient {
    private static readonly LOCAL_PREFIX = 'scratchbox_project_artifacts:';
    /**
     * Per project loaded from the server this session: the revisions the server holds. A save sends only the others (the
     * server merges them in), so its size is the change, not the history; a project the server never gave this window is
     * never saved there (a graph made up after a failed load would otherwise replace the saved one).
     */
    private readonly held = new Map<string, Set<string>>();
    private lastFailure = { message: '', atMs: 0 };

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
                const graph = await response.json() as ProjectArtifactGraph;
                this.held.set(projectId, new Set(Object.keys(graph.revisions ?? {})));
                return graph;
            }
            this.failed(projectId, `the project could not be loaded (the server answered ${response.status}); changes are not saved until the page reloads`);
        } catch (error) {
            this.failed(projectId, `the project could not be loaded (${(error as Error)?.message ?? error}); changes are not saved until the page reloads`);
        }
        return this.loadLocal(projectId) || createEmptyProjectGraph(projectId);
    }

    async save(graph: ProjectArtifactGraph, workspaceRoot?: string): Promise<'backend' | 'localStorage'> {
        const projectId = graph.project.id;
        const held = this.held.get(projectId);
        if (!held) {
            this.failed(projectId, 'the project was not loaded from the server, so it is not saved there; reload to save');
            return this.saveLocal(graph);
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const fresh = Object.keys(graph.revisions).filter(id => !held.has(id));
            const part: ProjectArtifactGraph = { ...graph, revisions: Object.fromEntries(fresh.map(id => [id, graph.revisions[id]])) };
            let response: Response;
            try {
                response = await fetch('/workspace/project-artifacts/merge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ workspaceRoot, graph: stripEmbeddedGlb(part) })
                });
            } catch (error) {
                this.failed(projectId, `the project could not be saved: the server is unreachable (${(error as Error)?.message ?? error})`);
                return this.saveLocal(graph);
            }
            if (response.ok) {
                fresh.forEach(id => held.add(id));
                this.removeLocal(projectId);
                return 'backend';
            }
            if (response.status !== 409) {
                this.failed(projectId, response.status === 413
                    ? 'the project could not be saved: this change is larger than the server accepts'
                    : `the project could not be saved (the server answered ${response.status})`);
                return this.saveLocal(graph);
            }
            // the server lacks revisions the heads name: sent again on the next attempt
            const { missingRevisions = [] } = await response.json().catch(() => ({})) as { missingRevisions?: string[] };
            missingRevisions.forEach(id => held.delete(id));
        }
        this.failed(projectId, 'the project could not be saved: it points at revisions neither the server nor this window has');
        return this.saveLocal(graph);
    }

    /** The browser's own copy, a last resort: it holds a few MB, so a large project may not fit (never thrown). */
    private saveLocal(graph: ProjectArtifactGraph): 'localStorage' {
        try {
            localStorage.setItem(this.localKey(graph.project.id), serializeProjectGraph(stripEmbeddedGlb(graph)));
        } catch (error) {
            console.warn('Project graph not kept in local storage either', error);
        }
        return 'localStorage';
    }

    /** A save or load that did not reach the server: logged, and raised for the studio to show (one message at most every 30 s). */
    private failed(projectId: string, message: string): void {
        console.error(`[project-artifacts] ${projectId}: ${message}`);
        const now = Date.now();
        if (message === this.lastFailure.message && now - this.lastFailure.atMs < 30_000) return;
        this.lastFailure = { message, atMs: now };
        if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') window.dispatchEvent(new CustomEvent(PROJECT_SAVE_FAILED_EVENT, { detail: { projectId, message } }));
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
