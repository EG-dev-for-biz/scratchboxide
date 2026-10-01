/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    ArtifactActor,
    ArtifactRef,
    ProjectArtifactGraph,
    ProjectArtifactGraphEngine,
    hashValue,
    stableProjectArtifactId
} from '../../common/project-artifact-graph-protocol';
import { CanvasArtifact, PrimitiveType } from './canvas-types';

export function resolveCanvasArtifactId(projectId: string, artifact: CanvasArtifact): string {
    if (artifact.id && !/-\d{10,}$/.test(artifact.id)) {
        return artifact.id;
    }
    return stableProjectArtifactId(artifact.type, `${projectId}:${artifact.title}:${JSON.stringify(artifact.data)}`);
}

export function registerCanvasArtifact(
    engine: ProjectArtifactGraphEngine,
    artifact: CanvasArtifact,
    actor: ArtifactActor,
    correlationId: string,
    lineage?: ArtifactRef
): CanvasArtifact {
    const graph = engine.graph;
    const artifactId = resolveCanvasArtifactId(graph.project.id, artifact);
    const existing = graph.artifacts[artifactId];
    const idempotencyBase = `${artifactId}:${artifact.version}:${hashCanvasArtifact(artifact)}`;
    let ref: ArtifactRef;

    if (!existing) {
        ref = engine.dispatch({
            type: 'artifact.create',
            commandId: `canvas-create-${idempotencyBase}`,
            correlationId,
            idempotencyKey: `canvas:create:${idempotencyBase}`,
            projectId: graph.project.id,
            actor,
            capability: 'artifact.write',
            artifact: {
                id: artifactId,
                kind: artifact.type,
                title: artifact.title,
                payload: artifact.data,
                legacy: { canvasArtifactId: artifact.id }
            }
        }).artifactRef;
    } else {
        const current = engine.selectors.activeRevision(artifactId);
        if (current && current.contentHash === hashCanvasArtifact(artifact)) {
            ref = { projectId: graph.project.id, artifactId, revisionId: current.id };
        } else {
            ref = engine.dispatch({
                type: 'artifact.update',
                commandId: `canvas-update-${idempotencyBase}`,
                correlationId,
                idempotencyKey: `canvas:update:${idempotencyBase}`,
                projectId: graph.project.id,
                actor,
                capability: 'artifact.write',
                artifactId,
                expectedRevision: graph.heads[artifactId],
                title: artifact.title,
                payload: artifact.data
            }).artifactRef;
        }
    }

    if (lineage) {
        engine.dispatch({
            type: 'artifact.link',
            commandId: `canvas-lineage-${lineage.artifactId}-${artifactId}`,
            correlationId,
            idempotencyKey: `canvas:lineage:${lineage.artifactId}:${artifactId}`,
            projectId: graph.project.id,
            actor,
            capability: 'artifact.link',
            edge: {
                type: 'derives-from',
                source: ref,
                target: lineage
            }
        });
    }

    return {
        ...artifact,
        id: artifactId,
        graphRef: ref
    };
}

export function projectGraphArtifactToCanvas(graph: ProjectArtifactGraph, ref: ArtifactRef): CanvasArtifact | undefined {
    const node = graph.artifacts[ref.artifactId];
    const revision = graph.revisions[ref.revisionId || graph.heads[ref.artifactId]];
    if (!node || !revision) {
        return undefined;
    }
    return {
        id: node.id,
        type: node.kind as PrimitiveType,
        title: revision.title,
        summary: '',
        data: revision.payload as CanvasArtifact['data'],
        createdAt: revision.createdAt,
        version: revision.revision,
        graphRef: {
            projectId: graph.project.id,
            artifactId: node.id,
            revisionId: revision.id
        }
    };
}

function hashCanvasArtifact(artifact: CanvasArtifact): string {
    return hashValue({ title: artifact.title, payload: artifact.data, blobs: undefined });
}
