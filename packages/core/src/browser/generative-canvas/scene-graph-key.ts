/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { CanvasArtifact, Scene3DData } from './canvas-types';

/** Raised when what a scene graph holds changes (g2: the Output node; g3: scene objects), so graphs drawn before redraw once. */
export const SCENE_GRAPH_VERSION = 'g3';

/** What a scene's graph is drawn from: the staged run's record time, or for other scenes what the scene contains. */
export function sceneGraphKey(scene: Pick<CanvasArtifact, 'version' | 'data'>): string {
    const d = (scene.data || {}) as Scene3DData;
    if (d.stagedBuild) return `${SCENE_GRAPH_VERSION}:run:${d.stagedBuild.runId}:${d.stagedBuild.updatedAtMs}`;
    const meshes = (d.customMeshes || []).map(m => m.id).join(',');
    const objects = (d.objects || []).map(o => o.id).join(',');
    return `${SCENE_GRAPH_VERSION}:scene:${scene.version}:${meshes}|${objects}|${d.environment?.skybox ?? ''}|${d.renderMode ?? ''}`;
}
