/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What changed between two saves of a project graph, as the project change log records it: artifacts created,
 * revised, archived or restored, links made or removed, the selection moved. Payloads are never part of a change
 * (the revision's content hash stands for them); the log stays small however large the artifacts are.
 */

import type { ArtifactActor, ArtifactEdgeType, ArtifactRef, ProjectArtifactGraph } from './project-artifact-graph-protocol';

export type ProjectChangeKind =
    | 'artifact.created'
    | 'artifact.revised'
    | 'artifact.archived'
    | 'artifact.restored'
    | 'artifact.linked'
    | 'artifact.unlinked'
    | 'artifact.selected';

export interface ProjectChange {
    kind: ProjectChangeKind;
    artifactId?: string;
    /** The artifact's kind ('3d-scene', 'document', ...) and title at the time. */
    artifactKind?: string;
    title?: string;
    revision?: {
        id: string;
        number: number;
        contentHash: string;
        commandId: string;
        author: ArtifactActor;
        /** The revision this one undoes, when it is an undo. */
        compensatesRevisionId?: string;
    };
    edge?: { id: string; type: ArtifactEdgeType; source: ArtifactRef; target: ArtifactRef };
    /** The graph's own timestamp for the change (ISO), when it has one. */
    at?: string;
}

export function diffProjectGraphs(prev: ProjectArtifactGraph | undefined, next: ProjectArtifactGraph): ProjectChange[] {
    const changes: ProjectChange[] = [];
    const prevArtifacts = prev?.artifacts ?? {};
    const prevRevisions = prev?.revisions ?? {};
    const prevEdges = prev?.edges ?? {};

    for (const node of Object.values(next.artifacts ?? {})) {
        const before = prevArtifacts[node.id];
        if (!before) {
            const head = next.heads?.[node.id] ? next.revisions?.[next.heads[node.id]] : undefined;
            changes.push({
                kind: 'artifact.created', artifactId: node.id, artifactKind: node.kind, title: node.title, at: node.createdAt,
                ...(head ? { revision: revisionSummary(head) } : {})
            });
        } else if (before.lifecycle !== node.lifecycle) {
            changes.push({ kind: node.lifecycle === 'archived' ? 'artifact.archived' : 'artifact.restored', artifactId: node.id, artifactKind: node.kind, title: node.title });
        }
    }
    const created = new Set(changes.filter(c => c.kind === 'artifact.created').map(c => c.artifactId));
    const revised = Object.values(next.revisions ?? {})
        .filter(r => !prevRevisions[r.id] && !(created.has(r.artifactId) && r.revision <= 1))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.revision - b.revision);
    for (const r of revised) {
        const node = next.artifacts?.[r.artifactId];
        changes.push({ kind: 'artifact.revised', artifactId: r.artifactId, artifactKind: node?.kind, title: r.title, revision: revisionSummary(r), at: r.createdAt });
    }
    for (const edge of Object.values(next.edges ?? {})) {
        const before = prevEdges[edge.id];
        const summary = { id: edge.id, type: edge.type, source: edge.source, target: edge.target };
        if (!before) {
            if (edge.lifecycle === 'active') changes.push({ kind: 'artifact.linked', artifactId: edge.source.artifactId, edge: summary, at: edge.createdAt });
        } else if (before.lifecycle === 'active' && edge.lifecycle === 'archived') {
            changes.push({ kind: 'artifact.unlinked', artifactId: edge.source.artifactId, edge: summary });
        }
    }
    const prevSelected = prev?.selection?.artifactId;
    const selected = next.selection?.artifactId;
    if (selected && selected !== prevSelected) {
        const node = next.artifacts?.[selected];
        changes.push({ kind: 'artifact.selected', artifactId: selected, artifactKind: node?.kind, title: node?.title });
    }
    return changes;
}

function revisionSummary(r: ProjectArtifactGraph['revisions'][string]): NonNullable<ProjectChange['revision']> {
    return {
        id: r.id, number: r.revision, contentHash: r.contentHash, commandId: r.commandId, author: r.author,
        ...(r.compensatesRevisionId ? { compensatesRevisionId: r.compensatesRevisionId } : {})
    };
}
