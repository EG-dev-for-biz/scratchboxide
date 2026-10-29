/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The display flag of a scene's node graph: which node's result the viewport shows. A stage shows its own layers, a
 * scene mesh node that mesh, a part of the compiled model that part; the Output node shows the final scene (no flag).
 * The flag lives in the scene's data (Scene3DData.displayFlag), so the graph, the scene record and the viewport agree
 * and it survives a reload. Nodes that made nothing the viewport can show (the camera, the build node) take no flag.
 */

import type { CanvasArtifact, GraphNode, Scene3DData, SceneDisplayFlag } from './canvas-types';
import { stageLayerIds } from '../../common/staged-build-graph';

/** The flag a node would set in its scene, or undefined when it made nothing the viewport can show on its own. */
export function displayFlagFor(node: GraphNode, scene: Scene3DData | undefined): SceneDisplayFlag | undefined {
    if (!scene || node.parameters?.output) return undefined;
    const p = node.parameters || {};
    // a build step that changed the model: its snapshot alone (a step without one shows its stage's layers, below)
    const snap = p.snapshot as { url?: unknown; frameOf?: unknown } | undefined;
    if (snap && typeof snap.url === 'string' && Array.isArray(snap.frameOf) && scene.stagedBuild) {
        return { nodeId: node.id, label: node.label, objectIds: [], snapshot: { url: snap.url, frameOf: snap.frameOf.filter((id): id is string => typeof id === 'string') } };
    }
    if (typeof p.stage === 'string' && scene.stagedBuild) {
        const loaded = new Set((scene.objects || []).map(o => o.id));
        const objectIds = stageLayerIds(scene.stagedBuild, p.stage).filter(id => loaded.has(id));
        return objectIds.length ? { nodeId: node.id, label: node.label, objectIds } : undefined;
    }
    if (node.id.startsWith('obj-')) {
        const objectId = node.id.slice('obj-'.length);
        return (scene.objects || []).some(o => o.id === objectId) ? { nodeId: node.id, label: node.label, objectIds: [objectId] } : undefined;
    }
    if (node.id.startsWith('mesh-')) {
        const meshId = node.id.slice('mesh-'.length);
        return (scene.customMeshes || []).some(m => m.id === meshId) ? { nodeId: node.id, label: node.label, meshIds: [meshId] } : undefined;
    }
    if (typeof p.glbNodeIndex === 'number' && node.label) return { nodeId: node.id, label: node.label, partNames: [node.label] };
    return undefined;
}

/** The scene with the flag on `flag`'s node, or cleared (the final scene) when `flag` is undefined. */
export function withDisplayFlag(scene: CanvasArtifact, flag: SceneDisplayFlag | undefined): CanvasArtifact {
    const { displayFlag: _, ...rest } = (scene.data || {}) as Scene3DData;
    return { ...scene, data: flag ? { ...rest, displayFlag: flag } : rest };
}

/** The scene with a build step switched on or off for its next run (Scene3DData.stagedStepToggles). */
export function withStepToggle(scene: CanvasArtifact, key: string, on: boolean): CanvasArtifact {
    const data = (scene.data || {}) as Scene3DData;
    return { ...scene, data: { ...data, stagedStepToggles: { ...(data.stagedStepToggles ?? {}), [key]: on } } };
}
